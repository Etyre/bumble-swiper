/**
 * Bumble Swiper: a local dashboard (http://localhost:4949) that drives the real Bumble Android app
 * in a headless emulator over ADB, has Claude score each profile for the vegan/vegetarian criterion
 * (with the intellectual exception), and swipes for you or asks you to. This file is the server:
 * the HTTP API, the phone-screen WebSocket, and the wiring between the dashboard and the Swiper.
 *
 * Config:  .env in the project folder (ANTHROPIC_API_KEY, PORT) and data/settings.json (edited from the dashboard).
 * State:   data/decisions.jsonl, data/photos/, data/errors/  (or $BUMBLE_DATA_DIR instead of data/).
 * Logs:    data/server.log when started from the Dock launcher; stdout under `npm run dev`.
 * LLM:     src/llm.ts; every system prompt starts with ../shared/llm-system-prompt-preamble.md.
 */
import "dotenv/config";
import express from "express";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import sharp from "sharp";
import { WebSocketServer } from "ws";
import { PUBLIC_DIR, PHOTOS_DIR } from "./paths.js";
import { loadSettings, updateSettings } from "./config.js";
import { readDecisions, setVerdict, stats, updateDecision } from "./store.js";
import { Swiper } from "./swiper.js";
import { ScreenStream, type InputMessage } from "./screen.js";
import { SetupWizard } from "./setup.js";

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));
app.use("/photos", express.static(PHOTOS_DIR, { maxAge: "1d" }));

