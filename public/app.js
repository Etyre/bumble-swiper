const $ = (id) => document.getElementById(id);
const fields = ["threshold", "superSwipeEnabled", "superSwipeThreshold", "intellectualEnabled", "prior", "batchMinMinutes", "batchMaxMinutes", "continuous", "breakMinMinutes", "breakMaxMinutes", "activeStartHour", "activeEndHour", "maxSwipesPerSession", "minDelayMs", "maxDelayMs", "humanize", "swipeMethod", "quickPassBelow", "maxScreens", "maxProfileScrolls", "model", "effort", "captureReasoning", "backend", "agentSdkAuth", "userGuidance", "avdName", "emulatorWindow", "stopEmulatorOnExit", "deviceSerial", "city", "latitude", "longitude"];
const boolFields = new Set(["humanize", "continuous", "superSwipeEnabled", "captureReasoning", "intellectualEnabled", "emulatorWindow", "stopEmulatorOnExit"]);
let settings = {};
let state = { status: "idle", awaiting: null, swiping: false, current: null, device: null };
let setup = { step: "idle", busy: false, message: "", googleAccount: null, bumbleInstalled: false };
const decisionsById = new Map();
const cardEls = new Map(); // Live tab "Recent"
const reviewCards = new Map(); // decision id -> { el, ref } in the Review tab
const isEditing = (el) => el && el.contains(document.activeElement) && ["TEXTAREA", "INPUT"].includes(document.activeElement.tagName);
let currentDecisionId = null;
// Drafts are never lost: anything typed into a text box is mirrored to localStorage as you type, keyed by
// field and the record it belongs to, and put back before the box is shown. Cleared only when the text is
// successfully submitted. localStorage can be missing or full (private window), so every access is guarded.
const draftStore = {
  key: (field, id = "") => `bumble:draft:${field}:${id}`,
  get(field, id) { try { const v = localStorage.getItem(this.key(field, id)); return v == null ? undefined : JSON.parse(v); } catch { return undefined; } },
  set(field, id, value) { try { localStorage.setItem(this.key(field, id), JSON.stringify(value)); } catch {} },
  clear(field, id) { try { localStorage.removeItem(this.key(field, id)); } catch {} },
  /** A one-off text box: restore its saved text now and keep saving as it changes. */
  bind(el, field) { const saved = this.get(field, ""); if (typeof saved === "string" && !el.value) el.value = saved; el.addEventListener("input", () => this.set(field, "", el.value)); },
};
const persistedDrafts = (field) => ({ get: (id) => draftStore.get(field, id), set: (id, v) => draftStore.set(field, id, v), delete: (id) => draftStore.clear(field, id), has: (id) => draftStore.get(field, id) !== undefined });
const noteDrafts = persistedDrafts("note"); // unsaved note text by decision id, survives card rebuilds and reloads
const estimateDrafts = persistedDrafts("userProbability"); // a "Your estimate" number typed but not yet accepted

function fmtP(p) { return (p * 100).toFixed(0) + "%"; }
const fmtTime = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// Keep whatever card is at the top of the viewport in place while the DOM above it changes,
// so a new entry arriving doesn't shove the one you're reading down the page.
function keepScroll(update) {
  const cards = document.querySelectorAll(".tabpane:not([hidden]) .card");
  let anchor = null, top = 0;
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    if (r.bottom > 0) { anchor = c; top = r.top; break; }
  }
  update();
  if (anchor && anchor.isConnected && window.scrollY > 0) {
    const delta = anchor.getBoundingClientRect().top - top;
    if (Math.abs(delta) > 1) window.scrollBy(0, delta);
  }
}
const modelNames = { "claude-opus-5-5": "Claude Opus 5.5", "claude-sonnet-5-5": "Claude Sonnet 5.5", "claude-haiku-5-5": "Claude Haiku 5.5", "claude-opus-5": "Claude Opus 5", "claude-sonnet-5": "Claude Sonnet 5", "claude-haiku-4-5": "Claude Haiku 4.5", "claude-opus-4-8": "Claude Opus 4.8", "claude-fable-5-1": "Claude Fable 5.1" };
const hasEffort = (model) => !/haiku-4-5/i.test(model || "");
function modelLabel(d) {
  if (!d.model) return "model not recorded";
  const effort = hasEffort(d.model) && d.effort ? ` (${d.effort} effort)` : "";
  return `${modelNames[d.model] ?? d.model}${effort}`;
}
// Likelihood ratio as a whole-number ratio: 12 -> "12:1", 1.5 -> "3:2", 0.7 -> "7:10", 1 -> "1:1".
function fmtRatio(lr) {
  if (!(lr > 0)) return "1:1";
  let best = [1, 1], bestErr = Infinity;
  for (let den = 1; den <= 20; den++) {
    const num = Math.max(1, Math.round(lr * den));
    if (num > 20 && den > 1) continue;
    const err = Math.abs(num / den - lr) / lr;
    if (err < bestErr - 1e-9) { bestErr = err; best = [num, den]; }
    if (err < 0.02) break;
  }
  return `${best[0]}:${best[1]}`;
}

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}

