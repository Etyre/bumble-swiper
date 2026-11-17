import fs from "node:fs";
import { z } from "zod";
import { SETTINGS_FILE } from "./paths.js";

/** The intellectual exception is raised when the model's probability reaches this. Fixed, not a slider. */
export const EXCEPTION_THRESHOLD = 0.6;

export const ModelSchema = z.enum(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5", "claude-sonnet-5", "claude-fable-5-2", "claude-fable-5-1", "claude-opus-4-8", "claude-haiku-4-5"]);

export const SettingsSchema = z.object({
  /** "review": classify, show the recommendation, wait for you to swipe from the dashboard.
   *  "auto": swipe on its own from the classifier's call. Set by which Start button you press. */
  mode: z.enum(["review", "auto"]).default("review"),
  /** Swipe right when P(meets criteria) >= threshold. */
  threshold: z.number().min(0).max(1).default(0.5),
  /** The intellectual exception: if the model judges a profile exceptionally intelligent, intellectual,
   *  philosophical, thoughtful and open-minded, it's a like regardless of the diet score. Binary. */
  intellectualEnabled: z.boolean().default(true),
  /** SuperSwipe (Bumble's super like) instead of a like when P >= this. Off by default: SuperSwipes are
   *  rationed or paid on Bumble, and tapping the button may open a purchase sheet (the driver backs out
   *  and sends a like when that happens). */
  superSwipeEnabled: z.boolean().default(false),
  superSwipeThreshold: z.number().min(0).max(1).default(0.9),
  /** Prior probability (0-1) that a random woman in your pool meets the criteria. Drives the Bayesian prompt. */
  prior: z.number().min(0.01).max(0.99).default(0.1),
  /** Each run is a "batch": a random session length like a person swiping for a while, then stopping. */
  batchMinMinutes: z.number().min(1).max(600).default(10),
  batchMaxMinutes: z.number().min(1).max(600).default(150),
  /** After a batch, wait a random break and start the next one automatically. */
  continuous: z.boolean().default(false),
  breakMinMinutes: z.number().min(1).max(10_000).default(90),
  breakMaxMinutes: z.number().min(1).max(10_000).default(360),
  /** Only start batches between these local hours (24h). Start 9, end 23 = 9:00-22:59. */
  activeStartHour: z.number().int().min(0).max(23).default(9),
  activeEndHour: z.number().int().min(1).max(24).default(23),
  /** Stop after this many swipes in one batch (Bumble restricts accounts that swipe like bots). */
  maxSwipesPerSession: z.number().int().min(1).max(100_000).default(100),
  /** Random human-like delay between swipes, in ms. */
  minDelayMs: z.number().int().min(500).default(2500),
  maxDelayMs: z.number().int().min(500).default(7000),
  /** Browse like a person: scroll through the profile with uneven pauses, occasionally scroll back,
   *  take a longer second look at profiles you're about to like. */
  humanize: z.boolean().default(true),
  /** Two-stage judging. First the profile text and the first screen. If that scores below this,
   *  decide on that alone without sending the other screens. Otherwise send every screen and re-score. */
  quickPassBelow: z.number().min(0).max(1).default(0.15),
  /** How many screenshots of the profile to send to the classifier (evenly spaced through the profile). */
  maxScreens: z.number().int().min(1).max(12).default(6),
  /** How many screens to scroll through per profile while reading it. */
  maxProfileScrolls: z.number().int().min(1).max(30).default(12),
  /** How to vote: tap Bumble's like/pass buttons (falling back to a swipe gesture when they can't be found),
   *  or always swipe the card. */
  swipeMethod: z.enum(["button", "gesture"]).default("button"),
  model: ModelSchema.default("claude-opus-5-5"),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  /** How calls reach Claude. "api": the Claude API with the key in .env. "agent-sdk": the Claude Agent SDK
   *  (Claude Code as a library) with all its tools off; one prompt in, one JSON object out. */
  backend: z.enum(["api", "agent-sdk"]).default("api"),
  /** Agent SDK only. "login": drop the API key so the harness uses this machine's Claude Code sign-in.
   *  "api-key": keep the key and bill the API through the harness. */
  agentSdkAuth: z.enum(["login", "api-key"]).default("login"),
  /** Ask the model for a written reasoning paragraph on each card. Slower; the evidence list is kept either way. */
  captureReasoning: z.boolean().default(false),
  /** Free-text guidance for the model, e.g. how you want borderline diets treated. Goes into every prompt. */
  userGuidance: z.string().max(4000).default(""),
  // --- device ---
  /** Android virtual device to boot when no device is connected (created by `npm run emulator`). */
  avdName: z.string().max(60).default("bumble"),
  /** Show the emulator's own window. Normally it runs hidden and you use the phone panel in the dashboard. */
  emulatorWindow: z.boolean().default(false),
  /** Shut the emulator down when this app exits. Off keeps the phone (and your Bumble login) running between restarts. */
  stopEmulatorOnExit: z.boolean().default(false),
  /** Use a specific device (an `adb devices` serial, e.g. a real phone over USB). Empty = the emulator above. */
  deviceSerial: z.string().max(80).default(""),
  /** Where the emulator says it is. Bumble shows people near the phone's GPS position. */
  city: z.enum(["berkeley", "sf", "dc", "nyc", "custom"]).default("berkeley"),
  /** Coordinates used when city is "custom". */
  latitude: z.number().min(-90).max(90).nullable().default(null),
  longitude: z.number().min(-180).max(180).nullable().default(null),
});
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * Settings from data/settings.json. If the file fails the schema (e.g. a value outside a range after
 * the schema was tightened) the bad keys are dropped and the rest kept, so one stray value never
 * resets everything; the repaired file is written back.
 */
export function loadSettings(): Settings {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    /* no file yet */
  }
  const parsed = SettingsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const bad = new Set(parsed.error.issues.map((i) => String(i.path[0])));
  const kept = Object.fromEntries(Object.entries(raw).filter(([k]) => !bad.has(k)));
  const s = SettingsSchema.parse(kept);
  console.warn(`[config] settings.json had invalid values for ${[...bad].join(", ")}; reset those to defaults.`);
  saveSettings(s);
  return s;
}

export function saveSettings(s: Settings): void {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

export function updateSettings(patch: unknown): Settings {
  const merged = { ...loadSettings(), ...(patch as object) };
  const s = SettingsSchema.parse(merged);
  if (s.minDelayMs > s.maxDelayMs) s.maxDelayMs = s.minDelayMs;
  if (s.batchMinMinutes > s.batchMaxMinutes) s.batchMaxMinutes = s.batchMinMinutes;
  if (s.breakMinMinutes > s.breakMaxMinutes) s.breakMaxMinutes = s.breakMinMinutes;
  saveSettings(s);
  return s;
}
