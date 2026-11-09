/**
 * Drives the Bumble Android app through ADB. Reads each profile from the accessibility
 * tree plus screenshots while scrolling, and likes/passes with the on-screen buttons
 * (or, when they can't be found, the swipe gesture: on Bumble a horizontal swipe IS a vote).
 *
 * Safety: every tap and swipe the driver makes is gated on Bumble being the foreground
 * app and the screen not being one of the off-limits ones (your own profile, settings,
 * Premium / Boost / coins purchase sheets). Off-limits screens are only ever left with the
 * Back key. Popup dismissal matches an explicit allowlist of "decline" labels, never generic ones.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { area, center, type AdbClient, type UiNode } from "./android.js";
import { ERRORS_DIR, PHOTOS_DIR } from "./paths.js";
import type { Settings } from "./config.js";

export const BUMBLE_PACKAGE = "com.bumble.app";

/**
 * Everything used to recognise Bumble's screens. The labels were written without the real app in
 * front of me, so they are deliberately broad; use "Inspect screen" on the dashboard once Bumble is
 * logged in and extend whatever is missing.
 */
export const SELECTORS = {
  like: { label: /^(like|yes|heart|love|swipe right|like (this )?(profile|person))$/i, id: /(^|[_.:/-])(like|vote_yes|yes|heart)([_.-]|$)/i },
  pass: { label: /^(pass|no|nope|dislike|skip|swipe left|x|not interested)$/i, id: /(^|[_.:/-])(pass|dislike|vote_no|no|skip)([_.-]|$)/i },
  /** SuperSwipe: Bumble's super like (a star). Tapping it may open a purchase or "Compliment" sheet. */
  superSwipe: { label: /^(super ?swipe|send (a )?super ?swipe|compliment|send (a )?compliment|star)$/i, id: /(^|[_.:/-])(super_?swipe|compliment|star)([_.-]|$)/i },
  readMore: /^(read|see|show) more$/i,
  /** Bottom navigation entry for the swipe screen. Matched as a prefix: the label may read "People, tab, 1 of 4". */
  nav: /^(people|encounters|discover|date|home|swipe)\b/i,
  /** Checked against short UI strings only (see uiJoined): bios say things like "a match made in heaven". */
  match: [/it.?s a match/i, /you.?ve (got a )?match/i, /you matched with/i, /new match/i, /^boom!?$/im, /make the first move/i, /her move/i],
  outOfLikes: [/out of (likes|swipes|votes)/i, /reached your (daily )?(limit|max)/i, /no (more )?(likes|swipes) left/i, /come back (tomorrow|later|in \d)/i, /likes? (will )?(reset|refresh|renew)/i, /more likes (in|tomorrow)/i, /unlimited (likes|swipes)/i],
  noMoreProfiles: [/no (more|new) (people|profiles|humans|members)/i, /you.?ve seen everyone/i, /that.?s everyone/i, /come back later for more/i, /widen your (search|filters)/i, /expand your (search|filters|distance)/i, /nobody new/i, /no one new/i, /all caught up/i],
  loggedOut: [/use cell phone number/i, /use phone number/i, /continue with (apple|google|facebook|email|phone)/i, /^(log in|sign in|sign up|create (an )?account|get started|join bumble)$/im, /welcome to bumble/i, /enter your (phone|email|number)/i, /verification code/i, /log in with/i, /log back in/i],
  /** Screens the driver must never tap on. Left with Back only. */
  offLimits: [/edit profile/i, /^settings$/im, /account settings/i, /manage (membership|subscription)/i, /payment method/i, /^subscribe$/im, /google play/i, /\bbuy\b/i, /1-tap buy/i, /delete account/i, /pause (my )?(profile|account)/i, /snooze/i, /log out/i, /change (email|phone|password)/i, /\bcoins?\b/i, /get (premium|boost)/i, /bumble (premium|boost|plus)/i],
  /** Upsell overlays: only here may an X labelled "Close" be tapped. */
  upsell: [/premium/i, /\bboost\b/i, /upgrade/i, /\bunlock\b/i, /free trial/i, /see who (liked|likes) you/i, /beeline/i, /spotlight/i, /super ?swipes?/i, /compliments?/i, /travel mode/i, /incognito/i, /rematch/i, /extend/i, /backtrack/i],
  /** Only labels that unambiguously decline something. "Skip" is excluded: it may be the pass button. */
  dismiss: /^(not now|maybe later|no,? thanks|no thanks|keep (swiping|exploring|browsing|looking)|continue (swiping|exploring|browsing)|back to (swiping|browsing|people|encounters)|i.ll pass|dismiss|remind me later|not interested|got it)$/i,
  /** App chrome to strip out of the profile text sent to the model. */
  chrome: /^(people|encounters|likes you|beeline|chats|messages|profile|me|like|pass|skip|dislike|super ?swipe|compliment|report|block|hide|share|unmatch|\d+|more|read more|see more|show more|tab|\d+ of \d+|[a-z ]+, tab, \d+ of \d+|photo \d+( of \d+)?|photo carousel|verified|verified profile|photo verified|active (today|yesterday|recently)|recently active|online now|new here|block or report|hide and report|opening moves?)$/i,
};

