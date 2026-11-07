# Bumble Swiper

A local app that swipes on Bumble for you, based on keyword filters. By default it **likes profiles that
mention vegan, vegetarian or plant-based** (in an interest chip, badge, bio or prompt) and passes on everything else.
Built 2 September 2026. Bumble shut down its web client ("Bumble is now app-only"), and App Store apps cannot run in an
emulated iPhone, so this app drives the **real Bumble Android app** running in an **Android emulator**
(or on a real Android phone) through ADB. It reads each profile through Android's accessibility tree,
decides, and taps/swipes on your behalf. A browser dashboard shows the device screen, every decision, and lets
you tune the filters. Your Bumble account is the same on every platform, so logging in on Android with your
phone number gives you your existing profile and matches.

> **Heads-up:** automation is against Bumble's terms of service and can get an account restricted or banned.
> The app defaults to a dry run, uses random human-like delays, and enforces daily caps to keep activity
> modest. Use at your own risk.

## How it works

`npm start` boots the virtual phone **invisibly in the background**, opens the dashboard at
`http://127.0.0.1:3777`, and shuts the phone down again when you quit. You never touch the emulator
window: the dashboard shows the live phone screen and forwards your clicks, drags and typing to it.

- `src/emulator.js` boots/stops the AVD headless. `src/screen.js` streams screenshots (~6 fps) over the
  WebSocket and turns dashboard clicks/keys into `input tap|swipe|text|keyevent`. `src/setup.js` is the
  guided Google sign-in / Play Store install flow.
- `src/android.js` talks to the device with `adb`: `uiautomator dump` for the screen's accessibility tree
  (all visible text, content descriptions, buttons), `input tap` / `input swipe` for actions, `screencap` for the
  dashboard preview. It detects the app state (logged out, match overlay, out of swipes, Bumble not in front).
- `src/filter.js` turns the collected profile text into a LIKE / PASS decision.
- `src/runner.js` is the loop: read the top of the card, scroll through and collect everything, decide, wait a
  random delay, act, wait for the next card.
- `src/server.js` + `public/index.html` are the dashboard (Express + WebSocket).
- `src/selectors.js` holds every label/pattern used to recognise buttons and screens.

Dependencies (the only two): `express` serves the dashboard and JSON API, `ws` carries the live screen and
events. Everything else is Node's standard library plus the `adb` and `emulator` binaries from the Android SDK.

### The dashboard

**Phone panel (left).** A live view of the emulated phone. Click to tap, drag to swipe, and type when the
panel has focus (click it first). Back / Home / Recents buttons and a "type text" box are underneath.

**Setup panel (middle, top).** A checklist that gets you from an empty phone to a logged-in Bumble:
1. *Emulator running* happens automatically.
2. *Google account*: enter your Google email and password and press **Sign in to Google & install Bumble**.
   The app opens the Play Store, fills in the login, taps through Google's prompts, installs Bumble and opens
   it. Credentials are sent only to this local app and used once; they are never written to disk. If Google
   asks for 2-step verification, a code, or a captcha, do that on the phone panel; the setup resumes by itself.
3. *Bumble installed* is done by the same flow (or by **Install Bumble** if Google was already signed in).
4. *Logged in to Bumble*: Bumble's own login (phone number + SMS code) is done on the phone panel.

**Swiping.** Leave **Dry run** on, press **Start swiping**. The app scrolls through each profile, shows LIKE / PASS
with the matched terms and the badges/interests it found, then waits for you to swipe on the phone panel.
Once the decisions look right, press **Inspect screen** once on a profile and check that `likeButton` /
`passButton` were found (if not, the swipe-gesture fallback is used), then turn **Dry run** off, save, and Start.

**Drafts.** Everything you type into the dashboard (filter terms, exclude phrases, delays, caps, the
send-to-phone box, the Google email) is saved to the browser's `localStorage` on every keystroke and restored
when the page reloads, so an unsaved edit is never lost. A draft is cleared only when **Save settings**
succeeds (or the text is sent / the account is signed in). The Google password is never persisted.

