# Bumble Swiper 🌱

A local web app that swipes Bumble for you, liking only women who are likely vegan, vegetarian, or otherwise not subsidizing factory farming. Each profile is scored by Claude with a Bayesian prompt: start from a base rate, update on the evidence in the bio, Interest tags, badges and photos, and swipe right only when the posterior clears your threshold (default 50%), or when the profile clears the separate "intellectual exception". Bumble has no web app any more ("Bumble is now app-only", September 2026), so this one drives the **real Bumble Android app running in an Android emulator** (or a real phone over USB) through ADB, and shows the phone live inside the dashboard. The evaluation flow is the Tinder swiper's (two-stage judging, auto batches, manual review with grading); the phone side is the Feeld swiper's (headless emulator, phone panel, setup wizard). First built as a keyword filter on 2 September 2026; rebuilt around the Claude classifier on 9 November 2026.

> **Heads-up:** automation is against Bumble's terms of service and can get an account restricted or banned.
> The app uses random human-like pacing, modest batch lengths and a per-batch swipe cap. Use at your own risk.

## How it works

1. `npm run dev` starts the dashboard at http://localhost:4949 and boots the `bumble` virtual device **invisibly in the background**. The dashboard's **Phone** panel streams the phone screen; click to tap, drag to swipe, and type when the panel has focus. You never need the emulator's own window.
2. The **Setup** panel gets you from an empty phone to a logged-in Bumble: sign the phone into Google (Play Store), install Bumble, then log in to Bumble on the phone panel (phone number + SMS code). Your Bumble account is the same on every platform. Alternatively sideload an APK.
3. **Start batch (auto)** runs one swiping session of random length (10–150 minutes by default), like a person picking up the app for a while. For each card it scrolls through the profile the way a person would, reading the text from Android's accessibility tree and taking a screenshot at each position, then asks Claude. Stage one sends the text plus the first screen; under the quick-pass threshold (15%) it decides on that alone, otherwise it sends every screen and re-scores with the full set.
4. The model returns evidence items with rough likelihood ratios, a calibrated probability, and a probability for the intellectual exception. The app likes when P ≥ your threshold or the exception fires, else passes, with human-like pauses: it scrolls slowly back up before a like, flicks past quick passes. A SuperSwipe (off by default) can replace a like above a second threshold. It votes by tapping Bumble's like/pass buttons, or by swiping the card when the buttons can't be found.
5. The batch ends when its time is up, Bumble runs out of profiles or likes, or the swipe cap is hit. Optionally it takes a random break (default 1.5–6 hours, within active hours) and starts the next batch itself.
6. **Review manually** is the alternative flow: the model scores the card on screen and shows it in **On screen now** with Pass / Like buttons (or the arrow keys); your choice performs the real swipe on the phone. Swiping on the phone panel yourself also works. Your swipe is graded automatically: liking against a pass recommendation counts as "should be higher", and so on.
7. Afterwards, the **Review** tab shows every profile it judged. Filter by probability, batch, the model's call, the swipe, or your grade. Grade each call as **Lower probability**, **No change**, or **Higher probability**, type your own probability, flag reference cases of the intellectual exception with 🧠, and leave a note on what the model missed. Your notes and grades, plus the standing "Guidance for the model" box in settings, are included in every future prompt as calibration feedback.

Set `BUMBLE_DATA_DIR` to run against a different data folder (handy for testing). Every decision is appended to `data/decisions.jsonl` with the profile text, photo crops, the screens it saw, the model's answer, your swipe and grades.

### Model calls

All calls go through `src/llm.ts` (`structuredCall`), on whichever backend Settings selects: the Claude API with the key in `.env`, or the Claude Agent SDK (Claude Code as a library, every built-in tool off) using this machine's Claude Code sign-in. Each call follows the agent-coding LLM standard: the system prompt starts with `../shared/llm-system-prompt-preamble.md` word for word (read at call time), the `contact_eli` tool from `../shared/contact_eli_tool.json` is offered (on the Agent SDK path it is served as an in-process MCP tool, `mcp__eli__contact_eli`), and every response is piped to `python3 ../shared/llm_contact.py check`. If the model called the tool or wrote an `@ELI:` line, the call throws `ContactedEliError`: the profile is recorded as skipped with that message, the batch ends with status **error**, and no next batch is scheduled. Nothing is retried; Eli reads and answers with `llm-inbox`, then presses Start again.

