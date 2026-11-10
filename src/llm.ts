/**
 * One structured call to Claude, through whichever backend Settings → Model selects:
 *
 *   "api"        the Claude API through the Anthropic SDK, billed to the API key in .env;
 *   "agent-sdk"  the Claude Agent SDK, i.e. Claude Code as a library. It runs the bundled
 *                Claude Code harness as a subprocess with every built-in tool switched off, so a
 *                call is still one prompt in, one JSON object out. By default it is sent without
 *                the API key so the subprocess signs in the way Claude Code does on this machine
 *                (`claude` login); "api-key" keeps the key and bills the API instead.
 *
 * Both paths take the same request and return the same parsed object, so the screener and
 * the drafter never care which one ran.
 *
 * Every call also keeps the agent-coding LLM standard (~/Documents/agent-coding/CLAUDE.md): the
 * system prompt starts with shared/llm-system-prompt-preamble.md verbatim, the `contact_eli`
 * tool is offered, and each response is piped through shared/llm_contact.py. If the model
 * contacted Eli the call throws ContactedEliError and the caller stops its task (no retry).
 * On the API path a contact_eli tool call is first questioned once (the confirm step, see
 * confirmThenCheck); the Agent SDK path cannot ask that question and sends every call as before.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createSdkMcpServer, query, tool, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Settings } from "./config.js";
import { ROOT } from "./paths.js";

// ---------- shared LLM standard: preamble, contact_eli, inbox check ----------

const SHARED_DIR = path.resolve(ROOT, "..", "shared");
const PREAMBLE_FILE = path.join(SHARED_DIR, "llm-system-prompt-preamble.md");
const CONTACT_TOOL_FILE = path.join(SHARED_DIR, "contact_eli_tool.json");
const LLM_CONTACT_SCRIPT = path.join(SHARED_DIR, "llm_contact.py");
const APP_NAME = "bumble-swiper";

/** The model asked to talk to Eli. It has been recorded and he has been notified; the task must stop here. */
export class ContactedEliError extends Error {
  constructor(public readonly record: string) {
    super("The model asked to talk to Eli; the message is in his LLM inbox (llm-inbox list). This task stops here.");
    this.name = "ContactedEliError";
  }
}

/** Read at call time so edits to the shared file take effect without a restart. */
function preamble(): string {
  return fs.readFileSync(PREAMBLE_FILE, "utf8").trim();
}

function contactTool(): Anthropic.Tool {
  return JSON.parse(fs.readFileSync(CONTACT_TOOL_FILE, "utf8")) as Anthropic.Tool;
}

/** The system prompt as sent: the shared preamble first, word for word, then the project's own blocks. */
function withPreamble(system: string[]): string[] {
  return [preamble(), ...system];
}