export interface ScrapedProfile {
  fingerprint: string;
  name: string | null;
  age: number | null;
  text: string;
  /** Full-resolution JPEG screenshots of the profile, top to bottom. */
  screens: Buffer[];
  /** JPEG crops of the large images found on those screens (the profile photos), deduplicated. */
  photos: Buffer[];
}

export type DeckState =
  | "no-device"
  | "not-installed"
  | "off-app"
  | "off-limits"
  | "logged-out"
  | "match"
  | "out-of-likes"
  | "no-more-profiles"
  | "encounters"
  | "unknown";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const chance = (p: number) => Math.random() < p;
/** Right-skewed dwell time: mostly short glances, occasionally a long look. */
const dwell = (base: number) => Math.round(base * Math.exp(rand(-0.6, 0.9)));

/** 64-bit average hash of an image, for near-duplicate detection of photo crops. */
async function ahash(img: Buffer): Promise<bigint> {
  const raw = await sharp(img).resize(8, 8, { fit: "fill" }).grayscale().raw().toBuffer();
  let sum = 0;
  for (const v of raw) sum += v;
  const mean = sum / raw.length;
  let bits = 0n;
  for (let i = 0; i < raw.length; i++) bits = (bits << 1n) | (raw[i] > mean ? 1n : 0n);
  return bits;
}
function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

