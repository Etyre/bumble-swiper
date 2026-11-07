// Starts / stops the Android emulator so the phone runs invisibly in the background.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function sdkRoot() {
  for (const c of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(os.homedir(), 'Library/Android/sdk'), path.join(os.homedir(), 'Android/Sdk')]) {
    if (c && fs.existsSync(path.join(c, 'emulator', 'emulator'))) return c;
  }
  return null;
}

export function avdExists(name) {
  return fs.existsSync(path.join(os.homedir(), '.android', 'avd', `${name}.avd`));
}

/**
 * Boots the AVD headless if no device is connected. Resolves when Android reports boot completed.
 * @returns {Promise<{started:boolean, proc?:import('node:child_process').ChildProcess}>}
 */
export async function ensureEmulator({ client, avdName, headless = true, log = () => {}, timeoutMs = 240000 }) {
  if (await client.ensureDevice()) return { started: false };
  const root = sdkRoot();
  if (!root) {
    log('Android emulator not found. Run "npm run emulator" once to install it, or plug in a phone.');
    return { started: false };
  }
  if (!avdExists(avdName)) {
    log(`Virtual device "${avdName}" does not exist. Run "npm run emulator" once to create it.`);
    return { started: false };
  }
  const args = ['-avd', avdName, '-no-audio', '-no-boot-anim', '-no-metrics'];
  if (headless) args.push('-no-window');
  log(`Starting emulator "${avdName}"${headless ? ' in the background' : ''}…`);
  const proc = spawn(path.join(root, 'emulator', 'emulator'), args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, ANDROID_HOME: root, ANDROID_SDK_ROOT: root },
  });
  proc.unref();

  const start = Date.now();
  let lastNote = 0;
  while (Date.now() - start < timeoutMs) {
    await sleep(3000);
    if (await client.ensureDevice()) {
      const booted = await client.shell('getprop sys.boot_completed').catch(() => '');
      if (booted.trim() === '1') {
        log(`Emulator ready after ${Math.round((Date.now() - start) / 1000)}s.`);
        await sleep(3000); // let the launcher settle
        return { started: true, proc };
      }
    }
    if (Date.now() - lastNote > 20000) { lastNote = Date.now(); log('Emulator still booting…'); }
  }
  log('Emulator did not finish booting in time.');
  return { started: false };
}

export async function stopEmulator(client, log = () => {}) {
  if (!client.device || !/^emulator-/.test(client.device.serial)) return;
  log('Stopping emulator (state is saved for a fast restart)…');
  await client.adb(['emu', 'kill']).catch(() => {});
}
