import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { evaluate } from './filter.js';
import { PATHS } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const today = () => new Date().toISOString().slice(0, 10);

export function fingerprint(p) {
  return `${p.name}|${p.age}|${(p.text || '').slice(0, 400)}`;
}

/**
 * Drives the swipe loop. Emits: 'log' (string), 'state' (snapshot), 'profile' (current profile + decision).
 */
export class Runner extends EventEmitter {
  constructor(client, getConfig) {
    super();
    this.client = client;
    this.getConfig = getConfig;
    this.running = false;
    this.status = 'idle';
    this.pausedUntil = null;
    this.current = null;
    this.lastFp = null;
    this.sameCount = 0;
    this.noCardCount = 0;
    this.logLines = [];
    this.stats = this.#loadStats();
    this._loop = null;
  }

  snapshot() {
    return {
      running: this.running,
      status: this.status,
      pausedUntil: this.pausedUntil,
      stats: this.stats,
      current: this.current,
      url: this.client.url(),
    };
  }

  log(msg) {
    const line = `${new Date().toLocaleTimeString()}  ${msg}`;
    this.logLines.push(line);
    if (this.logLines.length > 300) this.logLines.shift();
    console.log(line);
    this.emit('log', line);
  }

  setStatus(s) {
    if (s !== this.status) {
      this.status = s;
      this.emit('state', this.snapshot());
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFp = null;
    this.log(`Started (${this.getConfig().dryRun ? 'DRY RUN, no swipes will be made' : 'LIVE'})`);
    this.emit('state', this.snapshot());
    this._loop = this.#run();
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    this.log('Stopping…');
    await this._loop?.catch(() => {});
    this.setStatus('idle');
    this.emit('state', this.snapshot());
  }

  async #run() {
    while (this.running) {
      try {
        await this.#tick();
      } catch (err) {
        if (!this.running) break;
        this.log(`Error: ${err.message || err}`);
        await sleep(3000);
      }
    }
  }

  async #tick() {
    const cfg = this.getConfig();
    this.#rollStats();

    if (this.pausedUntil && Date.now() < this.pausedUntil) {
      this.setStatus('paused (out of swipes)');
      await sleep(5000);
      return;
    }
    if (this.pausedUntil) {
      this.pausedUntil = null;
      this.log('Pause over, checking again');
      await this.client.reload();
    }