// ---------- settings ----------
function renderSettingsDerived() {
  $("thresholdVal").textContent = fmtP(parseFloat($("threshold").value));
  const prior = parseFloat($("prior").value);
  $("priorVal").textContent = fmtP(prior);
  $("lrNeeded").textContent = ((1 - prior) / prior).toFixed(1);
  const effortOk = hasEffort($("model").value);
  $("effort").disabled = !effortOk;
  $("effortHint").textContent = effortOk ? "" : "Haiku 4.5 has no effort control.";
  $("superSwipeVal").textContent = fmtP(parseFloat($("superSwipeThreshold").value));
  $("superSwipeRow").hidden = $("superSwipeEnabled").value !== "true";
  $("quickPassVal").textContent = fmtP(parseFloat($("quickPassBelow").value));
  $("continuousOpts").hidden = $("continuous").value !== "true";
  $("customCoords").hidden = $("city").value !== "custom";
  $("agentSdkOpts").hidden = $("backend").value !== "agent-sdk";
}
function fillSettings(s) {
  settings = s;
  // Never overwrite the box being edited: an auto-save response can land while you're still typing.
  for (const f of fields) if ($(f) !== document.activeElement) $(f).value = s[f] == null ? "" : String(s[f]);
  renderSettingsDerived();
}
async function saveSettings(leaving = false) {
  const patch = {};
  for (const f of fields) {
    const el = $(f);
    if (boolFields.has(f)) patch[f] = el.value === "true";
    else if (el.type === "number" || el.type === "range") patch[f] = el.value === "" ? null : parseFloat(el.value);
    else patch[f] = el.value;
  }
  // keepalive lets the request finish after the tab closes (settings are the draft store for these boxes).
  const res = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch), keepalive: leaving });
  if (leaving) return;
  const body = await res.json();
  if (res.ok) { fillSettings(body); $("saveMsg").textContent = "Saved."; }
  else $("saveMsg").textContent = "Error: " + body.error;
  setTimeout(() => ($("saveMsg").textContent = ""), 2500);
}

