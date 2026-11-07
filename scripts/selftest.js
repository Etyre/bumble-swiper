// Self-test: proves the filter and the dashboard server work without an emulator, adb or a Bumble account.
// Run with `npm test`. Exits non-zero on the first failure. Writes nothing to config.json or data/.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { evaluate } from '../src/filter.js';
import { DEFAULT_CONFIG, PATHS } from '../src/config.js';
import { startServer } from '../src/server.js';

const cfg = { ...DEFAULT_CONFIG, terms: ['vegan', 'vegetarian', 'plant-based'] };
let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`ok   ${name}`); }

// ---- filter ----
check('likes a vegan badge', () => {
  const d = evaluate({ pills: ['Vegan', 'Hiking'], text: 'Vegan Hiking' }, cfg);
  assert.equal(d.like, true); assert.deepEqual(d.matchedTerms, ['vegan']); assert.equal(d.where, 'badge');
});
check('"plant based" in the bio matches the hyphenated term', () => {
  const d = evaluate({ pills: [], text: 'Mostly plant based, love cooking' }, cfg);
  assert.equal(d.like, true); assert.equal(d.where, 'bio');
});
check('whole words only: "veganism" does not match "vegan"', () => {
  assert.equal(evaluate({ pills: [], text: 'veganism is a topic' }, cfg).like, false);
});
check('exclude phrase overrides a match', () => {
  const d = evaluate({ pills: [], text: 'definitely not vegan' }, cfg);
  assert.equal(d.like, false); assert.deepEqual(d.excludedBy, ['not vegan']);
});
check('pills-only mode ignores the bio', () => {
  assert.equal(evaluate({ pills: ['Dogs'], text: 'Dogs. I am vegetarian.' }, { ...cfg, matchIn: 'pills' }).like, false);
});
check('no match -> pass', () => {
  assert.equal(evaluate({ pills: ['Climbing'], text: 'Climbing' }, cfg).like, false);
});

// ---- server (with stand-ins for the device, runner, wizard and screen) ----
class FakeRunner extends EventEmitter {
  constructor() { super(); this.logLines = []; this.running = false; }
  snapshot() { return { running: this.running, status: 'idle', pausedUntil: null, stats: { seen: 0, liked: 0, passed: 0, matches: 0 }, current: null, url: 'no device' }; }
  log(m) { this.logLines.push(m); }
  start() { this.running = true; }
  async stop() { this.running = false; }
}
class FakeWizard extends EventEmitter {
  constructor() { super(); this.status = { busy: false, googleAccount: null, bumbleInstalled: false }; }
  async refresh() { return this.status; }
}
const fakeClient = { size: { w: 1080, h: 2400 }, url: () => 'no device', like: async () => 'tap' };
const fakeScreen = { subscribe() {}, unsubscribe() {}, async handleInput() {} };
const runner = new FakeRunner();

const server = await startServer({ runner, client: fakeClient, wizard: new FakeWizard(), screen: fakeScreen, getConfig: () => cfg, setConfig: () => {}, port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<title>Bumble Swiper<\/title>/);
  console.log('ok   GET / serves the dashboard');

  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.config.port, cfg.port); assert.equal(state.screen.w, 1080);
  console.log('ok   GET /api/state returns config + screen size');

  const r = await (await fetch(`${base}/api/start`, { method: 'POST' })).json();
  assert.equal(r.running, true);
  await fetch(`${base}/api/stop`, { method: 'POST' });
  assert.equal(runner.running, false);
  console.log('ok   POST /api/start and /api/stop toggle the runner');

  const bad = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'nope' }) });
  assert.equal(bad.status, 400);
  const like = await (await fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'like' }) })).json();
  assert.equal(like.how, 'tap');
  console.log('ok   POST /api/action routes to the device client');

  const snapshot = await new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws'));
    ws.on('message', (raw) => { ws.close(); resolve(JSON.parse(raw.toString())); });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('no snapshot over WebSocket within 3s')), 3000);
  });
  assert.equal(snapshot.type, 'snapshot'); assert.equal(snapshot.config.dryRun, true);
  console.log('ok   WebSocket sends a snapshot on connect');
  passed += 5;
} finally {
  server.close();
}

check('config.example.json is valid JSON with the documented keys', () => {
  const ex = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  for (const k of Object.keys(DEFAULT_CONFIG)) assert.ok(k in ex, `config.example.json is missing "${k}"`);
  assert.equal(PATHS.config.endsWith('config.json'), true);
});

console.log(`\nAll ${passed} checks passed.`);
process.exit(0);
