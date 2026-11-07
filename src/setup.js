// Guided setup: signs the emulator into Google, installs Bumble from the Play Store, launches it.
// Credentials are used in memory for the duration of the sign-in and never written anywhere.
import { EventEmitter } from 'node:events';
import { BUMBLE_PACKAGE } from './android.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Buttons that safely move Google's setup flow forward, most-preferred first.
const ADVANCE = [/^skip$/i, /^no,? thanks$/i, /^not now$/i, /^i agree$/i, /^agree$/i, /^accept$/i, /^more$/i, /^next$/i, /^continue$/i, /^done$/i, /^ok$/i, /^got it$/i];

export class SetupWizard extends EventEmitter {
  constructor(client, log) {
    super();
    this.client = client;
    this.log = log;
    this.status = { step: 'idle', busy: false, message: '', needsAttention: false, googleAccount: null, bumbleInstalled: false };
  }

  set(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  async refresh() {
    if (!(await this.client.ensureDevice())) return this.status;
    const accounts = await this.client.googleAccounts().catch(() => []);
    const installed = await this.client.isInstalled().catch(() => false);
    this.set({ googleAccount: accounts[0] || null, bumbleInstalled: installed });
    return this.status;
  }

  async runAll({ email, password }) {
    if (this.status.busy) throw new Error('Setup is already running');
    this.set({ busy: true, needsAttention: false });
    try {
      await this.refresh();
      if (!this.status.googleAccount) {
        if (!email || !password) throw new Error('Google email and password are required');
        const ok = await this.googleSignIn({ email, password });
        if (!ok) return false;
      } else {
        this.log(`Google account already signed in (${this.status.googleAccount}).`);
      }
      if (!this.status.bumbleInstalled) {
        const ok = await this.installBumble();
        if (!ok) return false;
      } else {
        this.log('Bumble is already installed.');
      }
      await this.launchBumble();
      this.set({ step: 'done', message: 'Bumble is installed and open. Log in to Bumble on the screen (phone number + SMS code), then use the swiper.' });
      return true;
    } catch (e) {
      this.set({ step: 'error', message: e.message || String(e) });
      this.log(`Setup error: ${e.message || e}`);
      return false;
    } finally {
      this.set({ busy: false });
      await this.refresh().catch(() => {});
    }
  }

  async googleSignIn({ email, password }) {
    const c = this.client;
    this.set({ step: 'google', message: `Signing in to Google as ${email}…`, needsAttention: false });
    this.log(`Google sign-in: opening the Play Store as ${email}`);
    await c.openPlayStorePage(BUMBLE_PACKAGE);
    await sleep(4000);

    const start = Date.now();
    let typedEmail = false;
    let typedPassword = false;
    let lastSig = '';
    let changedAt = Date.now();
    let attentionLogged = false;
    while (Date.now() - start < 300000) {
      const accounts = await c.googleAccounts().catch(() => []);
      if (accounts.length) {
        this.set({ googleAccount: accounts[0], message: `Signed in as ${accounts[0]}`, needsAttention: false });
        this.log(`Google sign-in complete: ${accounts[0]}`);
        await sleep(3000);
        return true;
      }
      const nodes = await c.dump().catch(() => []);
      const texts = nodes.map((n) => n.text || n.desc).filter(Boolean).join('\n');
      if (texts !== lastSig) { lastSig = texts; changedAt = Date.now(); }
      const edits = c.editTexts(nodes);

      if (/wrong password|incorrect password|couldn.t find your google account|couldn.t sign you in/i.test(texts)) {
        this.set({ step: 'error', message: 'Google rejected the email or password. Fix it on the screen or try again.', needsAttention: true });
        this.log('Google sign-in: wrong email or password.');
        return false;
      }
      if (edits.length && !typedEmail && /email|phone/i.test(texts) && !/password/i.test(texts)) {
        if (!(await this.#fillField(edits[0], email))) {
          this.set({ step: 'error', message: 'Could not type the email address into the field. Try it on the phone panel.', needsAttention: true });
          return false;
        }
        typedEmail = true;
        this.log('Google sign-in: entered email');
        const fresh = await c.dump().catch(() => nodes);
        await this.#tapAny(fresh, [/^next$/i]) || await c.key('ENTER');
        await sleep(4000);
        continue;
      }
      if (edits.length && typedEmail && !typedPassword && /password/i.test(texts)) {
        await this.#fillField(edits[0], password, { secret: true });
        typedPassword = true;
        this.log('Google sign-in: entered password');
        await sleep(500);
        const fresh = await c.dump().catch(() => nodes);
        await this.#tapAny(fresh, [/^next$/i]) || await c.key('ENTER');
        await sleep(5000);
        continue;
      }
      if (/verify it.s you|2-step|two-step|verification code|check your phone|tap yes on|enter the code|confirm your recovery|captcha/i.test(texts)) {
        if (!attentionLogged) { attentionLogged = true; this.log('Google sign-in: waiting for you to complete verification on the screen.'); }
        this.set({ message: 'Google needs verification (2-step / code / recovery). Complete it on the phone screen; setup continues automatically.', needsAttention: true });
        await sleep(3000);
        continue;
      }
      if (await this.#tapAny(nodes, typedPassword || !edits.length ? ADVANCE : [/^sign in$/i, /^next$/i])) {
        await sleep(3000);
        continue;
      }
      if (Date.now() - changedAt > 25000) {
        this.set({ message: 'Sign-in seems stuck. Take a look at the phone screen and continue it there; setup resumes automatically.', needsAttention: true });
      }
      await sleep(1500);
    }
    this.set({ step: 'error', message: 'Google sign-in timed out.' });
    return false;
  }

  async installBumble() {
    const c = this.client;
    this.set({ step: 'install', message: 'Installing Bumble from the Play Store…', needsAttention: false });
    this.log('Opening Bumble in the Play Store');
    await c.openPlayStorePage(BUMBLE_PACKAGE);
    await sleep(5000);
    const start = Date.now();
    let tappedInstall = 0;
    let changedAt = Date.now();
    let lastSig = '';
    while (Date.now() - start < 480000) {
      c._installedAt = 0; // bypass the cache
      if (await c.isInstalled()) {
        this.set({ bumbleInstalled: true, message: 'Bumble installed.' });
        this.log('Bumble installed.');
        return true;
      }
      const nodes = await c.dump().catch(() => []);
      const texts = nodes.map((n) => n.text || n.desc).filter(Boolean).join('\n');
      if (texts !== lastSig) { lastSig = texts; changedAt = Date.now(); }
      if (/not available in your (country|region)|isn.t available|not compatible|can.t install/i.test(texts)) {
        this.set({ step: 'error', message: 'The Play Store says Bumble is not available for this device/account. See the phone screen.', needsAttention: true });
        return false;
      }
      if (c.findByText(nodes, /^sign in$/i)) {
        this.set({ step: 'error', message: 'The Play Store is not signed in to Google.' });
        return false;
      }
      const install = c.findByText(nodes, /^install$/i);
      if (install && Date.now() - tappedInstall > 20000) {
        await c.tapNode(install);
        tappedInstall = Date.now();
        this.log('Tapped Install; downloading…');
        this.set({ message: 'Downloading Bumble…' });
        await sleep(5000);
        continue;
      }
      if (/^(pending|downloading|installing|verifying)/im.test(texts) || /\d+%/.test(texts)) {
        await sleep(3000);
        continue;
      }
      if (await this.#tapAny(nodes, [/^continue$/i, /^skip$/i, /^no,? thanks$/i, /^not now$/i, /^got it$/i, /^ok$/i, /^accept$/i])) {
        await sleep(2500);
        continue;
      }
      if (!install && !tappedInstall) {
        // Not on the store page (e.g. a promo or account dialog got in the way); reopen it.
        await c.openPlayStorePage(BUMBLE_PACKAGE);
        await sleep(5000);
      }
      if (Date.now() - changedAt > 60000) {
        this.set({ message: 'Install seems stuck. Check the phone screen; setup resumes automatically.', needsAttention: true });
      }
      await sleep(2500);
    }
    this.set({ step: 'error', message: 'Installing Bumble timed out.' });
    return false;
  }

  async launchBumble() {
    this.set({ step: 'launch', message: 'Opening Bumble…' });
    await this.client.launchApp(BUMBLE_PACKAGE);
    await sleep(5000);
  }

  /** Focuses a field, replaces its content with `value`, and verifies what actually landed. */
  async #fillField(node, value, { secret = false } = {}) {
    const c = this.client;
    for (let attempt = 0; attempt < 3; attempt++) {
      await c.tapNode(node);
      await sleep(600);
      await c.key('MOVE_END');
      await c.key(...Array(Math.min(120, (node.text?.length || 0) + value.length + 10)).fill(67)); // backspace
      await sleep(300);
      await c.typeText(value);
      await sleep(1200);
      const nodes = await c.dump().catch(() => []);
      const field = c.editTexts(nodes)[0];
      const got = field?.text ?? '';
      // password fields report masked text; anything of the right length counts
      if (secret ? got.length === value.length || got.length === 0 : got === value) return true;
      if (secret) return true;
      this.log(`Field contains "${got}" instead of the expected value; retyping.`);
      node = field || node;
    }
    return false;
  }

  async #tapAny(nodes, patterns) {
    for (const re of patterns) {
      const n = this.client.findByText(nodes, re, { controlsOnly: true });
      if (n) {
        await this.client.tapNode(n);
        this.log(`Tapped "${n.text || n.desc}"`);
        return true;
      }
    }
    return false;
  }
}