Confirm step (API backend only, added 2026-11-10 because Haiku used the tool for routine remarks about the task): it runs only when the model is in the shared `CONFIRM_MODELS` list in `../shared/llm_contact.py` (today only `claude-haiku-4-5`); for every other model `llm_contact.py confirm` prints `null` and a `contact_eli` call is sent as before. Live testing in `../shared` (see its README, Gotchas) showed the forced question is only safe on Haiku 4.5: other models either dropped real "I want to stop" messages or reject a forced tool choice. For this app: `data/settings.json` currently selects the API backend with `claude-opus-5-5`, so the confirm step is inactive and every `contact_eli` call stops the batch and reaches Eli; it becomes active only if Haiku 4.5 is chosen as the model on the API backend. When it does run: a response containing a `contact_eli` tool call is not sent yet. `confirmThenCheck` in `src/llm.ts` gets one forced-choice question from `llm_contact.py confirm` and puts it to the same model with the same system prompt (no JSON schema, no thinking). If it answers "send to Eli and stop", gives no clear answer, or anything in this step fails, the original message goes through `check` unchanged. Only an explicit "it was a task remark, keep working" continues: the model is asked for its answer in the normal format, that answer is checked and used, and what it first said is appended to `LLMInbox/unconfirmed.jsonl` by `llm_contact.py unconfirmed` (kept, not notified). An `@ELI:` line is never questioned. The Agent SDK backend has no confirm step: every `contact_eli` call there is sent as before.

### Safety rails

Every tap and swipe the driver makes is gated on Bumble being the foreground app. Screens that look like your own profile, settings, or a Premium / Boost / coins purchase sheet are recognised as off-limits and only ever left with the Back key. Popup dismissal matches an explicit allowlist of "decline" labels (Not now, Maybe later, No thanks, Keep swiping…), never generic ones like Continue or OK. Like and Pass are tapped by their button, found by label in the lower half of the screen; if no button is found the card is swiped (on Bumble a horizontal swipe is the vote). A vote that doesn't advance the card is never retried blindly: the loop re-reads the screen and judges whatever is there. What you do by hand on the phone panel is not gated.

### Drafts are never lost

Every text box in the dashboard keeps what you typed. Settings boxes (guidance, device fields, numbers) auto-save to `data/settings.json` a moment after you stop typing, and a pending save is flushed with `keepalive` when the tab closes. Per-profile notes and estimates, the phone text box, the Google email and the APK paths are mirrored to the browser's `localStorage` on every keystroke (keys `bumble:draft:<field>:<decision id>`) and restored before the box is shown; they are cleared only when the server has accepted the text. The Google password is never stored.

### Tuning the driver

Bumble's Android UI was not in front of me while building this (the phone had no Google account yet), so the screen recognition in `src/bumble.ts` (`SELECTORS`) is heuristic: like/pass/SuperSwipe buttons by content-description or resource id, match / out-of-likes / logged-out screens by text patterns. Once Bumble is installed and logged in, press **Inspect screen** on a card and check that `likeButton` and `passButton` are found and `state` is `encounters`. If not, look through `nodes` for the real labels and extend the regexes. Then use **Review manually** for the first session: it scores each card and lets you do the swiping, so a wrong selector costs nothing. The manual **Like** / **Pass** buttons on the phone panel do one vote exactly the way a batch would, and the log says whether it went by button or gesture. `texts` in the inspect output shows exactly what the bot can read; photos are cropped from `ImageView` nodes, with the full screenshots as fallback.

### What counts as evidence

The prompt (`src/prompt.ts`) spells this out. In short:

- **Near-decisive**: a Vegan / Vegetarian / Plant-based Interest tag, or the bio saying so outright.
- **Strong (LR ~5–30×)**: animal-rights activism, named vegan restaurants/foods, jokes that presume vegetarianism. Pescatarian lands around 0.6.
- **Moderate (LR ~2–4×)**: climate activism or an Environmentalism cause, flexitarian/"mostly plant-based" (still short of the criterion), "only eat meat I know the source of".
- **Weak (LR ~1.2–2×, correlated)**: yoga, hiking, loves animals, crunchy aesthetic, progressive signals. Three of these together count as ~2–3× total, not 8×.
- **Against**: meat-centred food tags, meat in the bio or photos, "must love steak".
- Body type and "looking healthy" are explicitly excluded as evidence.

The intellectual exception is a separate, rare, high bar (top 1–2%): someone who gets curious rather than offended by a well-argued contrarian case. It fires at 60% or more of the model's own probability; flag reference cases with 🧠 to calibrate it.

## Files