// Small thumbnails for the dashboard, generated on first request and cached next to the original.
// Full-size photos decode to a few MB each in the browser; hundreds of them was eating memory.
app.get("/thumbs/:id/:file", async (req, res) => {
  const id = String(req.params.id), file = String(req.params.file);
  if (!/^[\w-]+$/.test(id) || !/^s?\d+\.(jpeg|jpg|png|webp|gif)$/.test(file)) return res.status(400).end();
  const original = path.join(PHOTOS_DIR, id, file);
  const thumb = path.join(PHOTOS_DIR, id, `thumb-${file.replace(/\.\w+$/, ".jpg")}`);
  try {
    if (!fs.existsSync(thumb)) {
      if (!fs.existsSync(original)) return res.status(404).end();
      await sharp(original).rotate().resize({ width: 360, withoutEnlargement: true }).jpeg({ quality: 78 }).toFile(thumb);
    }
    res.set("Cache-Control", "public, max-age=604800");
    res.sendFile(thumb);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

const swiper = new Swiper();
const screen = new ScreenStream(swiper.client, (m) => swiper.log(m));
swiper.driver.onBusy = (b) => (screen.busy = b);
const wizard = new SetupWizard(swiper.client, swiper.driver, (m) => swiper.log(m));
const recentLog: { at: string; message: string }[] = [];
swiper.on("log", (entry) => {
  recentLog.push(entry);
  if (recentLog.length > 200) recentLog.shift();
  console.log(`[${entry.at}] ${entry.message}`);
});

// --- Server-sent events for live updates ---
const clients = new Set<express.Response>();
function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}
swiper.on("log", (e) => broadcast("log", e));
swiper.on("state", (s) => broadcast("state", s));
swiper.on("decision", (d) => broadcast("decision", d));
wizard.on("status", (s) => broadcast("setup", s));

app.get("/api/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  clients.add(res);
  res.write(`event: state\ndata: ${JSON.stringify(swiper.state)}\n\n`);
  res.write(`event: setup\ndata: ${JSON.stringify(wizard.status)}\n\n`);
  req.on("close", () => clients.delete(res));
});

// --- REST ---
app.get("/api/state", (_req, res) => {
  res.json({ state: swiper.state, settings: loadSettings(), stats: stats(), log: recentLog.slice(-50), setup: wizard.status });
});
app.get("/api/decisions", (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, 100_000);
  res.json(readDecisions(limit));
});
app.post("/api/decisions/:id/verdict", (req, res) => {
  const v = req.body?.verdict;
  const up = req.body?.userProbability;
  if (!["higher", "about_right", "lower", null].includes(v)) return res.status(400).json({ error: "verdict must be higher, about_right, lower, or null" });
  if (up !== undefined && up !== null && (typeof up !== "number" || up < 0 || up > 1)) return res.status(400).json({ error: "userProbability must be 0-1" });
  const d = setVerdict(String(req.params.id), v, up);
  if (!d) return res.status(404).json({ error: "decision not found" });
  res.json({ decision: d, stats: stats() });
});
/** Review mode: swipe the profile that is waiting for your call. */
app.post("/api/swipe", (req, res) => {
  const { decisionId, direction } = req.body ?? {};
  if (direction !== "like" && direction !== "pass") return res.status(400).json({ error: "direction must be like or pass" });
  const r = swiper.requestSwipe(String(decisionId), direction);
  if (!r.ok) return res.status(409).json({ error: r.error });
  res.json({ ok: true });
});
app.post("/api/decisions/:id/note", (req, res) => {
  const note = req.body?.note;
  if (typeof note !== "string" || note.length > 2000) return res.status(400).json({ error: "note must be a string up to 2000 chars" });
  const d = updateDecision(String(req.params.id), { note });
  if (!d) return res.status(404).json({ error: "decision not found" });
  res.json({ decision: d });
});
app.post("/api/decisions/:id/exemplar", (req, res) => {
  const ex = req.body?.exemplar;
  if (ex !== "intellectual" && ex !== null) return res.status(400).json({ error: "exemplar must be 'intellectual' or null" });
  const d = updateDecision(String(req.params.id), { exemplar: ex });
  if (!d) return res.status(404).json({ error: "decision not found" });
  res.json({ decision: d });
});
app.post("/api/settings", (req, res) => {
  try {
    const before = loadSettings();
    const after = updateSettings(req.body);
    if (after.city !== before.city || after.latitude !== before.latitude || after.longitude !== before.longitude) {
      if (swiper.state.device) void swiper.setLocation(after);
    }
    res.json(after);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
app.post("/api/start", async (req, res) => {
  const mode = req.body?.mode === "review" ? "review" : "auto";
  void swiper.start(mode);
  res.json({ ok: true, mode });
});
app.post("/api/stop", async (_req, res) => {
  await swiper.stop();
  res.json({ ok: true });
});

// --- phone: setup, manual controls, diagnostics ---
app.get("/api/setup", async (_req, res) => {
  await swiper.ensureDevice();
  res.json(await wizard.refresh().catch(() => wizard.status));
});
app.post("/api/setup/run", async (req, res) => {
  if (wizard.status.busy) return res.status(409).json({ error: "Setup is already running" });
  const { email, password } = req.body ?? {};
  if (!(await swiper.ensureDevice())) return res.status(503).json({ error: "No phone connected yet" });
  void wizard.runAll({ email: String(email ?? "").trim(), password: String(password ?? "") }).catch(() => {});
  res.json({ ok: true });
});
app.post("/api/setup/install", async (_req, res) => {
  if (wizard.status.busy) return res.status(409).json({ error: "Setup is already running" });
  if (!(await swiper.ensureDevice())) return res.status(503).json({ error: "No phone connected yet" });
  wizard.set({ busy: true });
  wizard
    .installBumble()
    .then((ok) => (ok ? wizard.launchBumble() : undefined))
    .catch((e) => wizard.set({ step: "error", message: (e as Error).message }))
    .finally(() => {
      wizard.set({ busy: false });
      void wizard.refresh();
    });
  res.json({ ok: true });
});
app.post("/api/setup/apk", async (req, res) => {
  // Sideload: paths to an .apk or split .apk files on this machine.
  const files = Array.isArray(req.body?.files) ? req.body.files.map(String) : [];
  if (!files.length || !files.every((f: string) => /\.apk$/i.test(f) && fs.existsSync(f))) return res.status(400).json({ error: "give existing .apk file paths" });
  if (!(await swiper.ensureDevice())) return res.status(503).json({ error: "No phone connected yet" });
  try {
    const out = await swiper.client.installApk(files);
    swiper.driver.forgetInstalled();
    swiper.log(`APK install: ${out.trim().split("\n").pop()}`);
    res.json({ ok: true, out });
    void wizard.refresh();
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
app.post("/api/phone/action", async (req, res) => {
  try {
    const how = await swiper.phoneAction(String(req.body?.action ?? ""), loadSettings());
    swiper.log(`Manual action: ${req.body?.action}${how ? ` (${how})` : ""}`);
    res.json({ ok: true, how });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
app.post("/api/phone/connect", async (_req, res) => {
  res.json({ ok: await swiper.ensureDevice(), device: swiper.state.device });
});
app.get("/api/screenshot", async (_req, res) => {
  try {
    if (!(await swiper.ensureDevice())) return res.status(503).json({ error: "no device" });
    res.set("content-type", "image/jpeg").set("cache-control", "no-store").send(await screen.captureFrame());
  } catch (e) {
    res.status(503).json({ error: (e as Error).message });
  }
});
app.get("/api/debug/inspect", async (_req, res) => {
  try {
    res.json(await swiper.inspect());
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// --- WebSocket: live phone screen + input ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  ws.on("message", async (raw, isBinary) => {
    if (isBinary) return;
    let msg: { type: string; on?: boolean };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "screen") {
      if (msg.on) {
        void swiper.ensureDevice();
        screen.subscribe(ws);
      } else screen.unsubscribe(ws);
      return;
    }
    try {
      if (!(await swiper.client.ensureDevice())) return;
      await screen.handleInput(msg as InputMessage);
    } catch (e) {
      swiper.log(`Input error: ${(e as Error).message}`);
    }
  });
});

const port = parseInt(process.env.PORT ?? "4949", 10);
server.listen(port, "127.0.0.1", () => {
  const url = `http://localhost:${port}`;
  console.log(`Dashboard: ${url}`);
  if (process.platform === "darwin" && !process.env.NO_OPEN) exec(`open ${url}`);
  // Bring the phone up in the background so the panel is live when the page opens.
  void swiper.ensureDevice().then((ok) => (ok ? wizard.refresh() : undefined));
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await swiper.shutdown();
    process.exit(0);
  });
}
