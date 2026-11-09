/**
 * The swipe loop. A batch is a random human-length session on Bumble's deck: for each card, read
 * the profile (scrolling through it), ask Claude for a probability in up to two stages, and then
 * either swipe on its own ("auto") or show the call in the dashboard and wait for your swipe ("review").
 * Same evaluation flow as the Tinder swiper; the phone side comes from the Feeld swiper.
 */
import { EventEmitter } from "node:events";
import { AdbClient } from "./android.js";
import { BumbleDriver, jpegForModel, type ScrapedProfile } from "./bumble.js";
import { bootEmulator, runningEmulatorFor, stopEmulator } from "./emulator.js";
import { classifyProfile, decide } from "./classifier.js";
import { backendLabel, ContactedEliError } from "./llm.js";
import { appendDecision, updateDecision, type Decision } from "./store.js";
import { loadSettings, updateSettings, type Settings } from "./config.js";
import { applyLocation } from "./location.js";

export type Status = "idle" | "booting" | "setup_needed" | "awaiting_login" | "running" | "stopping" | "stopped" | "waiting" | "error";

export interface SwiperState {
  status: Status;
  swipesThisSession: number;
  lastError: string | null;
  current: { name: string | null; fingerprint: string; doing: "reading" | "judging" | "swiping" | "waiting for you" } | null;
  /** Review mode: the decision waiting for your swipe from the dashboard. */
  awaiting: { decisionId: string } | null;
  swiping: boolean;
  /** The batch in progress: when it started, when it will end, how many profiles so far. Null in review mode. */
  batch: { id: string; startedAt: string; endsAt: string; plannedMinutes: number; evaluated: number } | null;
  /** When the next batch is scheduled to start (continuous mode). */
  nextBatchAt: string | null;
  /** Why the last batch ended. */
  lastBatchEnd: string | null;
  /** The phone we're driving. */
  device: { serial: string; model: string; size: { w: number; h: number } | null; avd: string | null } | null;
  /** What the phone is showing, as last seen by the loop. */
  deck: string | null;
}

/** "22 miles away" / "35 km away" from the profile text, in miles. */
function parseDistance(text: string): number | undefined {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(miles?|mi|km|kilomet\w+)\s+away/i);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return /k/i.test(m[2]) ? Math.round(n * 0.621371) : n;
}

/** Move a timestamp forward to the next window between start and end hour (local time). */
function pushIntoActiveHours(t: Date, startHour: number, endHour: number): Date {
  const d = new Date(t);
  const h = d.getHours() + d.getMinutes() / 60;
  if (h >= startHour && h < endHour) return d;
  if (h >= endHour) d.setDate(d.getDate() + 1);
  d.setHours(startHour, Math.floor(rand(0, 45)), 0, 0);
  return d;
}

