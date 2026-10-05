/**
 * Fork-level hermeticity (#910). vitest runs pool:'forks' — this file executes
 * in every fresh fork BEFORE the test file's imports, so the env it pins is
 * what state.ts / secrets/agent.ts / events.ts capture. Without it, a suite
 * run on a dev machine wrote test-fixture `secrets.get` events into the user's
 * real events log and reached the user's real secrets-agent broker (wiping
 * every unlocked bundle pre-#909).
 *
 * These are the DEFAULT posture, not a cage: tests that need a specific
 * posture (a live temp broker, event-content assertions, usage-stamp checks)
 * still override per-test and restore, exactly as they do today — the saved
 * "previous" value they restore is simply the hermetic default.
 */
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

// RUSH-2639: state.ts (`const HOME = process.env.HOME ?? os.homedir()`,
// state.ts:37) and several sibling modules (agents.ts:38 `const HOME =
// os.homedir()`, hooks.ts, shims.ts) capture HOME as a MODULE-LEVEL constant
// at import time. Every per-directory escape hatch below (AGENTS_DEVICES_DIR
// etc.) only covers the specific spot that has already leaked once; it does
// nothing for the dozens of other HOME-derived paths (~/.agents/hooks,
// ~/.agents/routines, ~/.claude/settings.json, …) a test never anticipated.
// Redirecting HOME itself — the ONE thing every one of those constants is
// computed from — makes it structurally impossible for anything in this fork
// to resolve into the real home, instead of catching leaks one path at a time
// after the fact. This must run BEFORE the test file's own imports (setup
// files do, in every fork) so state.ts/agents.ts/etc. capture the sandbox,
// not the real HOME. On POSIX, os.homedir() itself reads $HOME, so this also
// covers every call site that reaches for os.homedir() directly rather than
// process.env.HOME. On win32, os.homedir() reads USERPROFILE, so that is
// pinned too — the pair is what keeps this fork's HOME resolution consistent
// across platforms.
//
// This is also what closes the "dangling /tmp/agents-vitest-*" class from a
// different angle: a test that spawns a subprocess via `env: {...process.env}`
// (the common, easy-to-miss pattern) now inherits the sandboxed HOME for
// free, with no per-test HOME override to remember.
const sandboxHome = path.join(tmp, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
// Several paths intentionally distinguish an agent's isolated HOME from the
// active installation home via AGENTS_REAL_HOME. Pin that canonical seam too:
// child processes launched through login shells/service managers may restore
// HOME to the account home, but they still inherit AGENTS_REAL_HOME.
process.env.AGENTS_REAL_HOME = sandboxHome;

// PHNX-3072: sandbox desktop openers the same way HOME is sandboxed — at the
// fork boundary, before any test file's imports run. PATH was previously left
// alone, so a test that reached a real spawn('open' | 'xdg-open') resolved the
// developer's binary. That shipped: open-url.test.ts drove the non-injected
// viewer path, every Mac `bun run test` opened example.com, and Linux CI
// stayed green because xdg-open was absent. The specific test was fixed in
// #2937; this closes the class. Stub binaries prepended to PATH catch a
// PATH-resolved spawn (and any child that inherits env: {...process.env}).
// The afterAll tripwire fails the file unless AGENTS_TEST_ALLOW_OPENER=1.
// This is a prefix, not a cage: git/node/the CLI still resolve from the rest
// of PATH. See tests/opener-sandbox.ts.
installOpenerSandbox({ tmp });

// Broker: pin the socket dir to a fork-private temp path so nothing in this
// fork — nor any CLI subprocess it spawns with inherited env — can reach the
// user's real broker socket; and turn the broker client integration off as
// the default (the read fast-path, auto-load, and write eviction all honor
// this, see bundles.ts).
process.env.AGENTS_SECRETS_AGENT_DIR = path.join(tmp, 'secrets-agent');
process.env.AGENTS_SECRETS_NO_AGENT = '1';

// The standalone `secrets` CLI (PHNX-3989) the client spawns reads the renamed
// SECRETS_* knobs: no broker in a fork, and a deterministic file-store passphrase
// so a headless box with no keyring routes keychain items to the encrypted file
// store instead of failing on a missing secret-tool. Its state root defaults to
// the sandboxed HOME's .agents (buildServeEnv), so nothing reaches the real
// store; useFreshSecretsHome (tests/secrets-standalone.ts) isolates per test.
process.env.SECRETS_NO_AGENT = '1';
process.env.SECRETS_PASSPHRASE = 'agents-vitest-file-store';

// Usage stamping writes bundle metadata back to the secret store on reads.
process.env.AGENTS_NO_USAGE_TRACK = '1';

// A developer box that exports CLAUDE_CODE_OAUTH_TOKEN (mac-mini does, from
// ~/.zshenv) changed what the CLI PRINTS for a version with no per-version
// login: view.ts renders "(no per-version login - using ambient
// CLAUDE_CODE_OAUTH_TOKEN)" instead of "(logged out - log in with: ...)",
// because ambientClaudeToken() (signin-badge.ts) reads this variable. Any
// test asserting the logged-out row then failed on that box alone and passed
// in CI -- and the suite is the release gate, so the release home base could
// never produce a green attestation. Clear it as the fork default; tests that
// exercise ambient-token behavior set it themselves and restore the value
// they saved, which is simply this hermetic default.
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

// Events: redirect the sink to a fork-private file. Redirect, not disable —
// events.test.ts / logs.test.ts assert on written content and re-point the
// sink themselves via _resetForTest, which takes precedence over this env.
process.env.AGENTS_EVENTS_PATH = path.join(tmp, 'events.jsonl');

// Devices registry (RUSH-2042): redirect the device registry + ignore-list dir
// to a fork-private temp so device-registry tests can never write fixture
// devices (alpha, bravo, box, …) into the user's real ~/.agents/.history/
// devices. state.ts's getDevicesDir() reads this at call time; a test that
// wants its own isolated registry overrides AGENTS_DEVICES_DIR per-test. This
// is the surgical mirror of AGENTS_EVENTS_PATH / AGENTS_SECRETS_AGENT_DIR — it
// leaves HOME untouched (git and every other HOME consumer behave normally).
process.env.AGENTS_DEVICES_DIR = path.join(tmp, 'devices');

// NB: AGENTS_DAEMON_DIR is deliberately NOT set here. Tests that spawn a REAL
// daemon (migrate.test.ts, daemon.test.ts) isolate it per-test via a unique
// HOME and read HOME-based daemon paths; a global AGENTS_DAEMON_DIR would be
// inherited by those spawned children (env: {...process.env}) and force them all
// onto one shared daemon dir, colliding on the single-instance guard. The only
// file that writes the daemon dir IN-PROCESS (daemon-self-heal.test.ts) sets
// AGENTS_DAEMON_DIR itself, file-scoped, so its isolation never leaks here.

// Hook shims/cache/logs + the disposable perf warehouse: every hook now
// resolves through a generated shim (pass-through timing for matcher-only
// hooks, see hooks/cache.ts), so any registrar test that calls
// registerHooksToSettings(...) in-process — most of hooks.test.ts, no
// subprocess HOME override — would otherwise write real shim scripts, cache
// files, JSONL logs, and perf samples into the user's actual ~/.agents/.cache.
// state.ts's getHookShimsDir/getHookCacheDir/getLogsDir/getPerfDir all read
// these at call time; never set in production code.
process.env.AGENTS_HOOK_SHIMS_DIR = path.join(tmp, 'hook-shims');
process.env.AGENTS_HOOK_CACHE_DIR = path.join(tmp, 'hook-cache');
process.env.AGENTS_LOGS_DIR = path.join(tmp, 'logs');
process.env.AGENTS_PERF_DIR = path.join(tmp, 'perf');
// Runtime state (~/.agents/.cache/state/) holds the devices-pending sentinels the
// menu bar renders as "NEW DEVICES". AGENTS_DEVICES_DIR already points the device
// registry and ignore list at tmp, so under test both read EMPTY — and any path
// reaching reconcilePendingSentinels then concluded every tailnet node was new and
// wrote those sentinels into the operator's LIVE dir. Running the suite on a dev
// machine surfaced all 20 nodes as NEW DEVICES, registered and ignored alike.
process.env.AGENTS_STATE_DIR = path.join(tmp, 'state');

// Leak tripwire: the REAL events log must not grow while this fork runs.
// CI-only — on a dev machine live agents append to it concurrently, so the
// check would false-positive locally; CI homes are quiet.
const realEventsLog = path.join(realUserAgentsDir, 'events.jsonl');
const sizeBefore = fs.existsSync(realEventsLog) ? fs.statSync(realEventsLog).size : 0;

// Leak tripwire (RUSH-2042): the REAL device registry must not change while
// this fork runs. On CI (no concurrent fleet writers) ANY change — a new,
// modified, or removed entry — is a hermeticity breach; a full content compare
// needs no fixture-name allowlist to stay in sync. On a dev machine live fleet
// agents may legitimately update it mid-run, so the check is CI-only.
const realDevicesRegistry = path.join(realUserAgentsDir, '.history', 'devices', 'registry.json');
const devicesRegistryBefore: string | null = fs.existsSync(realDevicesRegistry)
  ? fs.readFileSync(realDevicesRegistry, 'utf-8')
  : null;

// Leak tripwire: the REAL devices-pending sentinels — the menu bar's "NEW
// DEVICES" list — must not change while this fork runs. Same CI-only rule as
// above: a live daemon probe legitimately reconciles this dir every ~3 min on a
// dev machine. The AGENTS_STATE_DIR pin is the actual fix; this catches a code
// path that resolves the sentinel dir some other way.
const realDevicesPending = path.join(realUserAgentsDir, '.cache', 'state', 'devices-pending');
const devicesPendingBefore: string | null = fs.existsSync(realDevicesPending)
  ? fs.readdirSync(realDevicesPending).sort().join(',')
  : null;

// Leak tripwire (RUSH-2639): a shallow fingerprint (name + size + mtime) of
// every direct child of the REAL ~/.agents. The three tripwires above each
// hard-code one known hot spot; this one is generic — it catches a write
// ANYWHERE directly under the real user dir (a stray agents.yaml, a hooks/
// dir, a routines/ entry, …) without needing to name the path in advance.
// Same CI-only rule as the others: a dev box may have a live daemon touching
// its own real ~/.agents concurrently.
function snapshotTopLevel(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).sort().map((name) => {
    const st = fs.statSync(path.join(dir, name));
    return `${name}:${st.size}:${st.mtimeMs}`;
  }).join('|');
}
const userAgentsTopLevelBefore = snapshotTopLevel(realUserAgentsDir);