// ---------- state / log / stats ----------
const statusLabel = { idle: "idle", booting: "starting the phone", setup_needed: "setup needed", awaiting_login: "waiting for Bumble login", running: "running", stopping: "stopping", stopped: "stopped", waiting: "waiting", error: "error" };
function setState(s) {
  state = s;
  const busy = ["booting", "awaiting_login", "running", "stopping"].includes(s.status);
  $("statusText").textContent = (statusLabel[s.status] ?? s.status) + (s.current?.name ? ` · ${s.current.name}` : "") + (busy ? (settings.mode === "auto" ? " · auto" : " · manual review") : "");
  $("statusDot").className = "dot " + s.status;
  $("sSession").textContent = s.swipesThisSession;
  $("startBtn").disabled = busy;
  $("reviewBtn").disabled = busy;
  $("stopBtn").disabled = !busy && s.status !== "waiting";
  $("startBtn").textContent = s.status === "waiting" ? "Start next batch now" : "Start batch (auto)";
  renderBatchText();
  if (s.status === "error" && s.lastError) appendLog({ at: new Date().toISOString(), message: "ERROR: " + s.lastError });
  renderCurrent();
  renderDevice();
  // The profile on screen lives in the "On screen now" panel; keep it out of Recent until swiped.
  for (const [id, el] of cardEls) el.hidden = id === s.awaiting?.decisionId;
}
function renderBatchText() {
  const s = state;
  const el = $("batchText");
  if (s.batch && ["running", "booting", "awaiting_login"].includes(s.status)) {
    const left = Math.max(0, Math.round((new Date(s.batch.endsAt) - Date.now()) / 60000));
    el.textContent = `· ${s.batch.plannedMinutes}-min batch, ${left} min left, ${s.batch.evaluated} profiles`;
  } else if (s.status === "waiting" && s.nextBatchAt) {
    el.textContent = `· next batch ${new Date(s.nextBatchAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
  } else if (s.lastBatchEnd) {
    el.textContent = `· last batch: ${s.lastBatchEnd}`;
  } else el.textContent = "";
  if (s.deck && ["running", "awaiting_login"].includes(s.status)) el.textContent += ` · phone: ${s.deck.replace(/-/g, " ")}`;
}
setInterval(renderBatchText, 30_000);

function appendLog(entry) {
  const el = $("log");
  el.textContent += `${entry.at.slice(11, 19)}  ${entry.message}\n`;
  el.scrollTop = el.scrollHeight;
}
function setStats(s) {
  $("sSeen").textContent = s.seen; $("sLiked").textContent = s.liked; $("sSuper").textContent = s.superSwiped;
  const swiped = s.liked + s.passed;
  $("sLikeRate").textContent = swiped ? Math.round((100 * s.liked) / swiped) + "%" : "–";
}
async function refreshStats() { setStats((await (await fetch("/api/state")).json()).stats); }

// ---------- shared card rendering ----------
function distanceOf(d) {
  if (typeof d.distanceMiles === "number") return d.distanceMiles;
  const m = (d.profileText ?? "").match(/(\d+(?:\.\d+)?)\s*(miles?|mi|km|kilomet\w+)\s+away/i);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return /k/i.test(m[2]) ? Math.round(n * 0.621371) : n;
}
function fillClassification(root, d) {
  const c = d.classification;
  const dist = distanceOf(d);
  root.querySelector(".name").textContent = `${d.name ?? "Unknown"}${d.age ? `, ${d.age}` : ""}`;
  if (dist !== undefined) { const sp = document.createElement("span"); sp.className = "dist"; sp.textContent = `${dist} mi`; root.querySelector(".name").appendChild(sp); }
  const badge = root.querySelector(".action");
  const actionLabel = { like: "Liked", superswipe: "SuperSwiped", pass: "Passed", recommend_like: "Recommends like", recommend_pass: "Recommends pass", skipped: "Not scored" };
  badge.textContent = actionLabel[d.action] ?? d.action.replace("_", " ");
  badge.className = "badge action " + d.action;
  if (c) {
    const bar = root.querySelector(".prob");
    bar.querySelector(".fill").style.width = fmtP(c.probability);
    bar.querySelector(".thresh").style.left = fmtP(d.threshold);
    bar.querySelector(".pval").textContent = fmtP(c.probability);
    if (typeof c.arithmetic_probability === "number") {
      const a = document.createElement("span"); a.className = "arith"; a.title = "Arithmetic posterior: prior odds × the listed ratios";
      a.textContent = `arith ${fmtP(c.arithmetic_probability)}`;
      bar.appendChild(a);
    }
    if (typeof d.superSwipeThreshold === "number") { const t = bar.querySelector(".thresh.super"); t.style.left = fmtP(d.superSwipeThreshold); t.hidden = false; }
    if (c.intellectual_exception) {
      const lf = document.createElement("span"); lf.className = "badge likedfor"; lf.textContent = "🧠 intellectual exception";
      badge.after(lf);
    }
    if (typeof c.intellectual_probability === "number") {
      const ip = document.createElement("span"); ip.className = "intp"; ip.title = "Model's probability that you'd consider her eligible for the intellectual exception";
      ip.textContent = `🧠 ${fmtP(c.intellectual_probability)}`;
      root.querySelector(".model").appendChild(ip);
    }
    root.querySelector(".diet").textContent = c.dietary_badge ? `Dietary tag: ${c.dietary_badge}` : "No dietary tag shown";
    root.querySelector(".modelchip").textContent = modelLabel(d);
    const stage = root.querySelector(".stage");
    if (d.quickPass) stage.textContent = /pass$/.test(d.action) ? "text and first screen only · quick pass" : "text and first screen only";
    else if (typeof d.bioOnlyProbability === "number") stage.textContent = `first screen ${fmtP(d.bioOnlyProbability)} → all screens ${fmtP(c.probability)}`;
    else stage.textContent = "";
    const ul = root.querySelector(".evidence");
    ul.innerHTML = "";
    for (const e of c.evidence) {
      const li = document.createElement("li");
      li.className = e.direction;
      li.textContent = `${e.criterion === "intellectual" ? "🧠 " : ""}${e.observation}`;
      if (e.criterion !== "intellectual") {
        const lr = document.createElement("span"); lr.className = "lr"; lr.textContent = `LR ${fmtRatio(e.likelihood_ratio)}`; li.appendChild(lr);
      }
      ul.appendChild(li);
    }
    if (c.reasoning) root.querySelector(".reasoning").textContent = c.reasoning;
    else root.querySelector(".reasoning")?.closest("details")?.remove();
  } else {
    root.querySelector(".prob")?.remove();
    root.querySelector(".reasoning")?.closest("details")?.remove();
    root.querySelector(".diet").innerHTML = `<span class="error">${d.error ?? "Not classified"}</span>`;
    root.querySelector(".model")?.remove();
  }
  renderProfileText(root.querySelector(".ptext"), d.profileText);
  // Screens: the profile as it scrolled by. Loaded only when the section is opened.
  const box = root.querySelector(".screensBox");
  const screens = (d.screens ?? []).filter((u) => !(d.photos ?? []).includes(u));
  if (!screens.length) box?.remove();
  else {
    box.querySelector("summary").textContent = `Screens (${screens.length})`;
    box.addEventListener("toggle", () => {
      const wrap = box.querySelector(".screens");
      if (!box.open || wrap.children.length) return;
      for (const url of screens) {
        const img = document.createElement("img"); img.src = thumbUrl(url); img.loading = "lazy"; img.decoding = "async";
        img.onclick = () => { const z = img.classList.toggle("zoom"); img.src = z ? url : thumbUrl(url); };
        wrap.appendChild(img);
      }
    }, { once: true });
  }
}
const thumbUrl = (url) => url.replace(/^\/photos\//, "/thumbs/");
function fillPhotos(root, d, limit, full = false) {
  const photos = root.querySelector(".photos");
  photos.innerHTML = "";
  for (const url of d.photos.slice(0, limit)) {
    const img = document.createElement("img");
    img.src = full ? url : thumbUrl(url);
    img.loading = "lazy"; img.decoding = "async";
    img.onclick = () => {
      // Zoom shows the full-size original; un-zoom goes back to the thumbnail.
      const zoomed = img.classList.toggle("zoom");
      img.src = zoomed || full ? url : thumbUrl(url);
    };
    photos.appendChild(img);
  }
}

/**
 * The profile text as read from the app, formatted: the header lines, the bio as paragraphs, and
 * Bumble's tag sections (Interests, My basics, Causes and communities, Languages) as chips.
 */
function renderProfileText(el, text) {
  el.innerHTML = "";
  if (!text) { el.textContent = "(no profile text captured)"; return; }
  const lines = text.split("\n").map((l) => l.replace(/￼/g, " · ").trimEnd());
  const isHead = (l) => /^(about me|about|my basics|basics|interests|causes and communities|causes|looking for|languages?( i know)?|my prompts?|prompts?|work and education|education|location)$/i.test(l.trim());
  const chipSection = (l) => /^(my basics|basics|interests|causes and communities|causes|languages?( i know)?)$/i.test(l.trim());
  const skip = (l) => l.trim() === "";
  let section = null; // current chips container
  let i = 0;
  // Header lines: everything up to the first long line or section heading is name / age / distance / badges.
  const meta = [];
  while (i < lines.length && lines[i].length < 60 && !isHead(lines[i])) { if (!skip(lines[i])) meta.push(lines[i].trim()); i++; }
  if (meta.length) { const m = document.createElement("div"); m.className = "pmeta"; m.textContent = meta.join(" · "); el.appendChild(m); }
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (isHead(l)) {
      const h = document.createElement("div"); h.className = "phead"; h.textContent = l.trim(); el.appendChild(h);
      section = chipSection(l) ? document.createElement("div") : null;
      if (section) { section.className = "chips"; el.appendChild(section); }
      continue;
    }
    if (skip(l)) continue;
    if (section && l.length < 40) {
      const c = document.createElement("span"); c.className = "chip"; c.textContent = l.trim(); section.appendChild(c);
      continue;
    }
    section = null;
    const p = document.createElement("p"); p.className = "pline"; p.textContent = l; el.appendChild(p);
  }
}

// ---------- current profile ----------
function renderCurrent() { keepScroll(renderCurrentInner); }
function renderCurrentInner() {
  const box = $("current");
  const id = state.awaiting?.decisionId ?? null;
  if (state.status !== "running") {
    currentDecisionId = null;
    box.className = "current empty";
    box.textContent = state.status === "awaiting_login" ? "Log into Bumble on the phone panel on the right…"
      : state.status === "booting" ? "Starting the phone and opening Bumble…"
      : state.status === "setup_needed" ? "Bumble isn't installed on the phone yet. Use the Setup panel on the right."
      : state.status === "waiting" ? "Between batches. The next one starts on its own, or press Start to begin now."
      : "Press Start batch (auto) to swipe on its own, or Review manually to score each card and swipe it yourself from here.";
    return;
  }
  if (!id) {
    currentDecisionId = null;
    box.className = "current waiting";
    const c = state.current;
    const doing = { reading: "reading the profile…", judging: "asking the model…", swiping: "swiping…", "waiting for you": "waiting for you…" };
    box.textContent = state.swiping ? "Swiping…" : c ? `${c.name ?? "Someone"}: ${doing[c.doing] ?? c.doing}` : settings.mode === "auto" ? "Auto mode: looking at the phone…" : "Looking at the next profile…";
    return;
  }
  const d = decisionsById.get(id);
  if (!d) { box.className = "current waiting"; box.textContent = "Loading profile…"; return; }
  if (currentDecisionId === id && box.querySelector(".card")) return; // already rendered
  currentDecisionId = id;
  const tpl = $("currentTpl").content.cloneNode(true);
  fillClassification(tpl, d);
  fillPhotos(tpl, d, 9, true);
  const rec = d.action === "recommend_like" ? "like" : d.action === "recommend_pass" ? "pass" : null;
  tpl.querySelector(".swipeHint").textContent = rec ? `Model recommends: ${rec}. Your swipe is final and is recorded as a grade on the model's call.` : "Model could not score this one. Your call.";
  tpl.querySelector(".pass").onclick = () => swipe("pass");
  tpl.querySelector(".like").onclick = () => swipe("like");
  box.className = "current";
  box.innerHTML = "";
  box.appendChild(tpl);
}
async function swipe(direction) {
  const id = state.awaiting?.decisionId;
  if (!id || state.swiping) return;
  const btns = $("current").querySelectorAll(".swipe button");
  btns.forEach((b) => (b.disabled = true));
  const res = await fetch("/api/swipe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decisionId: id, direction }) });
  if (!res.ok) {
    const body = await res.json();
    appendLog({ at: new Date().toISOString(), message: "Swipe rejected: " + body.error });
    btns.forEach((b) => (b.disabled = false));
  }
}
document.addEventListener("keydown", (e) => {
  if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  if (document.activeElement === $("phone")) return; // keys go to the phone
  if (e.key === "ArrowLeft") { e.preventDefault(); swipe("pass"); }
  if (e.key === "ArrowRight") { e.preventDefault(); swipe("like"); }
});

// ---------- history cards ----------
function buildCard(d) {
  const tpl = $("cardTpl").content.cloneNode(true);
  fillClassification(tpl, d);
  fillPhotos(tpl, d, 3);
  const vlabel = tpl.querySelector(".vlabel");
  if (d.userSwipe === "like" || d.userSwipe === "pass") {
    vlabel.innerHTML = `<span class="you">You <b class="${d.userSwipe}">${d.userSwipe === "like" ? "liked" : "passed"}</b> ·</span>`;
  } else if (d.userSwipe === "phone") {
    vlabel.innerHTML = `<span class="you">You swiped on the phone ·</span>`;
  } else {
    vlabel.textContent = "Your call:";
  }
  const vbtns = tpl.querySelectorAll(".vbtn:not(.exemplar)");
  const range = tpl.querySelector(".userpRange");
  const paint = (v, up) => {
    vbtns.forEach((b) => b.classList.toggle("on", b.dataset.v === v));
    range.value = estimateDrafts.get(d.id) ?? (typeof up === "number" ? Math.round(up * 100) : "");
  };
  paint(d.verdict ?? null, d.userProbability);
  const send = async (verdict, userProbability) => {
    const res = await fetch(`/api/decisions/${d.id}/verdict`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ verdict, userProbability }) });
    if (res.ok) {
      const body = await res.json();
      const cur = decisionsById.get(d.id) ?? d;
      cur.verdict = body.decision.verdict; cur.userProbability = body.decision.userProbability;
      estimateDrafts.delete(d.id);
      paint(cur.verdict ?? null, cur.userProbability); setStats(body.stats);
    }
  };
  range.oninput = () => estimateDrafts.set(d.id, range.value);
  vbtns.forEach((b) => {
    b.onclick = () => send(b.classList.contains("on") ? null : b.dataset.v, b.classList.contains("on") ? null : undefined);
  });
  const exBtn = tpl.querySelector(".vbtn.exemplar");
  exBtn.classList.toggle("on", d.exemplar === "intellectual");
  exBtn.onclick = async () => {
    const next = exBtn.classList.contains("on") ? null : "intellectual";
    const res = await fetch(`/api/decisions/${d.id}/exemplar`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exemplar: next }) });
    if (res.ok) { const body = await res.json(); const cur = decisionsById.get(d.id) ?? d; cur.exemplar = body.decision.exemplar; exBtn.classList.toggle("on", cur.exemplar === "intellectual"); }
  };
  range.onchange = () => {
    if (range.value === "") { send(null, null); return; }
    const up = Math.min(100, Math.max(0, parseFloat(range.value))) / 100;
    const p = d.classification?.probability;
    const verdict = p === undefined ? null : up > p + 0.1 ? "higher" : up < p - 0.1 ? "lower" : "about_right";
    send(verdict, up);
  };
  range.onkeydown = (e) => { if (e.key === "Enter") range.blur(); };
  const note = tpl.querySelector(".note");
  const storedDraft = noteDrafts.get(d.id);
  note.value = storedDraft ?? d.note ?? "";
  let noteTimer = null;
  const saveNote = async () => {
    const text = note.value;
    noteDrafts.set(d.id, text);
    if ((decisionsById.get(d.id)?.note ?? "") === text) { noteDrafts.delete(d.id); return; }
    const res = await fetch(`/api/decisions/${d.id}/note`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: text }) });
    if (res.ok) {
      const body = await res.json();
      const cur = decisionsById.get(d.id) ?? d;
      cur.note = body.decision.note; // mutate in place so no card rebuild is triggered
      if (note.value === cur.note) noteDrafts.delete(d.id); // only once the server holds exactly this text
      note.classList.add("saved"); setTimeout(() => note.classList.remove("saved"), 1200);
    }
  };
  note.oninput = () => { noteDrafts.set(d.id, note.value); clearTimeout(noteTimer); noteTimer = setTimeout(saveNote, 800); };
  note.onblur = () => { clearTimeout(noteTimer); saveNote(); };
  // A draft that outlived a reload before its save went through: send it now.
  if (storedDraft !== undefined && storedDraft !== (d.note ?? "")) noteTimer = setTimeout(saveNote, 800);
  if (!d.classification) { tpl.querySelector(".verdict").remove(); note.remove(); }
  const u = d.usage ? ` · ${d.usage.input + d.usage.cacheRead} in / ${d.usage.output} out tokens` : "";
  tpl.querySelector(".meta").textContent = `${new Date(d.at).toLocaleString()} · ${d.mode} mode · threshold ${fmtP(d.threshold)}${u}`;
  return tpl.querySelector("article");
}

