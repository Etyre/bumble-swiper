/**
 * End-to-end check of the model path without the phone: scores one fake profile with the
 * current Settings (model, backend, thresholds, your guidance) exactly the way a batch would,
 * and prints the result. Proves the API key or Claude login works, the shared preamble and
 * contact_eli tool are wired in, and the structured output parses.
 *
 *   npm test                               # one fake profile, current settings (one model call)
 *   npm test -- --dry-run                  # free: checks the preamble, the tool and the inbox hook, and
 *                                          # runs the confirm step on stubbed replies (temp inbox)
 *   npm test -- --model claude-haiku-5-5 --backend api
 *   npm test -- --contact                  # asks the model to call contact_eli: a test message
 *                                          # lands in Eli's LLM inbox (llm-inbox list)
 *
 * Nothing is written to data/decisions.jsonl; the running dashboard is not touched.
 */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { classifyProfile, decide, buildSystem } from "./classifier.js";
import { loadSettings, type Settings } from "./config.js";
import { ContactedEliError, backendLabel, confirmThenCheck, structuredCall } from "./llm.js";
import { ROOT } from "./paths.js";

const FAKE_PROFILE = `Maya, 31
Berkeley · 3 miles away
About me
Vegan for ten years, mostly for the animals. Weekend hikes, weeknight pottery, always up for a gig. Looking for someone kind who reads. 🌱
Interests
Hiking
Pottery
Live music
Vegan
My basics
5'6"
Active
Liberal
Looking for
A long-term relationship`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** The wiring the shared LLM standard requires, checked without a model call. */
function dryRun(settings: Settings): void {
  const shared = path.resolve(ROOT, "..", "shared");
  const preamble = fs.readFileSync(path.join(shared, "llm-system-prompt-preamble.md"), "utf8").trim();
  const tool = JSON.parse(fs.readFileSync(path.join(shared, "contact_eli_tool.json"), "utf8")) as { name: string };
  if (tool.name !== "contact_eli") throw new Error(`contact_eli_tool.json defines "${tool.name}", not contact_eli`);
  const system = buildSystem(settings);
  if (!system[0].includes("CRITERION:")) throw new Error("the classifier prompt is missing its criterion");
  console.log(`OK: preamble (${preamble.length} chars) read from shared/, contact_eli tool loaded, classifier prompt built (${system.length} block${system.length === 1 ? "" : "s"}).`);
  // The inbox hook: a response with no contact must exit 0; one with the tool call must exit 3.
  const run = (response: unknown) =>
    spawnSync("python3", ["-I", path.join(shared, "llm_contact.py"), "check"], {
      input: JSON.stringify({ app: "bumble-swiper", model: settings.model, system: `${preamble}\n\n${system.join("\n\n")}`, messages: [{ role: "user", content: "wiring test" }], response, tools: [tool] }),
      encoding: "utf8",
    });
  const quiet = run({ role: "assistant", content: [{ type: "text", text: "{\"ok\": true}" }] });
  if (quiet.status !== 0) throw new Error(`llm_contact.py check exited ${quiet.status} on a plain response: ${quiet.stderr.trim().slice(0, 300)}`);
  console.log("OK: llm_contact.py check runs and accepts a plain response (exit 0).");
  console.log(`Backend would be ${backendLabel(settings)} with ${settings.model} (${settings.effort}).`);
}

/**
 * The confirm step on stubbed model replies: no API call. LLM_INBOX_DIR points llm_contact.py at a
 * throwaway inbox for the duration, so records land there and Eli is not notified.
 */
