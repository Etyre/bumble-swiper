import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { PATHS, saveConfig } from './config.js';

/**
 * Local dashboard: static UI + JSON API + WebSocket (runner events, setup status, live screen, input).
 */
export function startServer({ runner, client, wizard, screen, getConfig, setConfig, port }) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(PATHS.root, 'public')));

  const fullSnapshot = () => ({ ...runner.snapshot(), config: getConfig(), log: runner.logLines, setup: wizard.status, screen: client.size });

  app.get('/api/state', (_req, res) => res.json(fullSnapshot()));
  app.post('/api/start', (_req, res) => { runner.start(); res.json(runner.snapshot()); });
  app.post('/api/stop', async (_req, res) => { await runner.stop(); res.json(runner.snapshot()); });

  app.put('/api/config', (req, res) => {
    const merged = saveConfig({ ...getConfig(), ...req.body, delayMs: { ...getConfig().delayMs, ...(req.body.delayMs || {}) } });
    setConfig(merged);
    runner.log('Config saved');
    broadcast({ type: 'config', config: merged });
    res.json(merged);
  });

  app.post('/api/action', async (req, res) => {
    const { action } = req.body || {};
    try {
      let how = null;
      if (action === 'like') how = await client.like(getConfig().swipeMethod);
      else if (action === 'pass') how = await client.pass(getConfig().swipeMethod);
      else if (action === 'encounters') await client.goToEncounters();
      else if (action === 'reload') await client.reload();
      else if (action === 'dismiss') how = await client.dismissPopup();
      else if (action === 'read') { const p = await client.readProfileFull(); return res.json({ ok: true, profile: p }); }
      else return res.status(400).json({ error: 'unknown action' });
      runner.lastFp = null;
      runner.log(`Manual action: ${action}${how ? ` (${how})` : ''}`);
      res.json({ ok: true, how });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ---- guided setup (Google sign-in -> install Bumble -> launch) ----
  app.get('/api/setup', async (_req, res) => res.json(await wizard.refresh().catch(() => wizard.status)));
  app.post('/api/setup/run', (req, res) => {
    if (wizard.status.busy) return res.status(409).json({ error: 'Setup is already running' });
    const { email, password } = req.body || {};
    wizard.runAll({ email: String(email || '').trim(), password: String(password || '') }).catch(() => {});
    res.json({ ok: true });
  });
  app.post('/api/setup/install', (_req, res) => {
    if (wizard.status.busy) return res.status(409).json({ error: 'Setup is already running' });
    wizard.set({ busy: true });
    wizard.installBumble().then(() => wizard.launchBumble()).catch((e) => wizard.set({ step: 'error', message: e.message })).finally(() => { wizard.set({ busy: false }); wizard.refresh(); });
    res.json({ ok: true });
  });

  app.get('/api/screenshot', async (_req, res) => {
    try {
      res.set('content-type', 'image/png').set('cache-control', 'no-store').send(await client.screenshot());
    } catch (e) {
      res.status(503).json({ error: String(e.message || e) });
    }
  });

  app.get('/api/inspect', async (_req, res) => {
    try { res.json(await client.inspect()); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'snapshot', ...fullSnapshot() }));
    ws.on('message', async (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'screen') {
        if (msg.on) screen.subscribe(ws); else screen.unsubscribe(ws);
        return;
      }
      try { await screen.handleInput(msg); } catch (e) { runner.log(`Input error: ${e.message}`); }
    });
  });

  runner.on('log', (line) => broadcast({ type: 'log', line }));
  runner.on('state', (state) => broadcast({ type: 'state', state: { ...state, screen: client.size } }));
  runner.on('profile', (profile) => broadcast({ type: 'profile', profile }));
  wizard.on('status', (setup) => broadcast({ type: 'setup', setup }));

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