function renderDecision(d, prepend) {
  const prev = decisionsById.get(d.id);
  if (prev) {
    // Keep local edits: the server copy may lag a note or grade typed a moment ago.
    if (noteDrafts.has(d.id)) d.note = prev.note ?? d.note;
    if (prev.verdict !== undefined && d.verdict == null) d.verdict = prev.verdict;
    if (prev.userProbability != null && d.userProbability == null) d.userProbability = prev.userProbability;
  }
  decisionsById.set(d.id, d);
  if (state.awaiting?.decisionId === d.id) renderCurrent();
  const existing = cardEls.get(d.id);
  if (existing && isEditing(existing)) { scheduleReviewRender(); return; }
  const article = buildCard(d);
  keepScroll(() => {
    const feed = $("decisions");
    feed.querySelector(".empty")?.remove();
    if (existing) existing.replaceWith(article);
    else prepend ? feed.prepend(article) : feed.appendChild(article);
    article.hidden = state.awaiting?.decisionId === d.id;
    cardEls.set(d.id, article);
    // Keep only the most recent few in the Live tab; the Review tab has everything.
    while (feed.children.length > 8) { const last = feed.lastElementChild; for (const [id, el] of cardEls) if (el === last) cardEls.delete(id); last.remove(); }
  });
  scheduleReviewRender();
}

