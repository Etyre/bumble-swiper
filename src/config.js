import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PATHS = {
  root: ROOT,
  data: path.join(ROOT, 'data'),
  config: path.join(ROOT, 'config.json'),
  chromeProfile: path.join(ROOT, 'data', 'chrome-profile'),
  decisions: path.join(ROOT, 'data', 'decisions.jsonl'),
  stats: path.join(ROOT, 'data', 'stats.json'),
};

export const DEFAULT_CONFIG = {
  // Words/phrases that make a profile a "like". Matched case-insensitively on word boundaries;
  // hyphens and spaces are treated the same, so "plant-based" also matches "plant based".
  terms: ['vegan', 'vegetarian', 'plant-based'],
  // If any of these phrases appear, the profile is treated as NOT matching (e.g. "not vegan").
  excludePhrases: ['not vegan', 'non-vegan', 'not vegetarian', 'non-vegetarian'],
  // "pills"   = only look at the profile's badges / interest chips
  // "anywhere" = badges + bio + prompts (all text on the card)
  matchIn: 'anywhere',
  // What to do when a profile does not match: "pass" swipes left, "wait" leaves it for you.
  onNoMatch: 'pass',
  // Dry run: show the decision on the dashboard but never swipe. Recommended for first run.
  dryRun: true,
  // Random human-like delay before each swipe.
  delayMs: { min: 2500, max: 7000 },
  // Scroll through the whole profile before deciding. Needed to see badges/bio below the first screen.
  readProfileScroll: true,
  dailyLikeCap: 100,
  dailySwipeCap: 400,
  outOfSwipesPauseMinutes: 60,
  // "click" uses the on-screen buttons, "keyboard" uses Bumble's arrow-key shortcuts.
  swipeMethod: 'click',
  port: 3777,
  // Leave empty to use the first connected device / emulator; otherwise an `adb devices` serial such as emulator-5554.
  deviceSerial: '',
  // Leave empty to auto-detect adb (PATH, ~/Library/Android/sdk/platform-tools, Homebrew).
  adbPath: '',
  // How many screens to scroll through per profile while reading it.
  maxProfileScrolls: 10,
  // Emulator management: boot the AVD (created by `npm run emulator`) headless when no device is connected.
  autoStartEmulator: true,
  avdName: 'bumble',
  emulatorHeadless: true,
  stopEmulatorOnExit: true,
};

export function loadConfig() {
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(PATHS.config, 'utf8'));
  } catch {
    // no config yet, defaults are used and written on first save
  }
  return normalize({ ...DEFAULT_CONFIG, ...fileCfg, delayMs: { ...DEFAULT_CONFIG.delayMs, ...(fileCfg.delayMs || {}) } });
}

export function saveConfig(cfg) {
  const normalized = normalize(cfg);
  fs.writeFileSync(PATHS.config, JSON.stringify(normalized, null, 2) + '\n');
  return normalized;
}

function normalize(cfg) {
  const out = { ...cfg };
  out.terms = asList(cfg.terms);
  out.excludePhrases = asList(cfg.excludePhrases);
  out.matchIn = cfg.matchIn === 'pills' ? 'pills' : 'anywhere';
  out.onNoMatch = cfg.onNoMatch === 'wait' ? 'wait' : 'pass';
  out.dryRun = Boolean(cfg.dryRun);
  out.readProfileScroll = cfg.readProfileScroll !== false;
  out.swipeMethod = cfg.swipeMethod === 'keyboard' ? 'keyboard' : 'click';
  out.dailyLikeCap = clampInt(cfg.dailyLikeCap, 1, 10000, DEFAULT_CONFIG.dailyLikeCap);
  out.dailySwipeCap = clampInt(cfg.dailySwipeCap, 1, 10000, DEFAULT_CONFIG.dailySwipeCap);
  out.outOfSwipesPauseMinutes = clampInt(cfg.outOfSwipesPauseMinutes, 1, 24 * 60, DEFAULT_CONFIG.outOfSwipesPauseMinutes);
  out.port = clampInt(cfg.port, 1024, 65535, DEFAULT_CONFIG.port);
  out.deviceSerial = String(cfg.deviceSerial || '').trim();
  out.adbPath = String(cfg.adbPath || '').trim();
  out.maxProfileScrolls = clampInt(cfg.maxProfileScrolls, 1, 40, DEFAULT_CONFIG.maxProfileScrolls);
  out.autoStartEmulator = cfg.autoStartEmulator !== false;
  out.avdName = String(cfg.avdName || DEFAULT_CONFIG.avdName).trim() || DEFAULT_CONFIG.avdName;
  out.emulatorHeadless = cfg.emulatorHeadless !== false;
  out.stopEmulatorOnExit = cfg.stopEmulatorOnExit !== false;
  const min = clampInt(cfg.delayMs?.min, 500, 120000, DEFAULT_CONFIG.delayMs.min);
  const max = clampInt(cfg.delayMs?.max, min, 120000, Math.max(min, DEFAULT_CONFIG.delayMs.max));
  out.delayMs = { min, max };
  return out;
}

function asList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

function clampInt(v, lo, hi, dflt) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}