| File | Purpose |
|---|---|
| `src/server.ts` | Entry point: Express API, static dashboard, `/ws` phone stream, SSE events, swipe / grade / note endpoints. Header comment says where config and logs live. |
| `src/swiper.ts` | The run loop: boot the device, open the deck, read each profile, judge it in up to two stages, swipe (auto) or wait for you (review); batch timing and breaks. |
| `src/bumble.ts` | `BumbleDriver`: screen recognition (`SELECTORS`), profile reading, voting by button or gesture, SuperSwipe with fallback, popup dismissal, image saving. |
| `src/classifier.ts` | The single judging call: builds the system prompt, sends text + screens, parses the answer, computes the arithmetic posterior, decides like / SuperSwipe / pass. |
| `src/prompt.ts` | The Bayesian classifier prompt with the intellectual exception, and the feedback block (your guidance, graded examples, reference cases). |
| `src/llm.ts` | `structuredCall`: one structured Claude call on the API or Agent SDK backend, plus the shared preamble, `contact_eli` tool, confirm step and inbox check. |
| `src/android.ts` | Thin ADB client: shell, UI dumps, taps, swipes, screenshots, text input. |
| `src/emulator.ts` | Finds, boots and stops the `bumble` AVD headlessly. |
| `src/screen.ts` | `ScreenStream`: streams the phone screen over the WebSocket and relays taps, drags and keys. |
| `src/setup.ts` | `SetupWizard`: Google sign-in, Play Store install of Bumble, APK sideload. |
| `src/location.ts` | Sets the emulator's GPS to the city chosen in Settings → Device. |
| `src/store.ts` | `data/decisions.jsonl` read/write, verdicts, notes, stats, feedback examples. |
| `src/config.ts` | `Settings` schema (zod) and `data/settings.json` load/update. |
| `src/paths.ts` | `DATA_DIR` (or `$BUMBLE_DATA_DIR`), photos, errors, settings and decisions paths. |
| `src/test-llm.ts` | `npm test`: scores one fake profile end to end without the phone; `--dry-run` checks the wiring and the confirm step for free. |
| `public/index.html`, `public/app.js`, `public/style.css` | The dashboard: Live tab (settings, on-screen card, recent, phone panel, setup) and Review tab (filters, grading, notes). |
| `scripts/emulator.sh` | One-time creation of the `bumble` AVD (Pixel 8, Android 15 with Play Store). |
| `scripts/install-app.sh`, `app/` | Build and install **Bumble Swiper.app**, a Dock launcher (`launcher.sh`, `Info.plist`, icon). |
| `.env.example` | Template for `.env` (`ANTHROPIC_API_KEY`, `PORT`). |
| `package.json`, `tsconfig.json` | Dependencies (see below) and TypeScript config; run with `tsx`, no build step. |

Why these dependencies: `express`/`ws` for the dashboard and phone stream, `sharp` for resizing screenshots and cropping photos, `zod` for settings and model output schemas, `@anthropic-ai/sdk` and `@anthropic-ai/claude-agent-sdk` for the two backends, `dotenv` for `.env`, `tsx` to run TypeScript directly.

## Runtime locations

- Project and installed copy: `~/Documents/agent-coding/bumble-swiper` (runs in place; `Bumble Swiper.app` in `/Applications` is only a launcher pointing here).
- Secrets: `.env` in the project (untracked; `.env.example` is the template).
- Settings: `data/settings.json`, edited from the dashboard sidebar.
- State: `data/decisions.jsonl` (every profile and decision), `data/photos/<id>/` (screens and crops), `data/errors/` (screenshots on failure). `BUMBLE_DATA_DIR` replaces `data/` wholesale. The whole `data/` folder is gitignored (personal).
- Logs: the dashboard's Live tab (also `GET /api/state` → `log`); `data/server.log` when started from the Dock launcher, stdout under `npm run dev`.
- Android: the `bumble` AVD under `~/.android/avd/`; platform tools and command-line tools from Homebrew; the SDK at `~/Library/Android/sdk`.
- LLM inbox (shared): `~/Library/Application Support/LLMInbox/messages.jsonl`, read with `llm-inbox`; tool calls the model chose not to send are in `unconfirmed.jsonl` beside it.

## Common tasks

Setup (once):

```bash
brew install --cask android-platform-tools android-commandlinetools   # if you don't have them
brew install openjdk@21
npm install
cp .env.example .env    # put your ANTHROPIC_API_KEY in .env (or set Backend to the Agent SDK in Settings and use your Claude Code login)
npm run emulator        # one time: creates the "bumble" device (Pixel 8, Android 15 with Play Store) and boots it once
```