// ---------- review tab ----------
let reviewTimer = null;
let pendingReview = 0; // background updates held back while you're reading the list
function scheduleReviewRender() {
  clearTimeout(reviewTimer);
  reviewTimer = setTimeout(() => renderReview(false), 150);
}
function updatePendingPill() {
  const pill = $("reviewPending");
  pill.hidden = pendingReview === 0;
  if (pendingReview) pill.textContent = `${pendingReview} new ${pendingReview === 1 ? "entry" : "entries"} · click to update the list`;
}
// Batches: real ids going forward; entries without one are grouped by gaps of more than 15 minutes.
function assignBatches(all) {
  const sorted = [...all].sort((a, b) => (a.at < b.at ? -1 : 1));
  let pseudo = null, lastT = 0;
  for (const d of sorted) {
    const t = new Date(d.at).getTime();
    if (d.batchId) { d._batch = d.batchId; pseudo = null; }
    else {
      if (!pseudo || t - lastT > 15 * 60_000) pseudo = "~" + d.at;
      d._batch = pseudo;
    }
    lastT = t;
  }
  const groups = new Map();
  for (const d of sorted) { const g = groups.get(d._batch) ?? { id: d._batch, start: d.at, n: 0 }; g.n++; groups.set(d._batch, g); }
  return [...groups.values()].sort((a, b) => (a.start < b.start ? 1 : -1));
}
function refreshBatchOptions(groups) {
  const sel = $("fBatch"); const cur = sel.value;
  const label = (g) => `${fmtTime(g.start)} · ${g.n} profiles${g.id.startsWith("~") ? " (review session)" : ""}`;
  const wanted = ["all", ...groups.map((g) => g.id)];
  if ([...sel.options].map((o) => o.value).join("|") !== wanted.join("|")) {
    sel.innerHTML = '<option value="all">All batches</option>' + groups.map((g) => `<option value="${g.id}">${label(g)}</option>`).join("");
    sel.value = wanted.includes(cur) ? cur : "all";
  }
}