## Files

| File | Purpose |
|---|---|
| `src/index.js` | Entry point: loads config, starts the server, brings up the device/emulator, handles Ctrl+C shutdown. |
| `src/config.js` | Default settings, `config.json` load/save and validation (`normalize`), and the `PATHS` used everywhere. |
| `src/server.js` | Express + WebSocket dashboard: JSON API (`/api/state`, `/api/config`, `/api/action`, `/api/setup/*`, `/api/inspect`), live events. |
| `src/runner.js` | The swipe loop, daily counters (`data/stats.json`) and the decision log (`data/decisions.jsonl`). |
| `src/android.js` | ADB client: device discovery, `uiautomator dump` parsing, taps/swipes, screenshots, app-state detection. |
| `src/filter.js` | `evaluate(profile, config)`: LIKE / PASS from terms, exclude phrases and `matchIn`. |
| `src/selectors.js` | Regexes for Bumble's buttons, navigation, popups and screen states. Edit here when Bumble's UI changes. |
| `src/screen.js` | Streams device screenshots to the dashboard and turns clicks/keys into device input. |
| `src/setup.js` | Guided Google sign-in, Play Store install of Bumble, and launch. |
| `src/emulator.js` | Finds the Android SDK, boots the AVD headless, stops it on exit. |
| `public/index.html` | The single-page dashboard (HTML + CSS + JS, no build step). |
| `scripts/emulator.sh` | One-time: installs the emulator + Play Store system image, creates the `bumble` AVD, boots it with a window. |
| `scripts/selftest.js` | `npm test`: checks the filter and the dashboard server with a fake device; needs no emulator, adb or account. |
| `config.json` | Your real settings (untracked). Created from the defaults on first save from the dashboard. |
| `config.example.json` | Committed template for `config.json` with the default values. |
| `package.json` | `npm start`, `npm run emulator`, `npm test`; dependencies `express` and `ws`. |

## Runtime locations

| What | Where |
|---|---|
| Config | `./config.json` in the project folder (defaults in `src/config.js`; template `config.example.json`). Saved by the dashboard's **Save settings**. |
| Daily counters | `./data/stats.json` (seen / liked / passed / matches for today; reset when the date changes). |
| Decision log | `./data/decisions.jsonl`, one JSON line per evaluated profile. |
| Logs | Printed to the terminal that ran `npm start` and shown in the dashboard **Log** panel (last 300 lines). No log file is written unless you redirect stdout, e.g. `npm start > data/app.log`. |
| Dashboard | `http://127.0.0.1:3777` (port is `port` in config). Bound to localhost only. |
| Android SDK | `~/Library/Android/sdk` (`$ANDROID_HOME`), or wherever Homebrew's `android-commandlinetools` put it; `emulator/emulator` and `platform-tools/adb` live under it. |
| Virtual device | `~/.android/avd/bumble.avd` (name is `avdName` in config), with its `config.ini`. |
| Dashboard drafts | The browser's `localStorage` under keys `bumble-swiper:dashboard:draft:<field>`. |
| `data/` | Everything above plus old smoke logs, screenshots and a leftover `chrome-profile/` from the pre-Android web version. All gitignored. |

## Common tasks

Install the toolchain and create the virtual device (one time):

```bash
brew install --cask android-platform-tools android-commandlinetools   # adb + SDK tools
brew install openjdk@21                                              # Java for the SDK tools
npm install
npm run emulator      # one time: downloads the emulator + Play Store image (~1.5 GB), creates the "bumble" device, boots it
```

Once the device exists you can close that emulator window (or press Ctrl+C). From then on:

```bash
npm start                              # boots the phone headless, opens the dashboard
NO_OPEN=1 npm start                    # same, without opening the browser
npm start > data/app.log 2>&1          # keep a log file
```

Test without an emulator, adb or a Bumble account (filter rules + the dashboard server with a fake device):

```bash
npm test
```