/** Evenly spaced sample of up to n items, always keeping the first. */
function sample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.round((i * (items.length - 1)) / (n - 1))]);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class Swiper extends EventEmitter {
  state: SwiperState = {
    status: "idle",
    swipesThisSession: 0,
    lastError: null,
    current: null,
    awaiting: null,
    swiping: false,
    batch: null,
    nextBatchAt: null,
    lastBatchEnd: null,
    device: null,
    deck: null,
  };
  readonly client: AdbClient;
  readonly driver: BumbleDriver;
  private pendingChoice: { decisionId: string; direction: "like" | "pass" } | null = null;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;
  private devicePromise: Promise<boolean> | null = null;
  /** Serial of the emulator this process booted (so it can be stopped on exit if asked). */
  private bootedSerial: string | null = null;

  constructor() {
    super();
    this.client = new AdbClient();
    this.driver = new BumbleDriver(this.client, (m) => this.log(m));
  }

  log(message: string): void {
    this.emit("log", { at: new Date().toISOString(), message });
  }

  private setStatus(status: Status): void {
    this.state.status = status;
    this.emit("state", this.state);
  }

  private setDeck(deck: string | null): void {
    if (this.state.deck !== deck) {
      this.state.deck = deck;
      this.emit("state", this.state);
    }
  }

  private setCurrent(current: SwiperState["current"]): void {
    this.state.current = current;
    this.emit("state", this.state);
  }

  /**
   * Make sure a phone is connected: the configured serial, or the emulator (booting it if needed).
   * Safe to call repeatedly; concurrent callers share one attempt.
   */
  ensureDevice(): Promise<boolean> {
    if (this.devicePromise) return this.devicePromise;
    this.devicePromise = this.ensureDeviceInner().finally(() => {
      this.devicePromise = null;
    });
    return this.devicePromise;
  }

  private async ensureDeviceInner(): Promise<boolean> {
    const settings = loadSettings();
    if (!this.client.adbPath) {
      this.log("adb was not found. Install it with: brew install --cask android-platform-tools");
      return false;
    }
    let serial: string | null = null;
    if (settings.deviceSerial) {
      serial = settings.deviceSerial;
    } else {
      serial = await runningEmulatorFor(this.client, settings.avdName);
      if (!serial) {
        const prev = this.state.status;
        this.setStatus("booting");
        serial = await bootEmulator({ client: this.client, avdName: settings.avdName, window: settings.emulatorWindow, log: (m) => this.log(m) });
        if (serial) this.bootedSerial = serial;
        if (this.state.status === "booting") this.setStatus(prev === "booting" ? "idle" : prev);
      }
    }
    this.client.pin(serial);
    const dev = await this.client.ensureDevice();
    if (!dev) {
      this.state.device = null;
      this.emit("state", this.state);
      return false;
    }
    const avd = await this.client.avdNameOf(dev.serial);
    const changed = this.state.device?.serial !== dev.serial;
    this.state.device = { serial: dev.serial, model: dev.model, size: this.client.size, avd };
    if (changed) {
      this.log(`Device: ${dev.serial}${dev.model ? ` (${dev.model})` : ""}${avd ? `, AVD "${avd}"` : ""}, screen ${this.client.size?.w}x${this.client.size?.h}`);
      this.emit("state", this.state);
      await this.setLocation(settings);
    }
    return true;
  }

  /** Points the emulator's GPS at the city in Settings. */
  async setLocation(settings: Settings = loadSettings()): Promise<void> {
    try {
      const msg = await applyLocation(this.client, settings);
      if (msg) this.log(msg);
    } catch (e) {
      this.log(`Could not set the location: ${(e as Error).message}`);
    }
  }

  /**
   * Start a run now (cancels any scheduled one).
   * "auto"   = a batch: swipes on its own for a random human-length session.
   * "review" = manual review: scores each card and waits for your swipe, until you stop it.
   */
  async start(mode: "auto" | "review" = "auto"): Promise<void> {
    if (this.loopPromise) return;
    this.cancelSchedule();
    this.stopRequested = false;
    this.state.swipesThisSession = 0;
    this.state.lastError = null;
    this.state.lastBatchEnd = null;
    const settings = updateSettings({ mode });
    if (mode === "auto") {
      const minutes = Math.round(rand(settings.batchMinMinutes, settings.batchMaxMinutes));
      const startedAt = new Date();
      this.state.batch = {
        id: startedAt.toISOString(),
        startedAt: startedAt.toISOString(),
        endsAt: new Date(startedAt.getTime() + minutes * 60_000).toISOString(),
        plannedMinutes: minutes,
        evaluated: 0,
      };
      this.log(`Starting a ${minutes}-minute auto-swipe batch (like at P ≥ ${Math.round(settings.threshold * 100)}%${settings.backend === "agent-sdk" ? `, via ${backendLabel(settings)}` : ""}).`);
    } else {
      this.state.batch = null;
      this.log("Starting manual review: I score each card, you swipe from the dashboard (or on the phone panel).");
    }
    this.loopPromise = this.run()
      .finally(() => {
        this.loopPromise = null;
      })
      .then(() => this.afterBatch());
  }

  private cancelSchedule(): void {
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    this.scheduleTimer = null;
    this.state.nextBatchAt = null;
  }

  /** Continuous mode: pick a break, push it into active hours, and schedule the next batch. */
  private afterBatch(): void {
    const settings = loadSettings();
    const endedByUser = this.stopRequested;
    if (endedByUser || this.state.status === "error" || !settings.continuous || settings.mode !== "auto") return;
    const breakMs = rand(settings.breakMinMinutes, settings.breakMaxMinutes) * 60_000;
    let next = new Date(Date.now() + breakMs);
    next = pushIntoActiveHours(next, settings.activeStartHour, settings.activeEndHour);
    this.state.nextBatchAt = next.toISOString();
    this.setStatus("waiting");
    this.log(`Next batch scheduled for ${next.toLocaleString()}.`);
    this.scheduleTimer = setTimeout(() => {
      this.scheduleTimer = null;
      void this.start("auto");
    }, Math.max(1000, next.getTime() - Date.now()));
  }

  private endBatch(reason: string): void {
    this.state.lastBatchEnd = reason;
    this.log(`Batch over: ${reason}`);
  }

  /** Review mode: the dashboard asks us to swipe the profile currently awaiting a decision. */
  requestSwipe(decisionId: string, direction: "like" | "pass"): { ok: boolean; error?: string } {
    if (this.state.status !== "running") return { ok: false, error: "Swiper is not running" };
    if (!this.state.awaiting || this.state.awaiting.decisionId !== decisionId) {
      return { ok: false, error: "That profile is no longer the one on screen" };
    }
    if (this.pendingChoice) return { ok: false, error: "A swipe is already in progress" };
    this.pendingChoice = { decisionId, direction };
    return { ok: true };
  }

  /** Wait for a swipe from the dashboard, or for the card to change because you swiped on the phone panel. */
  private async waitForChoice(fingerprint: string): Promise<"like" | "pass" | "phone" | null> {
    while (!this.stopRequested) {
      if (this.pendingChoice) return this.pendingChoice.direction;
      await this.driver.dismissPopups();
      const fp = await this.driver.currentFingerprint();
      if (fp && fp !== fingerprint) return "phone";
      await sleep(1200);
    }
    return null;
  }

  async stop(): Promise<void> {
    this.cancelSchedule();
    if (!this.loopPromise) {
      if (this.state.status === "waiting") this.setStatus("stopped");
      return;
    }
    this.stopRequested = true;
    this.setStatus("stopping");
    await this.loopPromise;
  }

  /** Get the phone up, Bumble installed and on the deck, and wait for a login if there isn't one. */
  private async openDeck(): Promise<boolean> {
    if (!(await this.ensureDevice())) {
      this.log("No Android device. Check the emulator (Settings → Device) or plug in a phone.");
      return false;
    }
    this.driver.forgetInstalled();
    if (!(await this.driver.isInstalled())) {
      this.setStatus("setup_needed");
      this.log("Bumble is not installed on the phone. Use the Setup panel (Google sign-in + Play Store install).");
      return false;
    }
    await this.driver.goToEncounters();
    const { state } = await this.driver.observe();
    this.setDeck(state);
    if (state === "logged-out" || state === "unknown" || state === "off-app") {
      this.setStatus("awaiting_login");
      this.log("Not logged in to Bumble (or not on the swipe screen). Log in on the phone panel; waiting up to 15 minutes…");
      const ok = await this.driver.waitForLogin(15 * 60_000, () => this.stopRequested);
      if (!ok) {
        this.log(this.stopRequested ? "Stopped while waiting for login." : "Timed out waiting for login.");
        return false;
      }
      this.log("Bumble is on the swipe screen.");
    }
    return true;
  }

  /** Read the card and ask the model, in up to two stages. Returns the decision (unsaved) or "stop" when the run must end. */
  private async judge(profile: ScrapedProfile, id: string, settings: Settings): Promise<Decision | "stop"> {
    const screenUrls = this.driver.saveImages(id, profile.screens, "s");
    const photoUrls = profile.photos.length ? this.driver.saveImages(id, profile.photos) : screenUrls;
    const distance = parseDistance(profile.text);
    const base = {
      id,
      at: new Date().toISOString(),
      ...(this.state.batch ? { batchId: this.state.batch.id } : {}),
      fingerprint: profile.fingerprint,
      mode: settings.mode,
      threshold: settings.threshold,
      ...(settings.superSwipeEnabled ? { superSwipeThreshold: settings.superSwipeThreshold } : {}),
      name: profile.name,
      age: profile.age,
      photos: photoUrls,
      screens: screenUrls,
      profileText: profile.text,
      ...(distance !== undefined ? { distanceMiles: distance } : {}),
    };
    try {
      const forModel = await Promise.all(sample(profile.screens, settings.maxScreens).map(jpegForModel));
      const asInput = (bufs: Buffer[]) => ({ text: profile.text, screens: bufs.map((data) => ({ data, mediaType: "image/jpeg" as const })) });
      // Stage 1: the text plus the first screen only.
      const first = await classifyProfile(asInput(forModel.slice(0, 1)), settings);
      let c = first.classification;
      const usage = { ...first.usage };
      let bioOnlyProbability: number | undefined;
      let quickPass = false;
      const intEarnsLike = !!c && settings.intellectualEnabled && c.intellectual_exception;
      if (c && (settings.quickPassBelow >= 1 || c.probability < settings.quickPassBelow) && !intEarnsLike) {
        // Decide on the text and first screen alone. At 100% this is every profile.
        quickPass = true;
        this.log(`${c.name ?? profile.name ?? "unknown"}: text-and-first-screen P=${c.probability.toFixed(2)}${c.probability < settings.threshold ? " → quick pass." : ", no further look needed."}`);
      } else if (c && forModel.length > 1) {
        // Stage 2: worth a proper look. Send every screen and re-score with the full set.
        bioOnlyProbability = c.probability;
        this.log(`${c.name ?? profile.name ?? "unknown"}: text-and-first-screen P=${c.probability.toFixed(2)}, looking at all ${forModel.length} screens…`);
        const second = await classifyProfile(asInput(forModel), settings);
        if (second.classification) c = second.classification;
        usage.input += second.usage.input;
        usage.output += second.usage.output;
        usage.cacheRead += second.usage.cacheRead;
      }
      const { likes, superSwipes, likedFor } = decide(c, settings);
      let action: Decision["action"];
      if (!c) action = "skipped";
      else if (settings.mode === "auto") action = superSwipes ? "superswipe" : likes ? "like" : "pass";
      else action = likes ? "recommend_like" : "recommend_pass";
      return {
        ...base,
        action,
        ...(likedFor ? { likedFor } : {}),
        name: c?.name ?? profile.name,
        age: c?.age ?? profile.age,
        classification: c,
        usage,
        ...(bioOnlyProbability !== undefined ? { bioOnlyProbability } : {}),
        ...(quickPass ? { quickPass } : {}),
        model: settings.model,
        // Haiku 4.5 has no effort control; don't record one for it.
        ...(/haiku-4-5/i.test(settings.model) ? {} : { effort: settings.effort }),
        ...(first.refused ? { error: "Model declined to evaluate this profile." } : {}),
      };
    } catch (e) {
      const msg = (e as Error).message;
      this.log(`Classifier error: ${msg}`);
      const decision: Decision = { ...base, action: "skipped", classification: null, error: msg };
      // The model asked to talk to Eli (recorded and notified by the shared LLM inbox): stop here, no
      // retry and no next batch. Eli answers it with `llm-inbox`. An auth failure also ends the run.
      if (e instanceof ContactedEliError || /401|403|api key|authentication/i.test(msg)) {
        appendDecision(decision);
        this.emit("decision", decision);
        this.state.lastError = msg;
        this.endBatch(e instanceof ContactedEliError ? "the model contacted Eli; see llm-inbox." : "API authentication failed.");
        this.setStatus("error");
        return "stop";
      }
      return decision;
    }
  }

  /** Auto mode: do the swipe the decision calls for, with human pacing. Returns false when the batch should end. */
  private async autoSwipe(decision: Decision, settings: Settings): Promise<boolean> {
    const p = decision.classification?.probability;
    // A profile the model declined to evaluate gets a pass: you only want likes on qualified profiles.
    const want: "like" | "pass" | "superswipe" = decision.action === "superswipe" ? "superswipe" : decision.action === "like" ? "like" : "pass";
    this.setCurrent({ name: decision.name, fingerprint: decision.fingerprint, doing: "swiping" });
    if (settings.humanize) {
      if (want === "pass") {
        if (!decision.quickPass) await this.driver.secondLook(false, p);
      } else {
        await this.driver.lingerBeforeLike();
      }
    }
    let done: Decision["action"] | null = null;
    if (want === "superswipe") {
      const r = await this.driver.superSwipe();
      if (r === "superswipe") done = "superswipe";
    }
    if (!done) {
      const kind: "like" | "pass" = want === "pass" ? "pass" : "like";
      const how = await this.driver.vote(kind, settings.swipeMethod);
      if (how) done = kind;
    }
    if (!done) {
      const { state: now } = await this.driver.observe();
      this.setDeck(now);
      if (now === "out-of-likes") {
        this.endBatch("Bumble says you're out of likes.");
        return false;
      }
      this.log(`The card didn't advance after the ${want}${now !== "encounters" ? ` (screen: ${now})` : ""}; re-reading the screen.`);
      const updated = updateDecision(decision.id, { action: "skipped", error: `The ${want} did not register (screen: ${now}).` });
      if (updated) this.emit("decision", updated);
      await sleep(2000);
      return true;
    }
    if (done !== decision.action) {
      const updated = updateDecision(decision.id, { action: done });
      if (updated) this.emit("decision", updated);
    }
    this.state.swipesThisSession++;
    this.emit("state", this.state);
    // Quick passes move on faster, but never on a fixed beat.
    await sleep(decision.quickPass && want === "pass" ? rand(300, 1200) : rand(settings.minDelayMs, settings.maxDelayMs));
    return true;
  }

  /** Review mode: show the call and wait for your swipe (dashboard buttons, arrow keys, or the phone panel). */
  private async reviewSwipe(decision: Decision, profile: ScrapedProfile, settings: Settings): Promise<void> {
    const p = decision.classification?.probability;
    this.state.awaiting = { decisionId: decision.id };
    this.setCurrent({ name: decision.name, fingerprint: profile.fingerprint, doing: "waiting for you" });
    this.log("Review mode: choose Pass or Like in the dashboard (or swipe on the phone panel).");
    const choice = await this.waitForChoice(profile.fingerprint);
    this.state.awaiting = null;
    if (choice === "like" || choice === "pass") {
      this.state.swiping = true;
      this.setCurrent({ name: decision.name, fingerprint: profile.fingerprint, doing: "swiping" });
      if (settings.humanize) {
        if (choice === "like") await this.driver.lingerBeforeLike();
        else await this.driver.secondLook(false, p);
      }
      const how = await this.driver.vote(choice, settings.swipeMethod);
      this.state.swiping = false;
      if (!how) this.log(`The ${choice} did not register; the card is still on screen.`);
      else this.state.swipesThisSession++;
      const recommendedLike = decision.action === "recommend_like";
      const verdict = !decision.classification ? null : (choice === "like") === recommendedLike ? "about_right" : choice === "like" ? "higher" : "lower";
      const updated = updateDecision(decision.id, { userSwipe: choice, verdict });
      if (updated) this.emit("decision", updated);
      this.log(`You ${choice === "like" ? "liked" : "passed on"} ${decision.name ?? "this profile"}${verdict ? ` (model's P should be ${verdict.replace("_", " ")})` : ""}.`);
      await sleep(rand(settings.minDelayMs, settings.maxDelayMs));
    } else if (choice === "phone") {
      const updated = updateDecision(decision.id, { userSwipe: "phone" });
      if (updated) this.emit("decision", updated);
      this.log(`You swiped ${decision.name ?? "this profile"} on the phone panel.`);
    }
    this.pendingChoice = null;
    this.emit("state", this.state);
  }

  /** One run: evaluate and swipe until the batch ends (auto) or you stop it (review). */
  private async batchLoop(): Promise<void> {
    let consecutiveFailures = 0;
    let offAppSince = 0;

    while (!this.stopRequested) {
      const settings = loadSettings();
      if (this.state.batch && Date.now() >= new Date(this.state.batch.endsAt).getTime()) {
        this.endBatch(`${this.state.batch.plannedMinutes}-minute batch finished (${this.state.batch.evaluated} profiles).`);
        break;
      }
      if (settings.mode === "auto" && this.state.swipesThisSession >= settings.maxSwipesPerSession) {
        this.endBatch(`reached the cap of ${settings.maxSwipesPerSession} swipes.`);
        break;
      }

      const { state } = await this.driver.observe();
      this.setDeck(state);
      if (state === "no-device") {
        this.endBatch("the phone went away.");
        break;
      }
      if (state === "not-installed") {
        this.endBatch("Bumble is no longer installed.");
        break;
      }
      if (state === "off-app" || state === "off-limits" || state === "unknown") {
        // Someone (or a popup) took us off the deck. Go back without tapping anything but Back / the People tab.
        if (!offAppSince) offAppSince = Date.now();
        if (Date.now() - offAppSince > 120_000) {
          const shot = await this.driver.saveErrorScreenshot("off-deck");
          this.endBatch(`could not get back to the swipe screen for 2 minutes${shot ? ` (screenshot: ${shot})` : ""}.`);
          break;
        }
        this.log(`Bumble is ${state === "off-app" ? "not the app in front" : state === "off-limits" ? "on a settings/profile screen" : "on an unrecognised screen"}; going back to the deck.`);
        await this.driver.dismissPopups();
        await this.driver.goToEncounters();
        await sleep(2500);
        continue;
      }
      offAppSince = 0;
      if (state === "match") {
        this.log("It's a match! Dismissing the match screen.");
        await this.driver.dismissPopups();
        await sleep(1500);
        continue;
      }
      if (state === "out-of-likes") {
        this.endBatch("Bumble says you're out of likes.");
        break;
      }
      if (state === "no-more-profiles") {
        this.endBatch("Bumble has no more profiles to show right now.");
        break;
      }
      if (state === "logged-out") {
        this.endBatch("Bumble logged out.");
        break;
      }

      this.setCurrent({ name: null, fingerprint: "", doing: "reading" });
      const profile = await this.driver.readProfile(settings);
      if (!profile) {
        consecutiveFailures++;
        if (consecutiveFailures >= 5) {
          const shot = await this.driver.saveErrorScreenshot("no-card");
          this.endBatch(`no profile could be read 5 times in a row${shot ? ` (screenshot: ${shot})` : ""}.`);
          break;
        }
        this.log("No profile on screen; retrying…");
        await sleep(3000);
        continue;
      }
      consecutiveFailures = 0;
      if (this.state.batch) this.state.batch.evaluated++;
      this.setCurrent({ name: profile.name, fingerprint: profile.fingerprint, doing: "judging" });
      this.log(`Evaluating ${profile.name ?? "unknown"}${profile.age ? `, ${profile.age}` : ""} (${profile.screens.length} screens, ${profile.photos.length} photos)…`);

      const id = `${Date.now().toString(36)}-${profile.fingerprint}`;
      const decision = await this.judge(profile, id, settings);
      if (decision === "stop") return;
      appendDecision(decision);
      this.emit("decision", decision);
      const p = decision.classification?.probability;
      const ex = decision.classification?.intellectual_exception ? " 🧠 EXCEPTION" : "";
      this.log(`${decision.name ?? "unknown"}: P=${p === undefined ? "n/a" : p.toFixed(2)}${ex} → ${decision.action === "superswipe" ? "SUPERSWIPE" : decision.action.replace("_", " ").toUpperCase()}`);

      if (settings.mode === "auto") {
        if (!(await this.autoSwipe(decision, settings))) break;
      } else {
        await this.reviewSwipe(decision, profile, settings);
      }
    }
  }

  private async run(): Promise<void> {
    try {
      this.setStatus("booting");
      if (!(await this.openDeck())) {
        if (this.state.status !== "setup_needed") this.setStatus("stopped");
        return;
      }
      this.setStatus("running");
      await this.batchLoop();
      if (this.stopRequested && !this.state.lastBatchEnd) this.state.lastBatchEnd = "stopped by you.";
      this.setStatus("stopped");
    } catch (e) {
      const msg = (e as Error).message;
      this.state.lastError = msg;
      this.log(`Error: ${msg}`);
      await this.driver.saveErrorScreenshot("crash").catch(() => null);
      this.setStatus("error");
    } finally {
      this.state.batch = null;
      this.state.current = null;
      this.state.awaiting = null;
      this.state.swiping = false;
      this.pendingChoice = null;
      this.emit("state", this.state);
    }
  }

  /** Diagnostic: what does the phone show right now? */
  async inspect(): Promise<unknown> {
    await this.ensureDevice();
    return this.driver.inspect();
  }

  /** Manual controls from the dashboard. */
  async phoneAction(action: string, settings: Settings): Promise<string | null> {
    await this.ensureDevice();
    switch (action) {
      case "like":
      case "pass": {
        const how = await this.driver.vote(action, settings.swipeMethod);
        return how ? `${action} via ${how}: card advanced` : `${action}: card did not advance`;
      }
      case "dismiss":
        return await this.driver.dismissPopups();
      case "open":
        return (await this.driver.goToEncounters()) ? "on the swipe screen" : "could not open Bumble";
      case "restart":
        await this.driver.restart();
        return "restarted Bumble";
      default:
        throw new Error("unknown action");
    }
  }

  async shutdown(): Promise<void> {
    await this.stop();
    const settings = loadSettings();
    if (settings.stopEmulatorOnExit && this.bootedSerial) await stopEmulator(this.client, this.bootedSerial, (m) => this.log(m));
  }
}