let reviewDirty = false;
const REVIEW_PAGE = 40;
let reviewLimit = REVIEW_PAGE;
function renderReview(userInitiated = true) {
  const list = $("reviewList");
  if ($("tab-review").hidden) { reviewDirty = true; return; } // render when the tab is shown
  if (isEditing(list)) { reviewDirty = true; return; } // finish typing first; re-render on blur
  // A background update while you're scrolled into the list would move things under you. Hold it.
  if (!userInitiated && window.scrollY > 150 && list.children.length) { pendingReview++; reviewDirty = true; updatePendingPill(); return; }
  pendingReview = 0; updatePendingPill();
  reviewDirty = false;
  const all = Array.from(decisionsById.values());
  refreshBatchOptions(assignBatches(all));
  const fBatch = $("fBatch").value;
  $("reviewCount").textContent = all.length ? `(${all.length})` : "";
  const minP = parseFloat($("minP").value);
  $("minPVal").textContent = fmtP(minP);
  const fAction = $("fAction").value, fSwipe = $("fSwipe").value, fSort = $("fSort").value, fVerdict = $("fVerdict").value;
  const which = $("minPWhich").value;
  document.body.classList.toggle("show-intp", which === "int" || fSort === "int"); // exception probability shows only when filtering or sorting by it
  document.body.classList.toggle("show-arith", $("fProb").value === "both");
  const scoreOf = (d) => (which === "int" ? d.classification?.intellectual_probability : d.classification?.probability);
  const intOf = (d) => d.classification?.intellectual_probability ?? -1;
  const liked = (d) => d.action === "like" || d.action === "superswipe" || d.userSwipe === "like";
  const passed = (d) => d.action === "pass" || d.userSwipe === "pass";
  const rows = all.filter((d) => {
    if (fBatch !== "all" && d._batch !== fBatch) return false;
    const p = scoreOf(d);
    if (minP > 0 && (p === undefined || p < minP)) return false;
    if (fVerdict === "ungraded" && d.verdict) return false;
    if (["higher", "lower", "about_right"].includes(fVerdict) && d.verdict !== fVerdict) return false;
    if (fAction === "like" && !/like$|superswipe/.test(d.action)) return false;
    if (fAction === "pass" && !/pass$/.test(d.action)) return false;
    if (fAction === "skipped" && d.action !== "skipped") return false;
    if (fAction === "exception" && !d.classification?.intellectual_exception) return false;
    if (fSwipe === "like" && !liked(d)) return false;
    if (fSwipe === "pass" && !passed(d)) return false;
    if (fSwipe === "none" && (liked(d) || passed(d) || d.userSwipe === "phone")) return false;
    return true;
  });
  rows.sort((a, b) => {
    if (fSort === "prob") return (b.classification?.probability ?? -1) - (a.classification?.probability ?? -1) || (b.at > a.at ? 1 : -1);
    if (fSort === "int") {
      // Your flagged reference cases first, then the model's own exceptions, then by probability.
      const rank = (d) => (d.exemplar === "intellectual" ? 2 : d.classification?.intellectual_exception ? 1 : 0);
      return rank(b) - rank(a) || intOf(b) - intOf(a) || (b.at > a.at ? 1 : -1);
    }
    if (fSort === "oldest") return a.at < b.at ? -1 : 1;
    if (fSort === "near") return (distanceOf(a) ?? 9999) - (distanceOf(b) ?? 9999) || (b.at > a.at ? 1 : -1);
    return a.at < b.at ? 1 : -1;
  });
  const above = all.filter((d) => (scoreOf(d) ?? -1) >= minP).length;
  const swipedRows = rows.filter((d) => liked(d) || passed(d));
  const likedRows = swipedRows.filter(liked).length;
  const likeRate = swipedRows.length ? ` · like rate ${Math.round((100 * likedRows) / swipedRows.length)}% (${likedRows} of ${swipedRows.length})` : "";
  $("filterSummary").textContent = all.length
    ? `${rows.length} of ${all.length} profiles shown · ${above} scored at or above ${fmtP(minP)}${likeRate}`
    : "Nothing evaluated yet.";
  // Reuse existing cards (same decision object => same card), so typed text and open <details> survive.
  const shown = rows.slice(0, reviewLimit);
  keepScroll(() => {
    const keep = new Set(shown.map((d) => d.id));
    for (const [id, entry] of reviewCards) if (!keep.has(id)) { entry.el.remove(); reviewCards.delete(id); }
    for (const d of shown) {
      let entry = reviewCards.get(d.id);
      if (!entry || entry.ref !== d) {
        if (entry) entry.el.remove();
        entry = { el: buildCard(d), ref: d };
        reviewCards.set(d.id, entry);
      }
      list.appendChild(entry.el); // appending in order moves existing nodes into place
    }
    list.querySelector(".empty")?.remove();
    if (rows.length > reviewLimit) {
      const more = document.createElement("button"); more.className = "empty more"; more.textContent = `Show more (${shown.length} of ${rows.length})`;
      more.onclick = () => { reviewLimit += REVIEW_PAGE; renderReview(); };
      list.appendChild(more);
    } else if (!rows.length) {
      const e = document.createElement("div"); e.className = "empty"; e.textContent = "Nothing here.";
      list.appendChild(e);
    }
  });
}
document.addEventListener("focusout", () => { if (reviewDirty) setTimeout(() => { if (!isEditing($("reviewList"))) renderReview(false); }, 50); });
$("reviewPending").onclick = () => { window.scrollTo({ top: 0 }); renderReview(true); };
window.addEventListener("scroll", () => { if (pendingReview && window.scrollY <= 150 && !$("tab-review").hidden) renderReview(true); }, { passive: true });
for (const id of ["minP", "minPWhich", "fAction", "fSwipe", "fSort", "fVerdict", "fProb", "fBatch"]) $(id).addEventListener("input", () => { reviewLimit = REVIEW_PAGE; renderReview(); });

