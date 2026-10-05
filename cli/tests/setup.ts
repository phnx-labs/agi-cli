import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll } from 'vitest';
import { shouldArmHermeticGuards } from './hermetic-guards.js';
import { assertNoUnauthorizedOpenerSpawn, installOpenerSandbox } from './opener-sandbox.js';

const realHome = process.env.HOME ?? os.homedir();
const realUserAgentsDir = path.join(realHome, '.agents');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-vitest-'));

const sandboxHome = path.join(tmp, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
process.env.AGENTS_REAL_HOME = sandboxHome;

installOpenerSandbox({ tmp });

process.env.AGENTS_SECRETS_AGENT_DIR = path.join(tmp, 'secrets-agent');
process.env.AGENTS_SECRETS_NO_AGENT = '1';

process.env.SECRETS_NO_AGENT = '1';
process.env.SECRETS_PASSPHRASE = 'agents-vitest-file-store';

process.env.AGENTS_NO_USAGE_TRACK = '1';

delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

process.env.AGENTS_EVENTS_PATH = path.join(tmp, 'events.jsonl');

process.env.AGENTS_DEVICES_DIR = path.join(tmp, 'devices');


process.env.AGENTS_HOOK_SHIMS_DIR = path.join(tmp, 'hook-shims');
process.env.AGENTS_HOOK_CACHE_DIR = path.join(tmp, 'hook-cache');
process.env.AGENTS_LOGS_DIR = path.join(tmp, 'logs');
process.env.AGENTS_PERF_DIR = path.join(tmp, 'perf');
process.env.AGENTS_STATE_DIR = path.join(tmp, 'state');

const realEventsLog = path.join(realUserAgentsDir, 'events.jsonl');
const sizeBefore = fs.existsSync(realEventsLog) ? fs.statSync(realEventsLog).size : 0;

const realDevicesRegistry = path.join(realUserAgentsDir, '.history', 'devices', 'registry.json');
const devicesRegistryBefore: string | null = fs.existsSync(realDevicesRegistry)
  ? fs.readFileSync(realDevicesRegistry, 'utf-8')
  : null;

const realDevicesPending = path.join(realUserAgentsDir, '.cache', 'state', 'devices-pending');
const devicesPendingBefore: string | null = fs.existsSync(realDevicesPending)
  ? fs.readdirSync(realDevicesPending).sort().join(',')
  : null;

function snapshotTopLevel(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).sort().map((name) => {
    const st = fs.statSync(path.join(dir, name));
    return `${name}:${st.size}:${st.mtimeMs}`;
  }).join('|');
}
const userAgentsTopLevelBefore = snapshotTopLevel(realUserAgentsDir);

const realClaudeSettings = path.join(realHome, '.claude', 'settings.json');
const claudeSettingsBefore = fs.existsSync(realClaudeSettings)
  ? fs.statSync(realClaudeSettings).mtimeMs
  : null;

afterAll(() => {
  try {
    assertNoUnauthorizedOpenerSpawn();

    if (shouldArmHermeticGuards(process.env)) {
      const sizeAfter = fs.existsSync(realEventsLog) ? fs.statSync(realEventsLog).size : 0;
      if (sizeAfter > sizeBefore) {
        throw new Error(
          `hermeticity leak (#910): the real events log grew by ${sizeAfter - sizeBefore} bytes ` +
          `during this test file (${realEventsLog}). Some code path bypassed AGENTS_EVENTS_PATH.`,
        );
      }

      const devicesRegistryAfter = fs.existsSync(realDevicesRegistry)
        ? fs.readFileSync(realDevicesRegistry, 'utf-8')
        : null;
      if (devicesRegistryAfter !== devicesRegistryBefore) {
        throw new Error(
          `hermeticity leak (RUSH-2042): the real device registry (${realDevicesRegistry}) ` +
          `changed during this test file — a test wrote to it instead of the fork-private ` +
          `AGENTS_DEVICES_DIR. Set AGENTS_DEVICES_DIR (or use the setup default) before ` +
          `importing any state consumer.`,
        );
      }

      const pendingAfter = fs.existsSync(realDevicesPending)
        ? fs.readdirSync(realDevicesPending).sort().join(',')
        : null;
      if (pendingAfter !== devicesPendingBefore) {
        throw new Error(
          `hermeticity leak: the real devices-pending sentinels (${realDevicesPending}) ` +
          `changed during this test file — a test wrote the menu bar's "NEW DEVICES" state ` +
          `instead of the fork-private AGENTS_STATE_DIR. Because AGENTS_DEVICES_DIR makes the ` +
          `registry and ignore list read EMPTY under test, the leaking path marks every ` +
          `tailnet node as new and the operator's ignore list appears to have been lost.`,
        );
      }

      const userAgentsTopLevelAfter = snapshotTopLevel(realUserAgentsDir);
      if (userAgentsTopLevelAfter !== userAgentsTopLevelBefore) {
        throw new Error(
          `hermeticity leak (RUSH-2639): the real user dir (${realUserAgentsDir}) gained, lost, ` +
          `or modified a top-level entry during this test file. Some code path resolved a HOME-` +
          `derived path against the real HOME instead of the fork-private sandbox HOME set at the ` +
          `top of tests/setup.ts. Before: ${userAgentsTopLevelBefore}. After: ${userAgentsTopLevelAfter}.`,
        );
      }

      const claudeSettingsAfter = fs.existsSync(realClaudeSettings)
        ? fs.statSync(realClaudeSettings).mtimeMs
        : null;
      if (claudeSettingsAfter !== claudeSettingsBefore) {
        throw new Error(
          `hermeticity leak (RUSH-2639): the real Claude settings (${realClaudeSettings}) changed ` +
          `during this test file — a test wrote hook entries into the developer's REAL settings.json ` +
          `instead of a fork-private version home. Set HOME (or use the setup default) before ` +
          `importing any hook-registration or agent-install code path.`,
        );
      }
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {  }
  }
});
