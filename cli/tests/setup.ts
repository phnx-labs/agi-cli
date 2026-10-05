/** Fork-level hermeticity (#910): runs in every fork before test imports, so the env it pins is what
 * state.ts, secrets/agent.ts and events.ts capture. Without it, runs wrote fixture events into the
 * real log and hit the real broker. Defaults, not a cage; tests may override and restore. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll } from 'vitest';
import { shouldArmHermeticGuards } from './hermetic-guards.js';
import { assertNoUnauthorizedOpenerSpawn, installOpenerSandbox } from './opener-sandbox.js';

// The REAL developer home, captured before anything below overrides it — the
// baseline every leak tripwire in this file compares against.
const realHome = process.env.HOME ?? os.homedir();
const realUserAgentsDir = path.join(realHome, '.agents');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-vitest-'));

// RUSH-2639: state.ts, agents.ts, hooks.ts and shims.ts capture HOME at import, so per-path escape
// hatches only cover past leaks. Redirecting HOME itself (USERPROFILE on win32) makes escape
// structurally impossible. Must run before the file's own imports; spawned children inherit it.
const sandboxHome = path.join(tmp, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
// Pin AGENTS_REAL_HOME too: paths distinguish an agent's isolated HOME from the installation home
// with it, and login shells or service managers may restore HOME but still inherit
// AGENTS_REAL_HOME.
process.env.AGENTS_REAL_HOME = sandboxHome;

// PHNX-3072: sandbox desktop openers at the fork boundary like HOME. A real
// spawn('open'|'xdg-open') hit the developer's binary (open-url.test.ts, fixed in #2937). PATH
// stubs catch it; the afterAll tripwire fails unless AGENTS_TEST_ALLOW_OPENER=1.
installOpenerSandbox({ tmp });

// Broker: pin the socket dir to a fork-private temp path so neither this fork nor its CLI
// subprocesses can reach the user's real broker socket, and default the broker client integration
// off (see bundles.ts).
process.env.AGENTS_SECRETS_AGENT_DIR = path.join(tmp, 'secrets-agent');
process.env.AGENTS_SECRETS_NO_AGENT = '1';

// The standalone `secrets` CLI (PHNX-3989) reads SECRETS_* knobs: no broker in a fork, and a
// deterministic file-store passphrase so a headless box routes keychain items to the encrypted file
// store. Its state root defaults to the sandboxed HOME; useFreshSecretsHome isolates per test.
process.env.SECRETS_NO_AGENT = '1';
process.env.SECRETS_PASSPHRASE = 'agents-vitest-file-store';

// Usage stamping writes bundle metadata back to the secret store on reads.
process.env.AGENTS_NO_USAGE_TRACK = '1';

// A developer box exporting CLAUDE_CODE_OAUTH_TOKEN (mac-mini) changes what view.ts prints for a
// version with no login, so logged-out assertions failed there only, blocking the release gate.
// Clear it by default; tests of ambient-token behavior set and restore it.
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

// Events: redirect the sink to a fork-private file. Redirect, not disable —
// events.test.ts / logs.test.ts assert on written content and re-point the
// sink themselves via _resetForTest, which takes precedence over this env.
process.env.AGENTS_EVENTS_PATH = path.join(tmp, 'events.jsonl');

// Devices registry (RUSH-2042): redirect the registry and ignore-list dir to a fork-private temp so
// tests never write fixture devices into the real ~/.agents/.history/devices. state.ts reads it at
// call time; tests may override AGENTS_DEVICES_DIR. HOME stays untouched.
process.env.AGENTS_DEVICES_DIR = path.join(tmp, 'devices');

// AGENTS_DAEMON_DIR is deliberately NOT set globally: tests spawning a real daemon isolate via a
// unique HOME, and a global value would be inherited by those children and collide on the
// single-instance guard. daemon-self-heal.test.ts sets it file-scoped.

// Hook shims/cache/logs and perf warehouse: every hook resolves through a generated shim, so
// in-process registrar tests (most of hooks.test.ts) would write real shims, caches, logs and perf
// samples into ~/.agents/.cache. Read at call time by state.ts; never set in production.
process.env.AGENTS_HOOK_SHIMS_DIR = path.join(tmp, 'hook-shims');
process.env.AGENTS_HOOK_CACHE_DIR = path.join(tmp, 'hook-cache');
process.env.AGENTS_LOGS_DIR = path.join(tmp, 'logs');
process.env.AGENTS_PERF_DIR = path.join(tmp, 'perf');
// Runtime state (~/.agents/.cache/state/) holds the devices-pending sentinels the menu bar shows as
// "NEW DEVICES". With the registry in tmp it reads empty, so reconcilePendingSentinels called every
// tailnet node new and wrote sentinels into the live dir (20 nodes on a dev machine).
process.env.AGENTS_STATE_DIR = path.join(tmp, 'state');

// Leak tripwire: the REAL events log must not grow while this fork runs.
// CI-only — on a dev machine live agents append to it concurrently, so the
// check would false-positive locally; CI homes are quiet.
const realEventsLog = path.join(realUserAgentsDir, 'events.jsonl');
const sizeBefore = fs.existsSync(realEventsLog) ? fs.statSync(realEventsLog).size : 0;

// Leak tripwire (RUSH-2042): the real device registry must not change while this fork runs. On CI
// any change is a hermeticity breach (full content compare, no allowlist); on a dev machine live
// fleet agents may update it, so CI-only.
const realDevicesRegistry = path.join(realUserAgentsDir, '.history', 'devices', 'registry.json');
const devicesRegistryBefore: string | null = fs.existsSync(realDevicesRegistry)
  ? fs.readFileSync(realDevicesRegistry, 'utf-8')
  : null;

// Leak tripwire: the real devices-pending sentinels must not change during this fork. CI-only,
// since a live daemon probe reconciles this dir every ~3 min. AGENTS_STATE_DIR is the actual fix;
// this catches paths that resolve the dir another way.
const realDevicesPending = path.join(realUserAgentsDir, '.cache', 'state', 'devices-pending');
const devicesPendingBefore: string | null = fs.existsSync(realDevicesPending)
  ? fs.readdirSync(realDevicesPending).sort().join(',')
  : null;

// Leak tripwire (RUSH-2639): shallow fingerprint (name, size, mtime) of every direct child of the
// real ~/.agents, catching a write anywhere under it without naming the path. CI-only like the
// others, since a dev box's live daemon may touch it.
function snapshotTopLevel(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).sort().map((name) => {
    const st = fs.statSync(path.join(dir, name));
    return `${name}:${st.size}:${st.mtimeMs}`;
  }).join('|');
}
const userAgentsTopLevelBefore = snapshotTopLevel(realUserAgentsDir);

// Leak tripwire (RUSH-2639): the native Claude config (~/.claude/settings.json) lives outside
// ~/.agents; a hook-registration test resolving a version home from the real HOME once wrote
// fixture hooks into the developer's real Claude settings.
const realClaudeSettings = path.join(realHome, '.claude', 'settings.json');
const claudeSettingsBefore = fs.existsSync(realClaudeSettings)
  ? fs.statSync(realClaudeSettings).mtimeMs
  : null;

afterAll(() => {
  try {
    // PHNX-3072: local, not CI-only. The opener leak was invisible on Linux CI (no xdg-open) and
    // only hurt developers; "did this fork spawn a desktop opener" cannot be false-positived by a
    // live daemon.
    assertNoUnauthorizedOpenerSpawn();

    // RUSH-3007: these tripwires assume "CI" is a quiet single-tenant runner.
    // release-attestation-produce.sh set CI=true for the longer hookTimeout and false-failed
    // 129/129 files on a green run. shouldArmHermeticGuards() excludes its opt-in flag.
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
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
