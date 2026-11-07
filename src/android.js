// Drives the Bumble Android app (in an emulator or on a real phone) through ADB.
// Reads the screen via the accessibility hierarchy (uiautomator dump) and acts with taps/swipes.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { BUTTONS, DISMISS_BUTTON_TEXTS, OUT_OF_SWIPES_PATTERNS, LOGGED_OUT_PATTERNS, MATCH_PATTERNS, NAV_PATTERNS } from './selectors.js';

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const BUMBLE_PACKAGE = 'com.bumble.app';

export function findAdb(explicit) {
  const candidates = [
    explicit,
    process.env.ADB_PATH,
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb'),
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb'),
    path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb'),
    path.join(os.homedir(), 'Android/Sdk/platform-tools/adb'),
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
    'adb',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (c.includes('/') && !fs.existsSync(c)) continue;
      execFileSync(c, ['version'], { stdio: 'ignore' });
      return c;
    } catch { /* try next */ }
  }
  return null;
}

function unescapeXml(s) {
  return s
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

/** Parses a uiautomator XML dump into a flat list of nodes in document order. */
export function parseHierarchy(xml) {
  const nodes = [];
  const re = /<node\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = {};
    const ar = /([\w-]+)="([^"]*)"/g;
    let a;
    while ((a = ar.exec(m[1]))) attrs[a[1]] = unescapeXml(a[2]);
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attrs.bounds || '');
    nodes.push({
      text: (attrs.text || '').trim(),
      desc: (attrs['content-desc'] || '').trim(),
      id: attrs['resource-id'] || '',
      cls: attrs.class || '',
      pkg: attrs.package || '',
      clickable: attrs.clickable === 'true',
      selected: attrs.selected === 'true',
      bounds: b ? { x1: +b[1], y1: +b[2], x2: +b[3], y2: +b[4] } : null,
    });
  }
  return nodes;
}

const center = (n) => ({ x: Math.round((n.bounds.x1 + n.bounds.x2) / 2), y: Math.round((n.bounds.y1 + n.bounds.y2) / 2) });
const area = (n) => (n.bounds ? (n.bounds.x2 - n.bounds.x1) * (n.bounds.y2 - n.bounds.y1) : 0);

export class AndroidClient {
  constructor(opts = {}) {
    this.adbPath = findAdb(opts.adbPath);
    this.serial = opts.deviceSerial || null;
    this.maxProfileScrolls = opts.maxProfileScrolls || 10;
    this.size = null;
    this.device = null;
    this.lastNodes = [];
  }

  // ---------- low level ----------

  async adb(args, { timeout = 20000, binary = false } = {}) {
    if (!this.adbPath) throw new Error('adb not found. Install Android platform-tools (brew install --cask android-platform-tools).');
    const full = this.serial ? ['-s', this.serial, ...args] : args;
    const { stdout } = await execFileP(this.adbPath, full, { timeout, maxBuffer: 32 * 1024 * 1024, encoding: binary ? 'buffer' : 'utf8' });
    return stdout;
  }

  async shell(cmd, opts) {
    return this.adb(['shell', cmd], opts);
  }