// ---------- tabs ----------
function showTab(name) {
  document.querySelectorAll(".tabs .tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  $("tab-swipe").hidden = name !== "swipe";
  $("tab-review").hidden = name !== "review";
  try { localStorage.setItem("tab", name); } catch {}
  if (name === "review") renderReview(true);
  wsSend({ type: "screen", on: name === "swipe" });
}
document.querySelectorAll(".tabs .tab").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

// ---------- phone: live screen + input over WebSocket ----------
let ws = null;
const phone = $("phone"), shot = $("shot");
let prevUrl = null, frames = 0, fpsT0 = Date.now();
function wsSend(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function showFrame(blob) {
  const url = URL.createObjectURL(blob);
  shot.onload = () => { if (prevUrl) URL.revokeObjectURL(prevUrl); prevUrl = url; };
  shot.src = url;
  $("phoneMsg").style.display = "none";
  frames++;
  if (Date.now() - fpsT0 > 2000) { $("fps").textContent = (frames / ((Date.now() - fpsT0) / 1000)).toFixed(1) + " fps"; frames = 0; fpsT0 = Date.now(); }
}
function norm(ev) {
  const r = shot.getBoundingClientRect();
  return { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height };
}
let down = null;
phone.addEventListener("pointerdown", (ev) => { phone.focus(); down = { ...norm(ev), t: Date.now(), cx: ev.clientX, cy: ev.clientY }; phone.setPointerCapture(ev.pointerId); ev.preventDefault(); });
phone.addEventListener("pointerup", (ev) => {
  if (!down) return;
  const up = norm(ev), dt = Date.now() - down.t;
  const dist = Math.hypot(ev.clientX - down.cx, ev.clientY - down.cy);
  if (dist < 8 && dt < 500) wsSend({ type: "tap", x: up.x, y: up.y });
  else wsSend({ type: "swipe", x1: down.x, y1: down.y, x2: up.x, y2: up.y, ms: Math.max(80, Math.min(1500, dt)) });
  down = null;
});
let textBuf = "", textTimer = null;
function flushText() { if (textBuf) { wsSend({ type: "text", text: textBuf }); textBuf = ""; } textTimer = null; }
const SPECIAL = new Set(["Enter", "Backspace", "Delete", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);
phone.addEventListener("keydown", (ev) => {
  if (ev.metaKey || ev.ctrlKey) return; // let copy/paste through
  if (SPECIAL.has(ev.key)) { flushText(); wsSend({ type: "key", key: ev.key }); ev.preventDefault(); return; }
  if (ev.key.length === 1) { textBuf += ev.key; clearTimeout(textTimer); textTimer = setTimeout(flushText, 150); ev.preventDefault(); }
});
phone.addEventListener("paste", (ev) => { const t = ev.clipboardData.getData("text"); if (t) wsSend({ type: "text", text: t }); ev.preventDefault(); });
for (const b of document.querySelectorAll("[data-key]")) b.onclick = () => wsSend({ type: "key", key: b.dataset.key });
draftStore.bind($("sendText"), "sendText");
$("sendText").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { wsSend({ type: "text", text: $("sendText").value }); $("sendText").value = ""; draftStore.clear("sendText", ""); } });
function connectWs() {
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
  ws.binaryType = "blob";
  ws.onopen = () => wsSend({ type: "screen", on: !$("tab-swipe").hidden });
  ws.onmessage = (ev) => { if (ev.data instanceof Blob) showFrame(ev.data); };
  ws.onclose = () => { $("phoneMsg").style.display = ""; $("phoneMsg").textContent = "Disconnected; reconnecting…"; setTimeout(connectWs, 2000); };
}

function renderDevice() {
  const d = state.device;
  $("stDevice").textContent = d ? "✅" : state.status === "booting" ? "⏳" : "○";
  $("deviceLabel").textContent = d ? `(${d.avd ? d.avd + " · " : ""}${d.serial})` : "";
  if (!d) { $("phoneMsg").style.display = ""; $("phoneMsg").textContent = state.status === "booting" ? "Starting the emulator… (first boot takes a minute or two)" : "No phone connected. It boots on its own when you press Start, or when the page loads."; }
}
function renderSetup(st) {
  setup = st;
  $("stGoogle").textContent = st.googleAccount ? "✅" : st.step === "google" && st.busy ? "⏳" : "○";
  $("googleAcct").textContent = st.googleAccount ? `(${st.googleAccount})` : "";
  $("stBumble").textContent = st.bumbleInstalled ? "✅" : st.step === "install" && st.busy ? "⏳" : "○";
  $("stLogin").textContent = st.bumbleInstalled ? (state.deck === "encounters" ? "✅" : "👉") : "○";
  const msg = $("setupMsg");
  msg.hidden = !st.message;
  msg.textContent = st.message || "";
  msg.className = "note" + (st.step === "error" ? " err" : "") + (st.needsAttention ? " warn" : "");
  $("googleForm").hidden = !!st.googleAccount || !state.device;
  $("installOnly").hidden = !(st.googleAccount && !st.bumbleInstalled);
  $("setupRun").disabled = st.busy;
  $("setupInstall").disabled = st.busy;
}
$("setupRun").onclick = async () => {
  const email = $("gEmail").value.trim(), password = $("gPass").value;
  if (!email || !password) { $("setupMsg").hidden = false; $("setupMsg").className = "note err"; $("setupMsg").textContent = "Enter your Google email and password first."; return; }
  const r = await api("POST", "/api/setup/run", { email, password });
  if (r.error) appendLog({ at: new Date().toISOString(), message: "Setup: " + r.error });
  else draftStore.clear("gEmail", "");
  $("gPass").value = ""; // the password is never saved anywhere
};
draftStore.bind($("gEmail"), "gEmail");
draftStore.bind($("apkPaths"), "apkPaths");
$("setupInstall").onclick = () => api("POST", "/api/setup/install");
$("apkInstall").onclick = async () => {
  const files = $("apkPaths").value.split("\n").map((s) => s.trim()).filter(Boolean);
  const r = await api("POST", "/api/setup/apk", { files });
  appendLog({ at: new Date().toISOString(), message: r.error ? "APK install failed: " + r.error : "APK installed." });
  if (!r.error) draftStore.clear("apkPaths", "");
};
for (const b of document.querySelectorAll("[data-action]")) b.onclick = async () => {
  b.disabled = true;
  try { const r = await api("POST", "/api/phone/action", { action: b.dataset.action }); if (r.error) appendLog({ at: new Date().toISOString(), message: "Action failed: " + r.error }); }
  finally { b.disabled = false; }
};
$("inspectBtn").onclick = async () => {
  $("inspect").hidden = false;
  $("inspect").textContent = "Inspecting…";
  $("inspect").textContent = JSON.stringify(await api("GET", "/api/debug/inspect"), null, 2);
};

// ---------- init ----------
async function init() {
  const st = await (await fetch("/api/state")).json();
  fillSettings(st.settings); setStats(st.stats);
  for (const e of st.log) appendLog(e);
  const decisions = await (await fetch("/api/decisions?limit=100000")).json();
  if (!decisions.length) $("decisions").innerHTML = '<div class="empty">No decisions yet.</div>';
  for (const d of decisions) decisionsById.set(d.id, d);
  for (const d of decisions.slice(0, 8).reverse()) renderDecision(d, true);
  setState(st.state);
  renderSetup(st.setup);
  let tab = "swipe";
  try { tab = localStorage.getItem("tab") || "swipe"; } catch {}
  showTab(tab);
  connectWs();

  const es = new EventSource("/api/events");
  es.addEventListener("log", (e) => appendLog(JSON.parse(e.data)));
  es.addEventListener("state", async (e) => { const st = JSON.parse(e.data); if (st.status === "booting") { settings = (await (await fetch("/api/state")).json()).settings; } setState(st); renderSetup(setup); });
  es.addEventListener("setup", (e) => renderSetup(JSON.parse(e.data)));
  es.addEventListener("decision", (e) => { const d = JSON.parse(e.data); renderDecision(d, !decisionsById.has(d.id)); refreshStats(); });
  // Setup status straight from the phone once it's up.
  fetch("/api/setup").then((r) => r.json()).then(renderSetup).catch(() => {});
}

async function startRun(mode) {
  const res = await fetch("/api/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
  if (res.ok) settings.mode = mode;
}
$("startBtn").onclick = () => startRun("auto");
$("reviewBtn").onclick = () => startRun("review");
$("stopBtn").onclick = () => fetch("/api/stop", { method: "POST" });
$("saveBtn").onclick = () => saveSettings();
for (const f of ["threshold", "prior", "continuous", "quickPassBelow", "superSwipeEnabled", "superSwipeThreshold", "model", "city", "backend"]) $(f).addEventListener("input", renderSettingsDerived);
// Auto-save: every setting saves itself. Sliders and selects on release/change, text boxes a moment after you stop typing.
{
  let timer = null;
  const queueSave = (delay) => { clearTimeout(timer); timer = setTimeout(() => { timer = null; $("saveMsg").textContent = "Saving…"; saveSettings(); }, delay); };
  for (const f of fields) {
    const el = $(f);
    if (el.tagName === "TEXTAREA" || el.type === "text" || el.type === "number") el.addEventListener("input", () => queueSave(1200));
    else el.addEventListener("change", () => queueSave(150));
  }
  // Closing or reloading the tab inside the debounce window must not lose what was just typed: flush the pending save.
  window.addEventListener("pagehide", () => { if (timer) { clearTimeout(timer); timer = null; saveSettings(true); } });
}
init();