Run, test, stop:

```bash
npm run dev                                   # dashboard at http://localhost:4949, reloads on source changes
npm start                                     # same, no reload (what the Dock launcher runs)
NO_OPEN=1 npm start                           # don't open the browser
npm run typecheck                             # tsc --noEmit
npm test -- --dry-run                         # free: preamble, contact_eli tool and llm_contact.py hook all wired; confirm step on stubbed replies (temp inbox)
npm test                                      # one fake vegan profile through the classifier with the current settings; no phone needed
npm test -- --backend api --model claude-haiku-5-5   # cheapest end-to-end check of the API path
npm test -- --contact                         # asks the model to call contact_eli; a test message lands in `llm-inbox list`
BUMBLE_DATA_DIR=/tmp/bumble-test npm run dev  # a clean data folder for trying things out
curl -s http://localhost:4949/api/debug/inspect | jq .   # what the bot can read on the phone right now
kill $(pgrep -f 'bumble-swiper/node_modules/.bin/tsx src/server.ts')   # stop a dashboard started by the launcher
tail -f data/server.log                       # launcher-started server log
llm-inbox list                                # messages the model sent to Eli; `llm-inbox show <id>` / `debrief <id>`
```

Open http://localhost:4949. The first time: Setup panel → Google sign-in → Install Bumble → log in on the phone panel. Then **Review manually** until the selectors are confirmed (see Tuning the driver), then **Start batch (auto)**. Stop with the **Stop** button or Ctrl-C in the terminal.

Dock launcher: `npm run install-app` builds **Bumble Swiper.app** in /Applications: a Dock launcher that starts the dashboard if needed and opens it in your browser (sources in `app/`). Open it once, then right-click its Dock icon → Options → Keep in Dock.

On this machine the `bumble` device already exists. `npm run dev` boots it headless if it isn't running; the phone keeps running (and stays logged in) when you quit, unless you turn on "Shut the emulator down" in Settings → Device. The `feeld` device of the Feeld swiper can run at the same time; each app picks its emulator by AVD name.

## Settings that matter

Dashboard sidebar, stored in `data/settings.json`:

