/**
 * End-to-end check of the model path without the phone: scores one fake profile with the
 * current Settings (model, backend, thresholds, your guidance) exactly the way a batch would,
 * and prints the result. Proves the API key or Claude login works, the shared preamble and
 * contact_eli tool are wired in, and the structured output parses.
 *
 *   npm test                               # one fake profile, current settings (one model call)
 *   npm test -- --dry-run                  # free: checks the preamble, the tool and the inbox hook
 *   npm test -- --model claude-haiku-5-5 --backend api
 *   npm test -- --contact                  # asks the model to call contact_eli: a test message
 *                                          # lands in Eli's LLM inbox (llm-inbox list)
 *
 * Nothing is written to data/decisions.jsonl; the running dashboard is not touched.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { classifyProfile, decide, buildSystem } from "./classifier.js";
import { loadSettings, type Settings } from "./config.js";
import { ContactedEliError, backendLabel, structuredCall } from "./llm.js";
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

async function main(): Promise<void> {
  const base = loadSettings();
  const settings: Settings = {
    ...base,
    ...(arg("model") ? { model: arg("model") as Settings["model"] } : {}),
    ...(arg("backend") ? { backend: arg("backend") as Settings["backend"] } : {}),
  };
  if (process.argv.includes("--dry-run")) {
    dryRun(settings);
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