// Leak tripwire (RUSH-2639): the native Claude config lives OUTSIDE
// ~/.agents entirely (~/.claude/settings.json), which is exactly the file
// this ticket named — a hook-registration test that resolved a version home
// from the real (un-redirected) HOME wrote its fixture hook entries straight
// into the developer's actual Claude settings.
const realClaudeSettings = path.join(realHome, '.claude', 'settings.json');
const claudeSettingsBefore = fs.existsSync(realClaudeSettings)
  ? fs.statSync(realClaudeSettings).mtimeMs
  : null;

afterAll(() => {
  try {
    // PHNX-3072: local, not CI-only. The original opener leak was invisible
    // on Linux CI (xdg-open absent) and only hurt developers running the
    // suite. A quiet runner is irrelevant — the tripwire is "did this fork
    // spawn a desktop opener", which a live daemon cannot false-positive.
    assertNoUnauthorizedOpenerSpawn();

    // RUSH-3007: these tripwires assume "CI" means a quiet, single-tenant
    // runner with no concurrent writer to the real ~/.agents. That's false
    // for release-attestation-produce.sh, which used to need CI=true just to
    // get vitest.config.ts's extended hookTimeout profile and, as a side
    // effect, armed these guards on a box with a live daemon + active
    // sessions — 129/129 test files false-failed on a fully green
    // 12,559/12,559-test run cutting 1.22.44. shouldArmHermeticGuards() keeps
    // a genuine CI runner's behavior identical and excludes only the
    // producer's opt-in flag. See tests/hermetic-guards.ts.
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