  async listDevices() {
    if (!this.adbPath) return [];
    const out = await execFileP(this.adbPath, ['devices', '-l'], { timeout: 10000 }).then((r) => r.stdout).catch(() => '');
    return out.split('\n').slice(1).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [serial, status, ...rest] = l.split(/\s+/);
      const model = (rest.find((p) => p.startsWith('model:')) || '').slice(6);
      return { serial, status, model };
    });
  }

  /** Picks a device (configured serial or first ready one) and caches the screen size. */
  async ensureDevice() {
    const devices = await this.listDevices();
    const ready = devices.filter((d) => d.status === 'device');
    let pick = this.serial ? ready.find((d) => d.serial === this.serial) : ready[0];
    if (!pick) {
      this.device = null;
      this.size = null;
      return null;
    }
    if (!this.device || this.device.serial !== pick.serial || !this.size) {
      this.serial = pick.serial;
      this.device = pick;
      const out = await this.shell('wm size').catch(() => '');
      const m = /Override size:\s*(\d+)x(\d+)/.exec(out) || /Physical size:\s*(\d+)x(\d+)/.exec(out);
      this.size = m ? { w: +m[1], h: +m[2] } : { w: 1080, h: 2340 };
    }
    return this.device;
  }

  url() {
    return this.device ? `${this.device.serial} (${this.device.model || 'android'})` : 'no device';
  }

  async foregroundPackage() {
    const out = await this.shell('dumpsys window | grep -E "mCurrentFocus|mFocusedApp"').catch(() => '');
    const m = /([a-zA-Z0-9_.]+)\/[a-zA-Z0-9_.$]+/.exec(out);
    if (m) return m[1];
    const out2 = await this.shell('dumpsys activity activities | grep -E "topResumedActivity|mResumedActivity"').catch(() => '');
    const m2 = /([a-zA-Z0-9_.]+)\/[a-zA-Z0-9_.$]+/.exec(out2);
    return m2 ? m2[1] : '';
  }

  async dump() {
    let xml = '';
    for (let attempt = 0; attempt < 3 && !xml.includes('<hierarchy'); attempt++) {
      xml = await this.adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { timeout: 20000 }).catch(() => '');
      if (!xml.includes('<hierarchy')) await sleep(500);
    }
    if (!xml.includes('<hierarchy')) {
      await this.shell('uiautomator dump /sdcard/bumble-swiper-ui.xml').catch(() => {});
      xml = await this.adb(['exec-out', 'cat', '/sdcard/bumble-swiper-ui.xml']).catch(() => '');
    }
    const start = xml.indexOf('<?xml');
    const end = xml.lastIndexOf('</hierarchy>');
    if (start < 0 || end < 0) throw new Error('Could not read the screen hierarchy (uiautomator dump failed)');
    const nodes = parseHierarchy(xml.slice(start, end + '</hierarchy>'.length));
    this.lastNodes = nodes;
    return nodes;
  }

  appNodes(nodes) {
    const own = nodes.filter((n) => n.pkg === BUMBLE_PACKAGE);
    return own.length ? own : nodes.filter((n) => n.pkg !== 'com.android.systemui');
  }

  /** Visible strings (text + content descriptions) from Bumble's own nodes, in reading order. */
  texts(nodes) {
    const out = [];
    const seen = new Set();
    for (const n of this.appNodes(nodes)) {
      for (const s of [n.text, n.desc]) {
        if (s && !seen.has(s)) { seen.add(s); out.push(s); }
      }
    }
    return out;
  }

  findButton(nodes, spec) {
    const cands = this.appNodes(nodes).filter((n) => n.bounds && area(n) > 0);
    for (const n of cands) {
      const label = n.desc || n.text;
      if (label && spec.label.test(label)) return n;
    }
    for (const n of cands) if (n.id && spec.id && spec.id.test(n.id)) return n;
    return null;
  }

  async tap(x, y) {
    await this.shell(`input tap ${Math.round(x)} ${Math.round(y)}`);
  }

  async tapNode(node) {
    const c = center(node);
    await this.tap(c.x, c.y);
    return c;
  }

  /** Types a string into the focused field (any characters; spaces and quotes handled). */
  async typeText(text) {
    if (!text) return;
    const q = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
    // `input text` chokes on very long strings; send in chunks
    for (let i = 0; i < text.length; i += 60) {
      const chunk = text.slice(i, i + 60).replace(/ /g, '%s');
      await this.shell(`input text ${q(chunk)}`);
    }
  }

  /** Sends one or more Android key codes (numbers) or names (e.g. KEYCODE_ENTER, ENTER). */
  async key(...codes) {
    const norm = codes.map((c) => (typeof c === 'number' ? c : /^\d+$/.test(String(c)) ? c : `KEYCODE_${String(c).replace(/^KEYCODE_/, '').toUpperCase()}`));
    await this.shell(`input keyevent ${norm.join(' ')}`);
  }

  /** First node whose text or content-desc matches `re` (all packages unless `own`). */
  findByText(nodes, re, { clickableOnly = false, controlsOnly = false, own = false } = {}) {
    const list = own ? this.appNodes(nodes) : nodes;
    const isControl = (n) => n.clickable || /Button|ImageView|CheckBox|Switch/.test(n.cls);
    return list.find((n) => n.bounds && area(n) > 0 && (!clickableOnly || n.clickable) && (!controlsOnly || isControl(n)) && (re.test(n.text) || re.test(n.desc))) || null;
  }

  editTexts(nodes) {
    return nodes.filter((n) => /EditText/.test(n.cls) && n.bounds && area(n) > 0);
  }

  /** Polls the screen until `predicate(nodes, texts)` returns a truthy value or the timeout passes. */
  async waitFor(predicate, { timeoutMs = 30000, intervalMs = 1000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const nodes = await this.dump().catch(() => null);
      if (nodes) {
        const r = predicate(nodes, nodes.map((n) => n.text || n.desc).filter(Boolean).join('\n'));
        if (r) return r;
      }
      await sleep(intervalMs);
    }
    return null;
  }

  async googleAccounts() {
    const out = await this.shell('dumpsys account').catch(() => '');
    return [...out.matchAll(/Account \{name=([^,}]+), type=com\.google\}/g)].map((m) => m[1]);
  }

  async launchApp(pkg) {
    await this.shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`).catch(() => {});
  }

  async openPlayStorePage(pkg) {
    await this.shell(`am start -a android.intent.action.VIEW -d "market://details?id=${pkg}"`).catch(() => {});
  }

  async swipe(x1, y1, x2, y2, ms = 300) {
    await this.shell(`input swipe ${x1} ${y1} ${x2} ${y2} ${ms}`);
  }

  // ---------- high level ----------

  async goToEncounters() {
    await this.ensureDevice();
    await this.shell(`monkey -p ${BUMBLE_PACKAGE} -c android.intent.category.LAUNCHER 1`).catch(() => {});
    await sleep(2500);
    const nodes = await this.dump().catch(() => []);
    const nav = this.findButton(nodes, { label: NAV_PATTERNS.encounters, id: /encounters|discover|people/i });
    if (nav && !nav.selected) { const c = center(nav); await this.tap(c.x, c.y); await sleep(1500); }
  }

  async reload() {
    await this.ensureDevice();
    await this.shell(`am force-stop ${BUMBLE_PACKAGE}`).catch(() => {});
    await sleep(1000);
    await this.goToEncounters();
  }

  profileHeader(nodes) {
    const strings = this.texts(nodes);
    for (const s of strings) {
      const m = /^([^\d\n]{1,40}?)[,\s·]+(\d{2})$/.exec(s);
      if (m && +m[2] >= 18 && +m[2] <= 99) return { name: m[1].trim(), age: m[2] };
    }
    for (let i = 1; i < strings.length; i++) {
      if (/^\d{2}$/.test(strings[i]) && +strings[i] >= 18 && +strings[i] <= 99 && /^[^\d]{1,40}$/.test(strings[i - 1])) {
        return { name: strings[i - 1], age: strings[i] };
      }
    }
    return null;
  }

  async isInstalled() {
    const now = Date.now();
    if (this._installedAt && now - this._installedAt < 30000) return this._installed;
    const out = await this.shell(`pm list packages ${BUMBLE_PACKAGE}`).catch(() => '');
    this._installed = out.split('\n').some((l) => l.trim() === `package:${BUMBLE_PACKAGE}`);
    this._installedAt = now;
    return this._installed;
  }

  /** @returns {Promise<'no-device'|'not-installed'|'off-page'|'match'|'out-of-swipes'|'logged-out'|'encounter'|'no-card'>} */
  async state() {
    if (!(await this.ensureDevice())) return 'no-device';
    if (!(await this.isInstalled())) return 'not-installed';
    const fg = await this.foregroundPackage();
    if (fg && fg !== BUMBLE_PACKAGE) return 'off-page';
    const nodes = await this.dump();
    const joined = this.texts(nodes).join('\n');
    if (MATCH_PATTERNS.some((re) => re.test(joined))) return 'match';
    if (OUT_OF_SWIPES_PATTERNS.some((re) => re.test(joined))) return 'out-of-swipes';
    const header = this.profileHeader(nodes);
    const likeBtn = this.findButton(nodes, BUTTONS.like);
    const passBtn = this.findButton(nodes, BUTTONS.pass);
    if (!header && !likeBtn && LOGGED_OUT_PATTERNS.some((re) => re.test(joined))) return 'logged-out';
    if (likeBtn || passBtn || header) return 'encounter';
    return 'no-card';
  }

  /** Quick read of what is on screen right now. */
  async readProfile() {
    const nodes = await this.dump().catch(() => null);
    if (!nodes) return null;
    const header = this.profileHeader(nodes) || { name: '', age: '' };
    const strings = this.texts(nodes);
    return { name: header.name, age: header.age, pills: [], text: strings.join('\n'), strings };
  }

  /** Scrolls through the whole profile collecting text, then returns to the top. */
  async readProfileFull() {
    const first = await this.readProfile();
    if (!first) return null;
    const all = [];
    const seen = new Set();
    const add = (strings) => { for (const s of strings) if (!seen.has(s)) { seen.add(s); all.push(s); } };
    add(first.strings);
    const { w, h } = this.size;
    let lastSig = first.strings.join('|');
    let scrolls = 0;
    for (; scrolls < this.maxProfileScrolls; scrolls++) {
      await this.swipe(Math.round(w / 2), Math.round(h * 0.78), Math.round(w / 2), Math.round(h * 0.30), 350 + Math.round(Math.random() * 150));
      await sleep(700);
      const p = await this.readProfile();
      if (!p) break;
      const sig = p.strings.join('|');
      if (sig === lastSig) break; // reached the end
      lastSig = sig;
      add(p.strings);
      if (this.profileHeader(this.lastNodes) && p.name && first.name && p.name !== first.name) break; // scrolled into next card
    }
    if (scrolls > 0) await this.scrollToTop(first.strings.join('|'));
    // Short strings are usually badge / interest chips; long ones are bio and prompts.
    const chrome = /^(like|pass|no|yes|superswipe|send a message|report|hide|block|share|unmatch)$/i;
    const pills = all.filter((s) => s.length <= 40 && !/^\d+$/.test(s) && !chrome.test(s));
    return { name: first.name, age: first.age, pills, text: all.join('\n'), strings: all };
  }

  async scrollToTop(topSig) {
    const { w, h } = this.size;
    let last = '';
    for (let i = 0; i < this.maxProfileScrolls + 3; i++) {
      await this.swipe(Math.round(w / 2), Math.round(h * 0.30), Math.round(w / 2), Math.round(h * 0.85), 250);
      await sleep(400);
      const p = await this.readProfile();
      const sig = p ? p.strings.join('|') : '';
      if (sig === topSig || sig === last) break;
      last = sig;
    }
  }

  async like(method = 'click') { return this.#vote('like', method); }
  async pass(method = 'click') { return this.#vote('pass', method); }

  async #vote(kind, method) {
    const { w, h } = this.size;
    if (method !== 'keyboard') {
      const nodes = await this.dump().catch(() => []);
      const btn = this.findButton(nodes, BUTTONS[kind]);
      if (btn) {
        const c = center(btn);
        await this.tap(c.x, c.y);
        return `tap ${kind} button "${btn.desc || btn.text || btn.id}" at ${c.x},${c.y}`;
      }
    }
    const y = Math.round(h * 0.45);
    if (kind === 'like') await this.swipe(Math.round(w * 0.25), y, Math.round(w * 0.9), y, 220);
    else await this.swipe(Math.round(w * 0.75), y, Math.round(w * 0.1), y, 220);
    return `swipe ${kind === 'like' ? 'right' : 'left'} gesture`;
  }

  /** Taps a safe dismiss button (match overlay, upsell popup). Returns its label or null. */
  async dismissPopup() {
    const nodes = await this.dump().catch(() => []);
    for (const n of this.appNodes(nodes)) {
      if (!n.bounds || area(n) === 0) continue;
      const label = (n.text || n.desc).replace(/\s+/g, ' ').trim().toLowerCase();
      if (DISMISS_BUTTON_TEXTS.includes(label)) {
        const c = center(n);
        await this.tap(c.x, c.y);
        return label;
      }
    }
    return null;
  }

  /** Waits until the top of the card no longer matches `previous`. */
  async waitForCardChange(fingerprintFn, previous, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const p = await this.readProfile();
      if (!p) return true;
      if (fingerprintFn(p) !== previous) return true;
      await sleep(600);
    }
    return false;
  }

  async screenshot() {
    await this.ensureDevice();
    return this.adb(['exec-out', 'screencap', '-p'], { binary: true, timeout: 15000 });
  }

  async inspect() {
    const devices = await this.listDevices();
    const dev = await this.ensureDevice();
    const report = { adbPath: this.adbPath, devices, device: dev, screen: this.size };
    if (!dev) return report;
    report.bumbleInstalled = await this.isInstalled();
    report.foregroundPackage = await this.foregroundPackage();
    try {
      const nodes = await this.dump();
      report.state = await this.state();
      report.header = this.profileHeader(nodes);
      report.likeButton = this.findButton(nodes, BUTTONS.like);
      report.passButton = this.findButton(nodes, BUTTONS.pass);
      report.texts = this.texts(nodes);
      report.nodes = this.appNodes(nodes)
        .filter((n) => n.text || n.desc || n.clickable)
        .map((n) => ({ text: n.text, desc: n.desc, id: n.id.replace(`${BUMBLE_PACKAGE}:id/`, ''), cls: n.cls.split('.').pop(), clickable: n.clickable, bounds: n.bounds && `[${n.bounds.x1},${n.bounds.y1}][${n.bounds.x2},${n.bounds.y2}]` }))
        .slice(0, 200);
    } catch (e) {
      report.error = String(e.message || e);
    }
    return report;
  }
}