Test against the real app safely: leave **Dry run** on in the dashboard (it is on by default); decisions are
shown but nothing is swiped. **Inspect screen (diagnostics)** dumps what the bot can read on the current screen.

Stop: Ctrl+C in the terminal stops everything. The device and Bumble keep running, except that an emulator
this app booted itself is shut down again when `stopEmulatorOnExit` is true (the default).

Reset the daily counters: stop the app and delete `data/stats.json`.

Start from a fresh config: delete `config.json` (or copy `config.example.json` over it); the defaults are used
and written back on the first save.

## Settings that matter

The dashboard's **Filter** section and `config.json`:

| Setting | Meaning |
|---|---|
| Like terms | Words/phrases that trigger a like. Case-insensitive, whole-word, hyphen and space equivalent (`plant-based` = `plant based`). |
| Exclude phrases | If one of these appears, the profile is not liked even if a term matched (default catches "not vegan", "non-vegetarian"). |
| Where to look | *Anywhere* = chips + bio + prompts. *Badges only* = just short chip-like strings (stricter). |
| When a profile does not match | Swipe left, or leave it on screen for you. |
| Scroll through profile | Must stay on to see badges/bio below the first screen. |
| Delay | Random wait before each swipe. |
| Daily caps | The app stops itself when reached. Counters reset daily and are stored in `data/stats.json`. |
| Swipe method | Tap the like/pass buttons (with swipe-gesture fallback), or gesture only. |

`config.json` additionally has `avdName`, `autoStartEmulator`, `emulatorHeadless` (set to `false` to get the
emulator window back) and `stopEmulatorOnExit`, plus `deviceSerial` (an `adb devices` serial, empty = first
device), `adbPath` (empty = auto-detect), `maxProfileScrolls`, `outOfSwipesPauseMinutes` and `port`.
Every decision is appended to `data/decisions.jsonl`.

Outside the project:

- **Java**: the SDK tools need `openjdk@21` (or 17); `scripts/emulator.sh` finds it under `/opt/homebrew/opt`.
- **Real phone instead of the emulator**: enable Developer options and USB debugging on the phone and accept the
  computer's debugging key; the dashboard drives it the same way and the emulator is skipped.
- **Google account on the emulator**: 2-step verification / captcha prompts have to be completed on the phone panel.

## Gotchas learned

- Bumble's Android UI changes over time. If **Inspect screen** shows `likeButton: null`, look through the `nodes`
  list for the like/pass controls (their `desc`, `text` or `id`) and extend the regexes in `src/selectors.js`.
  The `texts` list shows exactly what the bot can read on the current screen; if the badges you care about are
  missing, they are probably below the fold, which is why the profile scroll must stay enabled.
- `uiautomator dump` takes about a second per screen, so reading a long profile takes 5–10 s. That is fine; it looks human.
- If Bumble shows "out of likes / swipes", the app pauses for `outOfSwipesPauseMinutes` and then checks again.
- Emulators can trip Bumble's device checks (Play Integrity). If login fails in the emulator, a real phone over USB is the fallback.
- A real Android phone (USB debugging on) works too; the dashboard drives it the same way and the emulator is skipped.
- The guided Google sign-in can get stuck tapping the same button: an early log (`data/smoke4.log`) shows it
  pressing "Sign in" every 5 s for several minutes when Google wanted something it could not see. If the Setup
  panel says "working…" for more than a minute with no progress, look at the phone panel and finish that step
  by hand; the wizard resumes once the screen changes.
- Node prints `MaxListenersExceededWarning ... 11 close listeners added to [WebSocket]` after the dashboard
  has been reconnected many times (each subscribe adds a close listener in `src/screen.js`). It is harmless noise.
- The project started as a Chrome/web-client bot before Bumble went app-only; `data/chrome-profile/` (~15 MB)
  and `PATHS.chromeProfile` are leftovers from that and are unused now.
- Everything under `data/`, plus `config.json`, is gitignored. `config.example.json` is the committed template.