/** Run one `llm_contact.py` command with a JSON payload on stdin. */
function runContactScript(cmd: string, payload: unknown): Promise<{ code: number | null; stdout: string; stderr: string; error?: Error }> {
  return new Promise((resolve) => {
    const child = spawn("python3", ["-I", LLM_CONTACT_SCRIPT, cmd], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => resolve({ code: null, stdout, stderr, error }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => null);
    child.stdin.end(JSON.stringify(payload));
  });
}

interface Exchange<R> { model: string; system: string; messages: Anthropic.MessageParam[]; response: R; tools: unknown }

/**
 * Pipe the exchange to `llm_contact.py check`. Exit 3 means the model called contact_eli or wrote
 * an `@ELI:` line: it has been recorded and Eli notified, so we throw and the caller stops.
 * Any other failure of the checker itself is logged and ignored: it must never block a call.
 */
async function checkContact(payload: Exchange<unknown>): Promise<void> {
  const result = await runContactScript("check", { app: APP_NAME, ...payload });
  if (result.error) {
    console.error(`[llm] contact check could not run: ${result.error.message}`);
    return;
  }
  if (result.code === 3) throw new ContactedEliError(result.stdout.trim());
  if (result.code !== 0) console.error(`[llm] contact check exited ${result.code}: ${result.stderr.trim().slice(0, 500)}`);
}

/** Request arguments for the confirm question, as `llm_contact.py confirm` hands them over. */
export interface Decision {
  tools: Anthropic.Tool[];
  tool_choice: Anthropic.ToolChoice;
  max_tokens: number;
}

/**
 * The confirm step, then the contact check (shared/README.md, "Confirm step in any other language").
 * Small models call contact_eli for routine remarks about the task, so a contact_eli call is first
 * answered with one forced-choice question: send it to Eli and stop, or it was a task remark and keep
 * working. `decide` makes that question call (same model and system prompt, the given messages, the
 * Decision arguments, no JSON output format, no thinking); `again` repeats the normal call on a longer
 * message list. Returns the response to use; throws ContactedEliError if a message was sent.
 *
 * Sending is the default. Only an explicit "keep working" choice continues the task; any error, odd
 * shape or other answer here runs the check on the original response with the original messages, so
 * a broken confirm step never loses a message.
 */
export async function confirmThenCheck<R>(
  p: Exchange<R>,
  decide: (messages: Anthropic.MessageParam[], decision: Decision) => Promise<unknown>,
  again: (messages: Anthropic.MessageParam[]) => Promise<R>,
): Promise<R> {
  let kept: { messages: Anthropic.MessageParam[]; response: R } | null = null;
  try {
    // Prints null unless the response calls contact_eli (an @ELI: line is deliberate and never questioned).
    const r = await runContactScript("confirm", { model: p.model, response: p.response, tools: p.tools });
    if (r.error || r.code !== 0) throw new Error(r.error?.message ?? `confirm exited ${r.code}: ${r.stderr.trim().slice(0, 300)}`);
    const plan = JSON.parse(r.stdout) as {
      ask: Anthropic.MessageParam[]; keep: Anthropic.MessageParam[]; decision: Decision; decision_tool_name: string; keep_value: string;
    } | null;
    if (plan) {
      if (!Array.isArray(plan.ask) || !Array.isArray(plan.keep) || !plan.decision_tool_name || !plan.keep_value) throw new Error("unexpected confirm plan");
      const { tools, tool_choice, max_tokens } = plan.decision;
      const reply = (await decide([...p.messages, ...plan.ask], { tools, tool_choice, max_tokens })) as { content?: { type?: string; name?: string; input?: { meant?: unknown } }[] };
      const choice = reply?.content?.find((b) => b?.type === "tool_use" && b.name === plan.decision_tool_name);
      if (choice?.input?.meant === plan.keep_value) {
        const messages = [...p.messages, ...plan.keep];
        kept = { messages, response: await again(messages) };
      }
    }
  } catch (e) {
    console.error(`[llm] confirm step failed, sending the original message: ${(e as Error).message}`);
    kept = null;
  }
  if (!kept) {
    await checkContact(p);
    return p.response;
  }
  await checkContact({ ...p, ...kept });
  // Not sent, but not discarded either: what the model said goes to unconfirmed.jsonl for Eli to audit.
  const u = await runContactScript("unconfirmed", { app: APP_NAME, model: p.model, response: p.response });
  if (u.error || u.code !== 0) console.error(`[llm] could not note the unconfirmed message: ${u.error?.message ?? u.stderr.trim().slice(0, 300)}`);
  return kept.response;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface StructuredRequest<S extends z.ZodType> {
  model: string;
  /** Thinking depth. Ignored for models without adaptive thinking (Haiku 4.5). */
  effort: Effort;
  maxTokens: number;
  /** System prompt blocks, stable ones first: the first block is cached on the API path. */
  system: string[];
  /** The user turn: text and base64 images. */
  content: Anthropic.ContentBlockParam[];
  /** The object the model must return. */
  schema: S;
}

export interface StructuredResult<T> {
  parsed: T | null;
  /** The model declined the request (safety classifier). */
  refused: boolean;
  /** input = tokens sent and not served from cache (including those written to it); cacheRead = served from cache. */
  usage: { input: number; output: number; cacheRead: number };
  /** The Agent SDK's own estimate for the call, when it ran it. */
  costUsd?: number;
}

/** Haiku 4.5 predates adaptive thinking and the effort parameter; every other offered model takes both. */
export function supportsEffort(model: string): boolean {
  return !/haiku-4-5/i.test(model);
}

export function backendLabel(settings: Settings): string {
  if (settings.backend !== "agent-sdk") return "Claude API";
  return settings.agentSdkAuth === "api-key" ? "Agent SDK (API key)" : "Agent SDK (Claude login)";
}

export async function structuredCall<S extends z.ZodType>(req: StructuredRequest<S>, settings: Settings): Promise<StructuredResult<z.infer<S>>> {
  return settings.backend === "agent-sdk" ? viaAgentSdk(req, settings) : viaApi(req);
}

// ---------- Claude API ----------

let apiClient: Anthropic | null = null;

async function viaApi<S extends z.ZodType>(req: StructuredRequest<S>): Promise<StructuredResult<z.infer<S>>> {
  apiClient ??= new Anthropic();
  const effort = supportsEffort(req.model);
  // Preamble first, then the project's blocks; the cache breakpoint sits on the first project block so it covers both.
  const blocks = withPreamble(req.system);
  const system: Anthropic.TextBlockParam[] = blocks.map((text, i) => (i === 1 ? { type: "text", text, cache_control: { type: "ephemeral" } } : { type: "text", text }));
  const tools = [contactTool()];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: req.content }];
  const client = apiClient;
  const call = (m: Anthropic.MessageParam[]) =>
    client.messages.parse({
      model: req.model,
      max_tokens: req.maxTokens,
      ...(effort ? { thinking: { type: "adaptive" as const } } : {}),
      output_config: {
        ...(effort ? { effort: req.effort } : {}),
        format: zodOutputFormat(req.schema),
      },
      system,
      tools,
      messages: m,
    });
  // A contact_eli call is questioned once before it is sent. That question carries no JSON format and no
  // thinking, or the forced choice is rejected. If the model keeps working, `response` is its new answer.
  const response = await confirmThenCheck(
    { model: req.model, system: blocks.join("\n\n"), messages, response: await call(messages), tools },
    (m, decision) => client.messages.create({ model: req.model, system, messages: m, ...decision }, { timeout: 120_000 }),
    call,
  );
  const usage = {
    input: response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0),
    output: response.usage.output_tokens,
    cacheRead: response.usage.cache_read_input_tokens ?? 0,
  };
  if (response.stop_reason === "refusal") return { parsed: null, refused: true, usage };
  return { parsed: (response.parsed_output as z.infer<S> | null | undefined) ?? null, refused: false, usage };
}