    const state = await this.client.state();
    switch (state) {
      case 'no-device':
        this.setStatus('waiting for an Android device (start the emulator or plug in a phone)');
        await sleep(5000);
        return;
      case 'not-installed':
        this.setStatus('Bumble is not installed on the device (install it from the Play Store)');
        await sleep(10000);
        return;
      case 'logged-out':
        this.setStatus('waiting for login (log in to Bumble on the device)');
        await sleep(4000);
        return;
      case 'off-page':
        this.setStatus('Bumble is not in the foreground');
        this.log('Bumble is not the foreground app. Bringing it to the front.');
        await this.client.goToEncounters();
        await sleep(3000);
        return;
      case 'match': {
        const clicked = await this.client.dismissPopup();
        this.stats.matches += 1;
        this.#saveStats();
        this.log(`It's a match! Dismissed overlay${clicked ? ` via "${clicked}"` : ''}.`);
        this.emit('state', this.snapshot());
        await sleep(1500);
        return;
      }
      case 'out-of-swipes':
        this.pausedUntil = Date.now() + cfg.outOfSwipesPauseMinutes * 60 * 1000;
        this.log(`Bumble says you are out of swipes. Pausing ${cfg.outOfSwipesPauseMinutes} min.`);
        this.emit('state', this.snapshot());
        return;
      case 'no-card': {
        this.setStatus('waiting for a profile card');
        this.noCardCount += 1;
        const clicked = await this.client.dismissPopup();
        if (clicked) this.log(`Dismissed popup via "${clicked}"`);
        if (this.noCardCount % 8 === 0) {
          this.log('No profile card for a while, reloading page.');
          await this.client.reload();
        }
        await sleep(2000);
        return;
      }
      case 'encounter':
        this.noCardCount = 0;
        await this.#handleEncounter(cfg);
        return;
      default:
        await sleep(2000);
    }
  }

  async #handleEncounter(cfg) {
    this.setStatus(cfg.dryRun ? 'dry run: evaluating profiles' : 'swiping');

    let profile = await this.client.readProfile();
    if (!profile) return;
    const fp = fingerprint(profile);

    if (fp === this.lastFp) {
      // Same card as last time: either dry-run waiting for the user, onNoMatch=wait, or the swipe did not register.
      this.sameCount += 1;
      if (!cfg.dryRun && this.current?.action && this.current.action !== 'wait' && this.sameCount >= 4) {
        this.log('Card did not advance after swiping. Retrying the swipe.');
        this.lastFp = null;
        this.sameCount = 0;
      }
      await sleep(1000);
      return;
    }
    this.lastFp = fp;
    this.sameCount = 0;

    if (cfg.readProfileScroll) {
      this.setStatus(cfg.dryRun ? 'dry run: reading profile' : 'reading profile');
      profile = (await this.client.readProfileFull()) || profile;
      if (!this.running) return;
    }

    const decision = evaluate(profile, cfg);
    this.stats.seen += 1;

    let action;
    if (cfg.dryRun) action = 'dry-run';
    else if (decision.like) action = 'like';
    else action = cfg.onNoMatch === 'pass' ? 'pass' : 'wait';

    if (action === 'like' && this.stats.liked >= cfg.dailyLikeCap) {
      this.log(`Daily like cap (${cfg.dailyLikeCap}) reached. Stopping.`);
      this.running = false;
      return;
    }
    if ((action === 'like' || action === 'pass') && this.stats.liked + this.stats.passed >= cfg.dailySwipeCap) {
      this.log(`Daily swipe cap (${cfg.dailySwipeCap}) reached. Stopping.`);
      this.running = false;
      return;
    }

    this.current = {
      name: profile.name,
      age: profile.age,
      pills: profile.pills,
      textPreview: profile.text.slice(0, 1200),
      decision,
      action,
      at: new Date().toISOString(),
    };
    this.#recordDecision(this.current);
    this.emit('profile', this.current);

    const who = `${profile.name || '?'}${profile.age ? `, ${profile.age}` : ''}`;
    const verdict = decision.like ? 'LIKE' : 'PASS';
    if (action === 'dry-run') {
      this.log(`[dry run] ${who}: would ${verdict} (${decision.reason}). Swipe manually to continue.`);
      this.emit('state', this.snapshot());
      return;
    }
    if (action === 'wait') {
      this.log(`${who}: ${decision.reason}. Leaving for you to decide.`);
      this.emit('state', this.snapshot());
      return;
    }

    const delay = rand(cfg.delayMs.min, cfg.delayMs.max);
    await sleep(delay);
    if (!this.running) return;
    if ((await this.client.state()) !== 'encounter') return; // things changed while waiting

    const how = action === 'like' ? await this.client.like(cfg.swipeMethod) : await this.client.pass(cfg.swipeMethod);
    if (action === 'like') this.stats.liked += 1; else this.stats.passed += 1;
    this.#saveStats();
    this.log(`${who}: ${verdict} (${decision.reason}) after ${(delay / 1000).toFixed(1)}s via ${how}`);
    this.emit('state', this.snapshot());
    await this.client.waitForCardChange(fingerprint, fp, 8000);
  }

  #recordDecision(entry) {
    try {
      fs.mkdirSync(PATHS.data, { recursive: true });
      fs.appendFileSync(PATHS.decisions, JSON.stringify(entry) + '\n');
    } catch { /* logging is best-effort */ }
  }

  #loadStats() {
    try {
      const s = JSON.parse(fs.readFileSync(PATHS.stats, 'utf8'));
      if (s.date === today()) return { seen: 0, liked: 0, passed: 0, matches: 0, ...s };
    } catch { /* fresh stats */ }
    return { date: today(), seen: 0, liked: 0, passed: 0, matches: 0 };
  }

  #saveStats() {
    try {
      fs.mkdirSync(PATHS.data, { recursive: true });
      fs.writeFileSync(PATHS.stats, JSON.stringify(this.stats, null, 2));
    } catch { /* ignore */ }
  }

  #rollStats() {
    if (this.stats.date !== today()) {
      this.stats = { date: today(), seen: 0, liked: 0, passed: 0, matches: 0 };
      this.#saveStats();
      this.log('New day, daily counters reset.');
    }
  }
}
