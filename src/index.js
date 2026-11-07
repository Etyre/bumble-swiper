// Bumble Swiper: entry point. Drives the real Bumble Android app (headless emulator or a phone over
// ADB), reads each profile through the accessibility tree, likes profiles that match the configured
// keywords (vegan / vegetarian / plant-based by default) and passes on the rest. Serves the dashboard
// at http://127.0.0.1:<port> (default 3777) from public/index.html.
//
// Run:    npm start            (boots the "bumble" AVD invisibly if no device is connected)
// Test:   npm test             (filter + server self-test, no emulator or adb needed)
// Config: ./config.json        (untracked; template in config.example.json; edited via the dashboard)
// State:  ./data/stats.json    (daily counters) and ./data/decisions.jsonl (every decision)
// Logs:   printed to the terminal and shown in the dashboard Log panel; nothing is written to a log
//         file unless you redirect stdout (e.g. npm start > data/app.log).
import { exec } from 'node:child_process';
import fs from 'node:fs';
import { loadConfig, PATHS } from './config.js';
import { AndroidClient, BUMBLE_PACKAGE } from './android.js';
import { Runner } from './runner.js';
import { SetupWizard } from './setup.js';
import { ScreenStream } from './screen.js';
import { ensureEmulator, stopEmulator } from './emulator.js';
import { startServer } from './server.js';

let config = loadConfig();
const getConfig = () => config;

fs.mkdirSync(PATHS.data, { recursive: true });

const client = new AndroidClient(config);
const runner = new Runner(client, getConfig);
const wizard = new SetupWizard(client, (m) => runner.log(m));
const screen = new ScreenStream(client);
const setConfig = (c) => { config = c; client.serial = c.deviceSerial || client.serial; client.maxProfileScrolls = c.maxProfileScrolls; };

const server = await startServer({ runner, client, wizard, screen, getConfig, setConfig, port: config.port });
const dashboardUrl = `http://127.0.0.1:${config.port}`;
runner.log(`Dashboard: ${dashboardUrl}`);
if (process.platform === 'darwin' && !process.env.NO_OPEN) exec(`open ${dashboardUrl}`);

let startedEmulator = false;

async function bringUpDevice() {
  if (!client.adbPath) {
    runner.log('adb was not found. Install it with: brew install --cask android-platform-tools');
    return;
  }
  let dev = await client.ensureDevice();
  if (!dev && config.autoStartEmulator) {
    const r = await ensureEmulator({ client, avdName: config.avdName, headless: config.emulatorHeadless, log: (m) => runner.log(m) });
    startedEmulator = r.started;
    dev = await client.ensureDevice();
  }
  if (!dev) {
    runner.log('No Android device yet. It will be picked up automatically when one appears.');
    return;
  }
  runner.log(`Device: ${dev.serial}${dev.model ? ` (${dev.model})` : ''}, screen ${client.size.w}x${client.size.h}`);
  runner.emit('state', runner.snapshot());
  const status = await wizard.refresh();
  if (!status.googleAccount) {
    runner.log('Setup needed: use the Setup panel on the dashboard to sign in to Google and install Bumble.');
  } else if (!status.bumbleInstalled) {
    runner.log(`Google account ${status.googleAccount} is signed in. Use the Setup panel to install Bumble.`);
  } else {
    const fg = await client.foregroundPackage().catch(() => '');
    if (fg !== BUMBLE_PACKAGE) {
      runner.log('Opening Bumble…');
      await client.goToEncounters().catch((e) => runner.log(`Could not open Bumble: ${e.message}`));
    }
    runner.log('Bumble is ready. Log in if needed (on the phone screen), then press Start (dry run first).');
  }
}

bringUpDevice().catch((e) => runner.log(`Device setup error: ${e.message}`));

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nShutting down…');
  await runner.stop().catch(() => {});
  if (startedEmulator && config.stopEmulatorOnExit) await stopEmulator(client, (m) => console.log(m));
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