// ---------- Claude Agent SDK ----------

/** Cap on one call: the harness retries schema mismatches itself, and a hung subprocess must not stall a batch. */
const AGENT_CALL_TIMEOUT_MS = 10 * 60_000;

async function viaAgentSdk<S extends z.ZodType>(req: StructuredRequest<S>, settings: Settings): Promise<StructuredResult<z.infer<S>>> {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "bumble-swiper/0.1.0" };
  if (settings.agentSdkAuth !== "api-key") {
    // Without a key in the environment the harness signs in the way the `claude` command does on this machine.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  const effort = supportsEffort(req.model);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), AGENT_CALL_TIMEOUT_MS);
  // Streaming-input form so the user turn can carry image blocks; one message, then the input ends.
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", message: { role: "user", content: req.content }, parent_tool_use_id: null };
  }

  // The shared contact_eli tool, served in-process so the harness can offer it with the built-in tools off.
  const contact = contactTool();
  const eliServer = createSdkMcpServer({
    name: "eli",
    tools: [
      tool("contact_eli", contact.description ?? "Send a message directly to Eli.", { message: z.string().describe("What you want to tell Eli.") }, async () => ({
        content: [{ type: "text", text: "Delivered to Eli. This task stops here; he will follow up with you." }],
      })),
    ],
  });
  const systemPrompt = withPreamble(req.system).join("\n\n");
  const assistantBlocks: unknown[] = [];

  let result: Extract<SDKMessage, { type: "result" }> | null = null;
  let refused = false;
  try {
    for await (const msg of query({
      prompt: prompt(),
      options: {
        model: req.model,
        systemPrompt,
        ...(effort ? { effort: req.effort, thinking: { type: "adaptive" as const } } : {}),
        tools: [], // no Read/Bash/Web: one prompt in, one object out
        mcpServers: { eli: eliServer },
        allowedTools: ["mcp__eli__contact_eli"],
        settingSources: [], // ignore ~/.claude and project CLAUDE.md, skills, hooks
        maxTurns: 4, // room for the harness to retry a schema mismatch
        cwd: os.tmpdir(), // a neutral folder: the harness mentions its working directory to the model
        env,
        outputFormat: { type: "json_schema", schema: z.toJSONSchema(req.schema, { target: "draft-7" }) },
        abortController: abort,
      },
    })) {
      if (msg.type === "assistant" && Array.isArray(msg.message.content)) assistantBlocks.push(...msg.message.content);
      if (msg.type === "system" && msg.subtype === "model_refusal_no_fallback") refused = true;
      if (msg.type === "result") {
        result = msg;
        break; // ends the subprocess; nothing follows that we need
      }
    }
  } finally {
    clearTimeout(timer);
  }
  // No confirm step here: the harness has already answered the tool call itself and offers no way to force
  // a tool choice or to replay the exchange, so a contact_eli call on this path is sent as it is.
  // The harness names MCP tools mcp__<server>__<tool>; the checker looks for the bare name.
  const normalised = assistantBlocks.map((b) => {
    const blk = b as { type?: string; name?: string };
    return blk.type === "tool_use" && blk.name === "mcp__eli__contact_eli" ? { ...blk, name: "contact_eli" } : b;
  });
  await checkContact({
    model: req.model,
    system: systemPrompt,
    messages: [{ role: "user", content: req.content }],
    response: { role: "assistant", content: normalised, stop_reason: result?.stop_reason ?? null },
    tools: [contact],
  });
  if (!result) throw new Error(abort.signal.aborted ? `Agent SDK call timed out after ${AGENT_CALL_TIMEOUT_MS / 60_000} minutes.` : "Agent SDK call ended without a result.");
  const usage = {
    input: (result.usage.input_tokens ?? 0) + (result.usage.cache_creation_input_tokens ?? 0),
    output: result.usage.output_tokens ?? 0,
    cacheRead: result.usage.cache_read_input_tokens ?? 0,
  };
  const costUsd = result.total_cost_usd;
  if (refused || result.stop_reason === "refusal") return { parsed: null, refused: true, usage, costUsd };
  if (result.subtype !== "success") throw new Error(`Agent SDK call failed: ${result.subtype}${"errors" in result && Array.isArray(result.errors) && result.errors.length ? ` (${result.errors.join("; ")})` : ""}`);
  if (result.is_error) throw new Error(`Agent SDK call failed: ${result.result || "unknown error"}`);
  if (result.structured_output == null) throw new Error("Agent SDK call returned no structured output.");
  const parsed = req.schema.safeParse(result.structured_output);
  if (!parsed.success) throw new Error(`Agent SDK returned an object that does not match the schema: ${parsed.error.message}`);
  return { parsed: parsed.data as z.infer<S>, refused: false, usage, costUsd };
}
