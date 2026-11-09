import fs from "node:fs";
import { DECISIONS_FILE } from "./paths.js";
import type { Classification } from "./classifier.js";

export type Verdict = "higher" | "about_right" | "lower";

export interface Decision {
  id: string;
  at: string; // ISO timestamp
  /** Batch this decision belongs to (the batch's start time). */
  batchId?: string;
  /** Name-and-age fingerprint of the card, used to notice when the card changes. */
  fingerprint: string;
  mode: "review" | "auto";
  /** Auto mode: what was done. Review mode: the model's recommendation; your swipe is in userSwipe. */
  action: "like" | "superswipe" | "pass" | "recommend_like" | "recommend_pass" | "skipped";
  threshold: number;
  /** SuperSwipe threshold in force at the time, when SuperSwipes were enabled. */
  superSwipeThreshold?: number;
  /** Which criterion triggered a like: "veg", "intellectual", or "both". */
  likedFor?: "veg" | "intellectual" | "both";
  /** Flagged by you as a reference example of the intellectual criterion; fed into the prompt. */
  exemplar?: "intellectual" | null;
  name: string | null;
  age: number | null;
  /** Photo crops (or the screens when no photo could be cropped), relative URLs under /photos/. */
  photos: string[];
  /** Screenshots of the whole profile as it scrolled by, relative URLs under /photos/. */
  screens?: string[];
  classification: Classification | null;
  error?: string;
  usage?: { input: number; output: number; cacheRead: number };
  /** Text-and-first-screen score from the first stage, when a second full-screen stage followed. */
  bioOnlyProbability?: number;
  /** Decided on the first-stage score alone, without sending the other screens. */
  quickPass?: boolean;
  /** Which model and effort level made the call. */
  model?: string;
  effort?: string;
  /** Profile text read from the accessibility tree so the dashboard can show the bio. */
  profileText?: string;
  /** Distance shown on the profile, in miles (km converted). */
  distanceMiles?: number;
  /** Review mode: what you did: swiped from the dashboard, or by hand on the phone panel. */
  userSwipe?: "like" | "pass" | "phone" | null;
  /** Your grade of the model's probability: should it have been higher, lower, or was it about right? */
  verdict?: Verdict | null;
  /** Your own probability estimate for this profile, if you gave one. */
  userProbability?: number | null;
  /** Your free-text note about this call. Fed back to the model as a calibration example. */
  note?: string | null;
}

let cache: { key: string; list: Decision[] } | null = null;

/** Every decision in file order (oldest first). Re-parsed only when the file changes. */
function readAll(): Decision[] {
  if (!fs.existsSync(DECISIONS_FILE)) return [];
  const st = fs.statSync(DECISIONS_FILE);
  const key = `${st.mtimeMs}:${st.size}`;
  if (cache && cache.key === key) return cache.list;
  const list: Decision[] = [];
  for (const line of fs.readFileSync(DECISIONS_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      list.push(JSON.parse(line));
    } catch {
      /* skip corrupt line */
    }
  }
  cache = { key, list };
  return list;
}

export function appendDecision(d: Decision): void {
  fs.appendFileSync(DECISIONS_FILE, JSON.stringify(d) + "\n");
}

/** Newest first. */
export function readDecisions(limit = 200): Decision[] {
  return readAll().slice(-limit).reverse();
}

export function getDecision(id: string): Decision | null {
  return readAll().find((d) => d.id === id) ?? null;
}

export function updateDecision(id: string, patch: Partial<Decision>): Decision | null {
  if (!fs.existsSync(DECISIONS_FILE)) return null;
  const lines = fs.readFileSync(DECISIONS_FILE, "utf8").split("\n");
  let updated: Decision | null = null;
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      const d = JSON.parse(line) as Decision;
      if (d.id !== id) return line;
      updated = { ...d, ...patch };
      return JSON.stringify(updated);
    } catch {
      return line;
    }
  });
  if (updated) fs.writeFileSync(DECISIONS_FILE, out.join("\n"));
  return updated;
}

export function setVerdict(id: string, verdict: Verdict | null, userProbability?: number | null): Decision | null {
  const patch: Partial<Decision> = { verdict };
  if (userProbability !== undefined) patch.userProbability = userProbability;
  return updateDecision(id, patch);
}

/** Graded or annotated decisions, newest first, for feeding back into the prompt. */
export function feedbackExamples(limit = 40): Decision[] {
  return readDecisions(100_000)
    .filter((d) => d.classification && (d.verdict || (d.note && d.note.trim()) || typeof d.userProbability === "number"))
    .slice(0, limit);
}

/** Profiles you flagged as reference examples, newest first. */
export function exemplarProfiles(limit = 5): Decision[] {
  return readDecisions(100_000).filter((d) => d.exemplar === "intellectual" && d.profileText).slice(0, limit);
}

export function stats(): {
  seen: number;
  liked: number;
  superSwiped: number;
  passed: number;
  recommendedLike: number;
  higher: number;
  lower: number;
  aboutRight: number;
  /** Mean of (your estimate - model's probability) where you gave an estimate; positive = model too low. */
  meanBias: number | null;
  biasCount: number;
  /** Mean of (gut check − arithmetic posterior) across scored profiles; positive = gut runs higher. */
  meanGutGap: number | null;
  gutGapCount: number;
} {
  const all = readAll();
  const withEstimate = all.filter((d) => typeof d.userProbability === "number" && d.classification);
  const meanBias = withEstimate.length
    ? withEstimate.reduce((acc, d) => acc + (d.userProbability! - d.classification!.probability), 0) / withEstimate.length
    : null;
  const withArith = all.filter((d) => d.classification && typeof d.classification.arithmetic_probability === "number");
  const meanGutGap = withArith.length
    ? withArith.reduce((acc, d) => acc + (d.classification!.probability - d.classification!.arithmetic_probability!), 0) / withArith.length
    : null;
  // A like is a like in auto mode, or your like in review mode.
  const liked = (d: Decision) => d.action === "like" || d.action === "superswipe" || d.userSwipe === "like";
  const passed = (d: Decision) => d.action === "pass" || d.userSwipe === "pass";
  return {
    seen: all.length,
    liked: all.filter(liked).length,
    superSwiped: all.filter((d) => d.action === "superswipe").length,
    passed: all.filter(passed).length,
    recommendedLike: all.filter((d) => d.action === "recommend_like").length,
    higher: all.filter((d) => d.verdict === "higher").length,
    lower: all.filter((d) => d.verdict === "lower").length,
    aboutRight: all.filter((d) => d.verdict === "about_right").length,
    meanBias,
    biasCount: withEstimate.length,
    meanGutGap,
    gutGapCount: withArith.length,
  };
}