export async function jpegForModel(img: Buffer): Promise<Buffer> {
  return sharp(img).resize({ width: 640, withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
}

export class BumbleDriver {
  private installedAt = 0;
  private installed = false;
  /** Called with true while the driver is working the phone, so the live stream backs off. */
  onBusy: (busy: boolean) => void = () => {};

  constructor(public client: AdbClient, private log: (m: string) => void) {}

  get size(): { w: number; h: number } {
    return this.client.size ?? { w: 1080, h: 2400 };
  }

  // ---------- reading the screen ----------

  appNodes(nodes: UiNode[]): UiNode[] {
    return nodes.filter((n) => n.pkg === BUMBLE_PACKAGE);
  }

  /** Visible strings (text + content descriptions) from Bumble's own nodes, in reading order. */
  texts(nodes: UiNode[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const n of this.appNodes(nodes)) {
      for (const s of [n.text, n.desc]) {
        if (s && !seen.has(s)) {
          seen.add(s);
          out.push(s);
        }
      }
    }
    return out;
  }

  /**
   * Screen text for state checks (match screen, upsell, off-limits, logged out): short strings only,
   * so a bio or prompt answer ("log out of your comfort zone") never trips them.
   */
  private uiJoined(strings: string[]): string {
    return strings.filter((s) => s.length < 90).join("\n");
  }

  /** Name and age from the card header: "Ada, 29", "Ada 29", or "Ada" followed by "29". */
  header(nodes: UiNode[]): { name: string; age: number } | null {
    const strings = this.texts(nodes).filter((s) => !SELECTORS.chrome.test(s));
    for (const s of strings) {
      const m = /^([^\d\n]{1,40}?)[,\s·]+(\d{2})(?:\b|$)/.exec(s);
      if (m && +m[2] >= 18 && +m[2] <= 99) return { name: m[1].trim(), age: +m[2] };
    }
    for (let i = 1; i < strings.length; i++) {
      if (/^\d{2}$/.test(strings[i]) && +strings[i] >= 18 && +strings[i] <= 99 && /^[^\d]{1,40}$/.test(strings[i - 1]) && !SELECTORS.nav.test(strings[i - 1])) {
        return { name: strings[i - 1].trim(), age: +strings[i] };
      }
    }
    return null;
  }

  findVoteButton(nodes: UiNode[], kind: "like" | "pass" | "superSwipe"): UiNode | null {
    const { w, h } = this.size;
    const spec = SELECTORS[kind];
    // The vote buttons sit in the lower part of the screen and are small; never match the card itself.
    const cands = this.appNodes(nodes).filter((n) => n.bounds && area(n) > 0 && center(n).y > h * 0.5 && n.bounds.x2 - n.bounds.x1 < w * 0.5);
    for (const n of cands) {
      const label = n.desc || n.text;
      if (label && spec.label.test(label)) return n;
    }
    for (const n of cands) if (n.id && spec.id.test(n.id)) return n;
    return null;
  }

  /** A settings / account / payment screen. Never true while the vote buttons are on screen. */
  private offLimits(nodes: UiNode[]): boolean {
    if (this.findVoteButton(nodes, "like") || this.findVoteButton(nodes, "pass")) return false;
    const joined = this.uiJoined(this.texts(nodes));
    return SELECTORS.offLimits.some((re) => re.test(joined));
  }

  private async foreground(): Promise<boolean> {
    return (await this.client.foregroundPackage()) === BUMBLE_PACKAGE;
  }

  /** Every tap the driver makes goes through here: Bumble must be in front and the point on screen. */
  private async safeTap(x: number, y: number, why: string): Promise<boolean> {
    const { w, h } = this.size;
    if (x < 0 || y < 0 || x > w || y > h) return false;
    if (!(await this.foreground())) {
      this.log(`Not tapping (${why}): Bumble is not the app in front.`);
      return false;
    }
    await this.client.tap(x, y);
    return true;
  }

  private async safeSwipe(x1: number, y1: number, x2: number, y2: number, ms: number, why: string): Promise<boolean> {
    if (!(await this.foreground())) {
      this.log(`Not swiping (${why}): Bumble is not the app in front.`);
      return false;
    }
    await this.client.swipe(x1, y1, x2, y2, ms);
    return true;
  }

  private tapNode(n: UiNode, why: string): Promise<boolean> {
    const b = n.bounds!;
    // Somewhere inside the control, not dead centre every time.
    return this.safeTap(b.x1 + (b.x2 - b.x1) * rand(0.3, 0.7), b.y1 + (b.y2 - b.y1) * rand(0.3, 0.7), why);
  }

  async isInstalled(): Promise<boolean> {
    const now = Date.now();
    if (this.installedAt && now - this.installedAt < 30_000) return this.installed;
    this.installed = await this.client.isInstalled(BUMBLE_PACKAGE);
    this.installedAt = now;
    return this.installed;
  }
  forgetInstalled(): void {
    this.installedAt = 0;
  }

  /** One read of the screen: what state the app is in, plus the nodes for reuse. */
  async observe(): Promise<{ state: DeckState; nodes: UiNode[]; strings: string[] }> {
    if (!(await this.client.ensureDevice())) return { state: "no-device", nodes: [], strings: [] };
    if (!(await this.isInstalled())) return { state: "not-installed", nodes: [], strings: [] };
    const fg = await this.client.foregroundPackage();
    if (fg && fg !== BUMBLE_PACKAGE) return { state: "off-app", nodes: [], strings: [] };
    const nodes = await this.client.dump();
    const strings = this.texts(nodes);
    const joined = this.uiJoined(strings);
    const test = (res: RegExp[]) => res.some((re) => re.test(joined));
    const like = this.findVoteButton(nodes, "like");
    const pass = this.findVoteButton(nodes, "pass");
    let state: DeckState = "unknown";
    if (this.offLimits(nodes)) state = "off-limits";
    else if (test(SELECTORS.match) && !like) state = "match";
    else if (test(SELECTORS.outOfLikes) && !like) state = "out-of-likes";
    else if (test(SELECTORS.noMoreProfiles) && !like && !pass) state = "no-more-profiles";
    else if (!like && !pass && !this.header(nodes) && test(SELECTORS.loggedOut)) state = "logged-out";
    else if (like || pass || this.header(nodes)) state = "encounters";
    return { state, nodes, strings };
  }

  async state(): Promise<DeckState> {
    return (await this.observe()).state;
  }

  /** Fingerprint of the card from its name and age, or the top text when no header is visible. */
  fingerprintOf(name: string | null, age: number | null, topText: string): string {
    const key = name ? `${name}|${age ?? ""}` : topText.slice(0, 300);
    return crypto.createHash("sha1").update(key).digest("hex").slice(0, 12);
  }
  /** Fingerprint of the card on screen now, or null when no header is visible (scrolled down, or no card). */
  async currentFingerprint(): Promise<string | null> {
    const nodes = await this.client.dump().catch(() => null);
    if (!nodes) return null;
    const hdr = this.header(nodes);
    if (!hdr) return null;
    return this.fingerprintOf(hdr.name, hdr.age, "");
  }

  // ---------- navigation ----------

  /** Bring Bumble to the front and onto the swipe screen. Off-limits screens are backed out of, never tapped. */
  async goToEncounters(): Promise<boolean> {
    if (!(await this.client.ensureDevice())) return false;
    if (!(await this.isInstalled())) return false;
    if ((await this.client.foregroundPackage()) !== BUMBLE_PACKAGE) {
      this.log("Opening Bumble…");
      await this.client.launchApp(BUMBLE_PACKAGE);
      await sleep(3500);
    }
    const { h } = this.size;
    for (let round = 0; round < 4; round++) {
      const nodes = await this.client.dump().catch(() => []);
      if (this.offLimits(nodes)) {
        this.log("Bumble is on a settings/profile screen; pressing Back.");
        await this.client.key("BACK");
        await sleep(1200);
        continue;
      }
      // Already on a card: tapping the tab again would only reset the deck.
      if (this.findVoteButton(nodes, "like") || this.findVoteButton(nodes, "pass")) return true;
      const nav = this.appNodes(nodes).find((n) => n.bounds && area(n) > 0 && center(n).y > h * 0.86 && SELECTORS.nav.test(n.desc || n.text));
      if (nav && !nav.selected) {
        await this.tapNode(nav, "People tab");
        await sleep(1500);
      }
      return true;
    }
    return false;
  }

  async waitForLogin(timeoutMs: number, shouldStop: () => boolean): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (shouldStop()) return false;
      const { state } = await this.observe();
      if (state === "encounters" || state === "match" || state === "out-of-likes" || state === "no-more-profiles") return true;
      if (state === "off-app" || state === "unknown") {
        // Might be on a Bumble screen after login that isn't the deck yet; try navigating.
        if (state === "off-app") await sleep(3000);
        else await this.goToEncounters();
      }
      await sleep(3000);
    }
    return false;
  }

  /** Close a bottom sheet without acting: its Cancel / Close button if there is one, else Back. */
  private async cancelSheet(nodes: UiNode[]): Promise<void> {
    const cancel = this.appNodes(nodes).find((n) => n.bounds && area(n) > 0 && n.clickable && (/^(cancel|close|not now)$/i.test(n.desc || n.text) || /close|cancel|dismiss/i.test(n.id)));
    if (cancel && (await this.tapNode(cancel, "cancel sheet"))) {
      await sleep(800);
      return;
    }
    await this.client.key("BACK");
    await sleep(800);
  }

  /** Close a match overlay or an upsell. Returns what was done, or null if nothing matched the allowlist. */
  async dismissPopups(): Promise<string | null> {
    const nodes = await this.client.dump().catch(() => []);
    if (this.offLimits(nodes)) {
      this.log("Bumble is on a settings/profile screen; pressing Back.");
      await this.client.key("BACK");
      return "back";
    }
    const joined = this.uiJoined(this.texts(nodes));
    const overlay = SELECTORS.upsell.some((re) => re.test(joined)) || SELECTORS.match.some((re) => re.test(joined));
    for (const n of this.appNodes(nodes)) {
      if (!n.bounds || area(n) === 0) continue;
      const label = (n.text || n.desc).replace(/\s+/g, " ").trim();
      if (SELECTORS.dismiss.test(label)) {
        if (await this.tapNode(n, `dismiss "${label}"`)) return label;
      }
    }
    if (overlay) {
      const close = this.appNodes(nodes).find((n) => n.bounds && area(n) > 0 && (/^close$/i.test(n.desc || n.text) || /close/i.test(n.id)));
      if (close && (await this.tapNode(close, "close overlay"))) return "close";
      // A match screen with no decline button: Back leaves it without sending anything.
      if (SELECTORS.match.some((re) => re.test(joined))) {
        await this.client.key("BACK");
        return "back";
      }
    }
    return null;
  }

  // ---------- reading a profile ----------

  private scrollDown(humanize: boolean): Promise<boolean> {
    const { w, h } = this.size;
    const x = w * rand(0.4, 0.6);
    return this.safeSwipe(x, h * rand(0.7, 0.8), x + rand(-40, 40), h * rand(0.25, 0.38), humanize ? rand(300, 560) : 350, "scroll down");
  }
  private scrollUp(amount: "bit" | "screen" = "screen"): Promise<boolean> {
    const { w, h } = this.size;
    const x = w * rand(0.4, 0.6);
    const from = amount === "bit" ? h * rand(0.4, 0.5) : h * rand(0.25, 0.35);
    const to = amount === "bit" ? from + h * rand(0.12, 0.2) : h * rand(0.78, 0.88);
    return this.safeSwipe(x, from, x + rand(-40, 40), to, rand(260, 480), "scroll up");
  }

  /** Scroll back to the top of the card: until the screen stops changing. */
  async scrollToTop(maxScrolls = 16): Promise<void> {
    let last = "";
    for (let i = 0; i < maxScrolls; i++) {
      const nodes = await this.client.dump().catch(() => []);
      const sig = this.texts(nodes).join("|");
      if (sig === last) return;
      last = sig;
      if (!(await this.scrollUp())) return;
      await sleep(dwell(350));
    }
  }

  /** The large on-screen images: the profile photos. */
  private photoNodes(nodes: UiNode[]): UiNode[] {
    const { w, h } = this.size;
    return this.appNodes(nodes).filter(
      (n) => n.bounds && /ImageView|Image\b/.test(n.cls) && n.bounds.x2 - n.bounds.x1 >= w * 0.5 && n.bounds.y2 - n.bounds.y1 >= h * 0.18 && n.bounds.y1 >= 0 && n.bounds.y2 <= h,
    );
  }

  /** Crop the large images on this screenshot (the profile photos). */
  private async cropPhotos(png: Buffer, nodes: UiNode[], photos: Buffer[], hashes: bigint[]): Promise<void> {
    for (const n of this.photoNodes(nodes)) {
      if (photos.length >= 12) return;
      const b = n.bounds!;
      try {
        const crop = await sharp(png).extract({ left: b.x1, top: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1 }).jpeg({ quality: 88 }).toBuffer();
        const hsh = await ahash(crop);
        if (hashes.some((x) => hamming(x, hsh) <= 5)) continue;
        hashes.push(hsh);
        photos.push(crop);
      } catch {
        /* bounds slightly off; skip */
      }
    }
  }

  /**
   * Read the profile on screen: scroll through it collecting text and screenshots, like
   * a person reading it. Leaves the card wherever the scroll ended.
   */
  async readProfile(settings: Settings): Promise<ScrapedProfile | null> {
    const humanize = settings.humanize;
    this.onBusy(true);
    try {
      let nodes = await this.client.dump();
      const hdr = this.header(nodes);
      const strings: string[] = [];
      const seen = new Set<string>();
      const add = (list: string[]) => {
        for (const s of list) if (!seen.has(s)) { seen.add(s); strings.push(s); }
      };
      add(this.texts(nodes));
      if (!hdr && !strings.length) return null;
      const topText = strings.join("\n");

      const screens: Buffer[] = [];
      const photos: Buffer[] = [];
      const hashes: bigint[] = [];
      const capture = async (current: UiNode[]) => {
        const png = await this.client.screenshotPng();
        screens.push(await sharp(png).jpeg({ quality: 86 }).toBuffer());
        await this.cropPhotos(png, current, photos, hashes);
      };
      await capture(nodes);
      if (humanize) await sleep(dwell(1100)); // look at the first photo
      let lastSig = this.texts(nodes).join("|");
      const { h } = this.size;
      let readMoreTapped = 0;
      for (let i = 0; i < settings.maxProfileScrolls; i++) {
        // "Read more" on a truncated bio, if it's inside the card.
        const more = this.appNodes(nodes).find((n) => n.bounds && area(n) > 0 && center(n).y < h * 0.86 && SELECTORS.readMore.test(n.text || n.desc));
        if (more && readMoreTapped < 3 && (await this.tapNode(more, "read more"))) {
          readMoreTapped++;
          await sleep(dwell(500));
          nodes = await this.client.dump();
          add(this.texts(nodes));
          await capture(nodes);
        }
        if (!(await this.scrollDown(humanize))) return null;
        await sleep(humanize ? dwell(650) : 450);
        nodes = await this.client.dump();
        const sig = this.texts(nodes).join("|");
        if (sig === lastSig) break; // reached the end
        lastSig = sig;
        add(this.texts(nodes));
        await capture(nodes);
        if (humanize && i >= 1 && chance(0.12)) {
          // Double-take: glance back up, then carry on.
          await this.scrollUp("bit");
          await sleep(dwell(1200));
          await this.scrollDown(true);
          await sleep(dwell(400));
        }
        if (humanize) await sleep(dwell(500));
      }
      const name = hdr?.name ?? null;
      const age = hdr?.age ?? null;
      const text = strings.filter((s) => !SELECTORS.chrome.test(s)).join("\n").slice(0, 6000);
      return { fingerprint: this.fingerprintOf(name, age, topText), name, age, text, screens, photos };
    } finally {
      this.onBusy(false);
    }
  }

  // ---------- acting ----------

  /** The horizontal swipe that votes on Bumble: right = like, left = pass. */
  private async swipeVote(kind: "like" | "pass"): Promise<boolean> {
    const { w, h } = this.size;
    const y = h * rand(0.4, 0.55);
    return kind === "like"
      ? this.safeSwipe(w * rand(0.2, 0.3), y, w * rand(0.85, 0.95), y + rand(-40, 40), rand(160, 300), "swipe right")
      : this.safeSwipe(w * rand(0.7, 0.8), y, w * rand(0.05, 0.15), y + rand(-40, 40), rand(160, 300), "swipe left");
  }

  /**
   * Like or pass the profile on screen. Returns how it was done ("button" or "gesture") once the next
   * card is up, or null if the vote did not go through (the caller re-reads the screen; it never retries blindly).
   */
  async vote(kind: "like" | "pass", method: Settings["swipeMethod"] = "button"): Promise<"button" | "gesture" | null> {
    this.onBusy(true);
    try {
      const before = await this.client.dump();
      const hdr = this.header(before);
      const beforeFp = hdr ? this.fingerprintOf(hdr.name, hdr.age, "") : null;
      const beforeSig = this.texts(before).join("|");
      if (this.offLimits(before)) {
        this.log("Refusing to vote: Bumble is on a settings/profile screen.");
        await this.client.key("BACK");
        return null;
      }
      let how: "button" | "gesture" | null = null;
      if (method === "button") {
        let btn = this.findVoteButton(before, kind);
        if (!btn) {
          await this.scrollToTop();
          btn = this.findVoteButton(await this.client.dump(), kind);
        }
        if (btn) {
          if (!(await this.tapNode(btn, `${kind} button "${btn.desc || btn.text || btn.id}"`))) return null;
          how = "button";
        } else {
          this.log(`No ${kind} button found (Inspect screen shows the labels; SELECTORS in src/bumble.ts); swiping the card instead.`);
        }
      }
      if (!how) {
        if (!(await this.swipeVote(kind))) return null;
        how = "gesture";
      }
      return (await this.waitForCardChange(beforeFp, beforeSig, 8000)) ? how : null;
    } finally {
      this.onBusy(false);
    }
  }

  /**
   * SuperSwipe the profile on screen. Returns "superswipe" once the next card is up, or "unavailable"
   * when there is no SuperSwipe button or tapping it opened a purchase / Compliment sheet instead of
   * voting (the sheet is cancelled; the caller then sends a like).
   */
  async superSwipe(): Promise<"superswipe" | "unavailable"> {
    this.onBusy(true);
    try {
      const before = await this.client.dump();
      if (this.offLimits(before)) {
        await this.client.key("BACK");
        return "unavailable";
      }
      const hdr = this.header(before);
      const beforeFp = hdr ? this.fingerprintOf(hdr.name, hdr.age, "") : null;
      const beforeSig = this.texts(before).join("|");
      let btn = this.findVoteButton(before, "superSwipe");
      if (!btn) {
        await this.scrollToTop();
        btn = this.findVoteButton(await this.client.dump(), "superSwipe");
      }
      if (!btn) {
        this.log("No SuperSwipe button found on screen.");
        return "unavailable";
      }
      if (!(await this.tapNode(btn, `SuperSwipe button "${btn.desc || btn.text || btn.id}"`))) return "unavailable";
      await sleep(dwell(1200));
      const nodes = await this.client.dump();
      const joined = this.uiJoined(this.texts(nodes));
      const composer = nodes.some((n) => n.pkg === BUMBLE_PACKAGE && /EditText/.test(n.cls) && n.bounds && area(n) > 0);
      if (composer || this.offLimits(nodes) || SELECTORS.upsell.some((re) => re.test(joined))) {
        this.log(composer ? "SuperSwipe opened a message composer; backing out and sending a like instead." : "SuperSwipe opened a purchase or upsell sheet; backing out and sending a like instead.");
        await this.cancelSheet(nodes);
        return "unavailable";
      }
      return (await this.waitForCardChange(beforeFp, beforeSig, 8000)) ? "superswipe" : "unavailable";
    } finally {
      this.onBusy(false);
    }
  }

  /** Poll until the screen shows a different card (header or text changed), handling match and upsell overlays on the way. */
  async waitForCardChange(prevFp: string | null, prevSig: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(700);
      const nodes = await this.client.dump().catch(() => null);
      if (!nodes) continue;
      const strings = this.texts(nodes);
      const joined = this.uiJoined(strings);
      if (SELECTORS.match.some((re) => re.test(joined)) && !this.findVoteButton(nodes, "like")) {
        this.log("It's a match! Dismissing the match screen.");
        await this.dismissPopups();
        continue;
      }
      if (SELECTORS.upsell.some((re) => re.test(joined)) && !this.findVoteButton(nodes, "like")) {
        const what = await this.dismissPopups();
        if (what) this.log(`Dismissed a popup (${what}).`);
        continue;
      }
      const hdr = this.header(nodes);
      const fp = hdr ? this.fingerprintOf(hdr.name, hdr.age, "") : null;
      if (fp && prevFp && fp !== prevFp) return true;
      // Same name and age twice in a row happens; a different first screen still means a new card.
      if (strings.join("|") !== prevSig) return true;
    }
    return false;
  }

  /**
   * After the model has decided: linger on profiles we like (people look longer at someone
   * they're about to like), flick past most passes.
   */
  async secondLook(liked: boolean, probability: number | undefined): Promise<void> {
    const nearThreshold = probability !== undefined && Math.abs(probability - 0.5) < 0.15;
    if (liked && chance(0.7)) {
      await this.scrollUp("bit");
      await sleep(dwell(1500));
      if (chance(0.5)) {
        await this.scrollUp("bit");
        await sleep(dwell(1200));
      }
    } else if (nearThreshold && chance(0.5)) {
      await this.scrollUp("bit");
      await sleep(dwell(1200));
    } else if (chance(0.15)) {
      await sleep(dwell(900));
    }
  }

  /** Before a like: scroll slowly back to the top, the way a person re-checks the photos. */
  async lingerBeforeLike(): Promise<void> {
    this.onBusy(true);
    try {
      let last = "";
      for (let i = 0; i < 16; i++) {
        const nodes = await this.client.dump().catch(() => []);
        const sig = this.texts(nodes).join("|");
        if (sig === last) break;
        last = sig;
        if (!(await this.scrollUp())) break;
        await sleep(dwell(1400));
      }
      await sleep(dwell(1000));
    } finally {
      this.onBusy(false);
    }
  }

  async restart(): Promise<void> {
    await this.client.forceStop(BUMBLE_PACKAGE);
    await sleep(1200);
    await this.goToEncounters();
  }

  // ---------- persistence & diagnostics ----------

  /** Persist images to disk for the dashboard; returns relative URLs. */
  saveImages(id: string, images: Buffer[], prefix = "", startIndex = 0): string[] {
    const dir = path.join(PHOTOS_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    return images.map((buf, k) => {
      const file = `${prefix}${startIndex + k}.jpg`;
      fs.writeFileSync(path.join(dir, file), buf);
      return `/photos/${id}/${file}`;
    });
  }

  async saveErrorScreenshot(tag: string): Promise<string | null> {
    try {
      const file = path.join(ERRORS_DIR, `${Date.now()}-${tag}.png`);
      fs.writeFileSync(file, await this.client.screenshotPng());
      return file;
    } catch {
      return null;
    }
  }

  async inspect(): Promise<unknown> {
    const devices = await this.client.listDevices();
    const dev = await this.client.ensureDevice();
    const report: Record<string, unknown> = { adbPath: this.client.adbPath, devices, device: dev, screen: this.client.size };
    if (!dev) return report;
    this.forgetInstalled();
    report.bumbleInstalled = await this.isInstalled();
    report.foregroundPackage = await this.client.foregroundPackage();
    try {
      const { state, nodes, strings } = await this.observe();
      report.state = state;
      report.header = this.header(nodes);
      report.likeButton = this.findVoteButton(nodes, "like");
      report.passButton = this.findVoteButton(nodes, "pass");
      report.superSwipeButton = this.findVoteButton(nodes, "superSwipe");
      report.texts = strings;
      report.nodes = this.appNodes(nodes)
        .filter((n) => n.text || n.desc || n.clickable || /ImageView/.test(n.cls))
        .map((n) => ({
          text: n.text,
          desc: n.desc,
          id: n.id.replace(`${BUMBLE_PACKAGE}:id/`, ""),
          cls: n.cls.split(".").pop(),
          clickable: n.clickable,
          selected: n.selected,
          depth: n.depth,
          bounds: n.bounds && `[${n.bounds.x1},${n.bounds.y1}][${n.bounds.x2},${n.bounds.y2}]`,
        }))
        .slice(0, 250);
    } catch (e) {
      report.error = (e as Error).message;
    }
    return report;
  }
}