async function confirmStepOffline(): Promise<void> {
  const inbox = fs.mkdtempSync(path.join(os.tmpdir(), "bumble-swiper-inbox-"));
  const before = process.env.LLM_INBOX_DIR;
  process.env.LLM_INBOX_DIR = inbox;
  const lines = (f: string): { message?: string }[] => {
    const file = path.join(inbox, f);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  };
  const fail = (m: string): never => { throw new Error(`confirm step: ${m}`); };
  try {
    const tools = [JSON.parse(fs.readFileSync(path.join(path.resolve(ROOT, "..", "shared"), "contact_eli_tool.json"), "utf8"))];
    const messages = [{ role: "user" as const, content: "PROFILE TEXT: stub" }];
    const plain = { role: "assistant", content: [{ type: "text", text: '{"probability":0.1}' }] };
    const called = { role: "assistant", content: [{ type: "tool_use", id: "toolu_test1", name: "contact_eli", input: { message: "This profile has no bio." } }] };
    const choose = (meant: string) => ({ role: "assistant", content: [{ type: "tool_use", id: "toolu_test2", name: "contact_eli_decision", input: { meant } }] });
    let decides = 0, agains = 0;
    /** Returns the response the app would use, or "sent" when the call stopped with ContactedEliError. */
    const run = (response: unknown, decide: () => unknown) =>
      confirmThenCheck<unknown>(
        { model: "stub-model", system: "stub system", messages, response, tools },
        async (m, d) => {
          decides++;
          if (m.length !== 3 || m[2].role !== "user") fail("the question call did not get messages + ask");
          if (d.tool_choice.type !== "tool" || d.tool_choice.name !== "contact_eli_decision" || d.tools.length !== 2 || !d.max_tokens) fail("the question call did not get the forced decision tool");
          return decide();
        },
        async (m) => {
          agains++;
          if (m.length !== 3 || !JSON.stringify(m[2]).includes("tool_result")) fail("the follow-up call did not get messages + keep");
          return plain;
        },
      ).catch((e) => (e instanceof ContactedEliError ? "sent" : Promise.reject(e)));

    if ((await run(plain, () => fail("asked about a response with no tool call"))) !== plain || decides || agains || lines("messages.jsonl").length) fail("a response with no tool call was not left alone");
    console.log("OK: confirm step, no tool call: untouched.");

    if ((await run(called, () => choose("task_remark_keep_working"))) !== plain || decides !== 1 || agains !== 1) fail("keep working did not continue with the follow-up answer");
    if (lines("messages.jsonl").length) fail("keep working still sent the message");
    if (lines("unconfirmed.jsonl").length !== 1 || lines("unconfirmed.jsonl")[0].message !== "This profile has no bio.") fail("the unconfirmed message was not kept");
    console.log("OK: confirm step, keep working: follow-up answer used, first message kept in unconfirmed.jsonl.");

    if ((await run(called, () => choose("send_to_eli_and_stop"))) !== "sent" || agains !== 1 || lines("messages.jsonl").length !== 1 || lines("messages.jsonl")[0].message !== "This profile has no bio.") fail("send did not record the original message");
    console.log("OK: confirm step, send: recorded by check.");

    if ((await run(called, () => { throw new Error("stubbed API failure"); })) !== "sent" || agains !== 1 || lines("messages.jsonl").length !== 2) fail("a failing question call lost the message");
    if ((await run(called, () => ({ content: [{ type: "text", text: "not a choice" }] }))) !== "sent" || lines("messages.jsonl").length !== 3) fail("an unclear answer lost the message");
    console.log("OK: confirm step, question call throwing or unclear: original sent.");

    decides = 0;
    if ((await run({ role: "assistant", content: [{ type: "text", text: "@ELI: I would like to stop." }] }, () => fail("asked about an @ELI: line"))) !== "sent" || decides || lines("messages.jsonl").length !== 4 || lines("unconfirmed.jsonl").length !== 1) fail("an @ELI: line was not sent straight away");
    console.log(`OK: confirm step, @ELI: line: sent without a question (test inbox ${inbox}).`);
  } finally {
    if (before === undefined) delete process.env.LLM_INBOX_DIR;
    else process.env.LLM_INBOX_DIR = before;
  }
}

async function main(): Promise<void> {
  const base = loadSettings();
  const settings: Settings = {
    ...base,
    ...(arg("model") ? { model: arg("model") as Settings["model"] } : {}),
    ...(arg("backend") ? { backend: arg("backend") as Settings["backend"] } : {}),
  };
  if (process.argv.includes("--dry-run")) {
    dryRun(settings);
    await confirmStepOffline();
    return;
  }
  console.log(`Backend: ${backendLabel(settings)} · model ${settings.model} (${settings.effort})`);

  if (process.argv.includes("--contact")) {
    console.log("Asking the model to call contact_eli with a test message…");
    try {
      const r = await structuredCall(
        {
          model: settings.model,
          effort: "low",
          maxTokens: 500,
          system: ["This is a wiring test of the contact_eli tool run by Eli himself. Call the contact_eli tool once with the message 'Test message from bumble-swiper npm test --contact'. Do not return anything else."],
          content: [{ type: "text", text: "Please run the wiring test now." }],
          schema: z.object({ ok: z.boolean() }),
        },
        settings,
      );
      console.log("The model did NOT contact Eli; it returned:", JSON.stringify(r.parsed));
      process.exitCode = 1;
    } catch (e) {
      if (e instanceof ContactedEliError) {
        console.log("OK: contact recorded and Eli notified. Record:\n" + e.record);
        return;
      }
      throw e;
    }
    return;
  }

  const started = Date.now();
  const r = await classifyProfile({ text: FAKE_PROFILE, screens: [] }, settings);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (r.refused) {
    console.log(`The model declined to evaluate the fake profile (${secs}s).`);
    process.exitCode = 1;
    return;
  }
  const c = r.classification;
  if (!c) throw new Error("No classification came back.");
  const d = decide(c, settings);
  console.log(`OK in ${secs}s: ${c.name ?? "?"}${c.age ? `, ${c.age}` : ""} → P=${c.probability.toFixed(2)} (arithmetic ${c.arithmetic_probability}), P(exception)=${c.intellectual_probability.toFixed(2)} → ${d.superSwipes ? "SUPERSWIPE" : d.likes ? "LIKE" : "PASS"}${d.likedFor ? ` for ${d.likedFor}` : ""}`);
  for (const e of c.evidence) console.log(`  ${e.criterion.padEnd(12)} ${e.direction.padEnd(7)} LR ${String(e.likelihood_ratio).padStart(5)}  ${e.observation}`);
  console.log(`Tokens: ${r.usage.input} in, ${r.usage.cacheRead} cached, ${r.usage.output} out.`);
  if (c.probability < 0.5) {
    console.log("Unexpected: the fake profile says 'Vegan for ten years' and should score well above 0.5.");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof ContactedEliError ? e.message : e);
  process.exitCode = 1;
});