| Setting | Default | Meaning |
|---|---|---|
| Like threshold | 0.50 | Swipe right when P(meets criteria) ≥ this |
| Intellectual exception | on | If the model's probability that a profile is exceptionally intelligent, intellectual, philosophical, thoughtful and open-minded reaches 60%, it's a like regardless of diet. Flag reference cases on cards with 🧠 |
| SuperSwipe | off, ≥ 0.90 | Profiles at or above the threshold get a SuperSwipe instead of a like. If the star opens a purchase or Compliment sheet, the app backs out and likes |
| Prior | 0.10 | Base rate of qualifying women in your pool. With a 10% prior the evidence needs a combined likelihood ratio of ~9× to reach 50% |
| Quick pass below | 15% | Two-stage judging. Stage one scores the text and the first screen; below this it passes right away. Otherwise it sends every screen and re-scores |
| Batch length | 10–150 min | Random session length per batch |
| After a batch | stop | Or take a random break (90–360 min) and start the next batch, only within active hours (9:00–23:00) |
| Max swipes / batch | 100 | Hard stop per batch |
| Delay between swipes | 2.5–7 s | Random pause after each swipe |
| Browse like a human | on | Uneven scroll pacing, double-takes, slow scroll back up before a like, faster flicks past quick passes |
| How to vote | buttons | Tap the like/pass buttons (swipe if they can't be found), or always swipe the card |
| Max screens sent to model | 6 | Evenly spaced screenshots of the profile; ~1k tokens each |
| Max scrolls per profile | 12 | How far down a profile it reads |
| Written reasoning | off | On adds a reasoning paragraph to each card at the cost of a couple of seconds per profile |
| Model / effort | claude-opus-5-5 / medium | Opus 5.5, Sonnet 5.5, Haiku 5.5, Opus 5, Sonnet 5, Haiku 4.5, Opus 4.8, Fable 5.1 |
| Backend | api | **Claude API**: the Anthropic SDK with the key in `.env`. **Claude Agent SDK**: Claude Code as a library, run as a subprocess with every tool switched off; by default without the API key so it uses this machine's Claude Code sign-in |
| Device | bumble | AVD name, emulator window on/off, stop on exit, a specific adb serial, and the city the emulator's GPS points at |

Outside the app:

- Android platform tools, command-line tools and OpenJDK 21 from Homebrew; the `bumble` AVD must exist (`npm run emulator`).
- The Agent SDK backend relies on this machine's Claude Code sign-in (`claude` login); the API backend on `ANTHROPIC_API_KEY` in `.env`.
- A Google account on the phone is needed to install Bumble from the Play Store (2-step verification is done on the phone panel).
- The LLM inbox needs `python3` on PATH and `../shared/` next to this folder (`~/Library/Application Support/LLMInbox/config.env` holds the email/ntfy settings; see `../shared/README.md`).
- nightblock closes `api.anthropic.com` from midnight to 6am. Continuous mode only starts batches inside the active hours, but a long batch that runs past midnight will see classifier errors until morning.

## Gotchas learned

- **Bumble's terms forbid automation.** Keep sessions modest; the batch and break settings exist for that.
- Emulators can trip Play Integrity checks. If Bumble refuses to run or log in on the emulator, a real Android phone with USB debugging works the same way (set its serial in Settings → Device).
- Bumble's Android UI labels in `src/bumble.ts` have not been checked against the real app yet (as of 2026-11-09 the phone has no Google account and Bumble is not installed). The first real session should be **Review manually** plus **Inspect screen**; see Tuning the driver. In particular, if `likeButton` is null the vote falls back to a swipe gesture, which is a real vote on Bumble.
- Two consecutive cards with the same name and age are told apart by the text on their first screen, so a successful vote is never mistaken for a stuck card. If a vote does not advance the card, the decision is marked skipped and the loop re-reads the screen rather than tapping again.
- Reading a profile takes 10–25 s (a UI dump is ~1 s, plus human-like pauses). The phone panel streams at 2–8 fps depending on what's on screen.
- Cost: roughly 4–10k input tokens per profile with 6 screens; a few cents on Opus. The system prompt is cached.
- `uiautomator dump` can hang on an emulator that is busy; the client retries three times and then falls back to dumping to a file.
- Profiles the model declines to evaluate are recorded as "skipped" and passed in auto mode, since you only want likes on qualifying profiles.
- Under structured output the response is one JSON block, so the preamble's `@ELI:` line marker cannot appear; the `contact_eli` tool is the live channel. `llm_contact.py` still scans text blocks.
- The confirm step exists only on the API backend. The Agent SDK harness answers the `contact_eli` call itself inside its own loop and offers neither a forced tool choice nor a way to replay the exchange with a different tool result, so the shared protocol cannot be run there; on that backend a routine remark made through the tool still stops the task and reaches Eli.
- The confirm question must be asked without the JSON output format and without thinking (a forced tool choice cannot be combined with thinking), so `viaApi` makes that one call with `messages.create`, not `messages.parse`. It costs one short extra call, and one more full call if the model keeps working, only when the tool was called; the usage reported for that profile is the follow-up call's alone.
- Read `~/Library/Application Support/LLMInbox/unconfirmed.jsonl` now and then: it holds what models said in tool calls they then called task remarks, and is the audit that the confirm step is not swallowing real messages.
- Tests that run `llm_contact.py` must set `LLM_INBOX_DIR` to a temp folder (records land there, nothing is notified). `--dry-run` does this itself; for `--contact`, which otherwise sends Eli a real test message, prefix the command with `LLM_INBOX_DIR=$(mktemp -d)`. With the confirm step, `--contact` on the API backend with `--model claude-haiku-4-5` may also end with the model choosing not to send.
- On the Agent SDK path the harness prefixes MCP tool names (`mcp__eli__contact_eli`); `src/llm.ts` renames the block back to `contact_eli` before the inbox check.
- `loadSettings()` drops only the invalid keys when `data/settings.json` fails the schema (the Tinder swiper reset everything in that case). Widen the schema in `src/config.ts` and the matching `max` in `public/index.html` together.
- Haiku 4.5 predates adaptive thinking and the effort parameter; `src/llm.ts` leaves both out for it.
- The guided Google sign-in can get stuck tapping the same button when Google wants something it cannot see (seen in the first version's logs). If the Setup panel says "working…" for more than a minute with no progress, finish that step on the phone panel; the wizard resumes once the screen changes.
- After the server restarts, adb restarts too and a running emulator is listed as "offline" for a second; the boot wait accepts any online emulator running the `bumble` AVD, so a restart does not burn the boot timeout.
- The project started as a Chrome/web-client bot before Bumble went app-only, then as a keyword filter over ADB (`vegan` / `vegetarian` / `plant-based` in the profile text). Both are in the git history; `data/chrome-profile/` and the old smoke logs under `data/` are leftovers.
