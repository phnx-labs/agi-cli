/**
 * Benchmark for the CLI entry hot path: `checkForUpdates()` (index.ts:755) and
 * `spawnDetachedSync()` (index.ts:1330), both of which run on EVERY ordinary
 * `agents` invocation except pure `--help`/`--version` (index.ts:1319-1331 guards
 * them behind `!helpOrVersionRequested`). This pair used to be the reason the
 * secrets-broker sync commands were intercepted above commander registration,
 * before `checkForUpdates()`/`spawnDetachedSync()` would otherwise fire on
 * every cache-hit read — that interception moved out entirely with the
 * standalone `secrets` engine (PHNX-3989).
 *
 * `checkForUpdates` (index.ts:755-779) and its helper `maybeWarnMultiInstall`
 * (index.ts:535-575) are NOT exported -- they are private to index.ts, and
 * index.ts cannot be imported directly: it has top-level `await`, reads
 * `process.argv`, and (outside the two early-intercept blocks at index.ts:38 and
 * index.ts:71) eventually calls `program.parse()`, so importing the module as
 * ESM would run the real CLI bootstrap as a side effect of loading this bench
 * file. Instead this benchmarks the exact exported functions `checkForUpdates`
 * calls, with the same real arguments (this machine's real PATH, its real
 * ~/.agents/.cache/.update-check file):
 *
 *   maybeWarnMultiInstall (index.ts:535-575)
 *     -> resolveRunningPackageRoot (self-update.ts:177)
 *     -> findAgentsCliInstalls(process.env.PATH)      (self-update.ts:509)
 *     -> buildMultiInstallInventory(...)              (self-update.ts:401)
 *   checkForUpdates body (index.ts:755-779)
 *     -> readUpdateCache(UPDATE_CHECK_FILE)           (self-update.ts:79)
 *     -> shouldFetchLatest(cache)                     (index.ts:578, PRIVATE -- see note below)
 *     -> shouldPromptUpgrade(cache, VERSION)           (self-update.ts:128)
 *
 * `shouldFetchLatest` (index.ts:578) is itself private to index.ts (not
 * self-update.ts, despite living right beside the exported update-cache
 * helpers there) -- it is NOT benched directly for the same reason
 * `checkForUpdates` itself isn't: nothing can import it without importing all
 * of index.ts. It is one pure comparison (`Date.now() - cache.lastCheck >
 * UPDATE_CHECK_INTERVAL_MS`), immaterial next to the real fs/PATH work
 * measured below -- readUpdateCache's real fs.readFileSync + JSON.parse
 * dominates it by construction, and readUpdateCache is exported and benched.
 *
 * `refreshUpdateCacheInBackground` (index.ts:739-752) and the interactive
 * `promptUpgrade` path are NOT benched: the former is a fire-and-forget network
 * fetch (`fetch(...).then(...)`, never awaited by the caller) and the latter is
 * an interactive TTY prompt -- neither is on the synchronous hot path this file
 * measures, and neither fires on a plain terminal `agents <cmd>` run against a
 * fresh cache.
 *
 * `spawnDetachedSync` (auto-pull.ts:46-72) IS exported and is benched directly,
 * but with one twist: it resolves its worker script relative to
 * `fileURLToPath(import.meta.url)` (auto-pull.ts:51), i.e. relative to wherever
 * the RUNNING copy of this module lives. Importing it the normal bench way (via
 * './auto-pull.js', vitest's TS-source resolution) would put that module at
 * src/lib/auto-pull.ts, where only auto-pull-worker.TS exists -- so
 * `fs.existsSync(workerPath)` (auto-pull.ts:53) would ALWAYS be false and the
 * function would always take the early-return guard path, never actually
 * spawning anything. That is real behavior for an unbuilt checkout, but it is
 * not what a real user's installed copy does (npm ships dist/lib/auto-pull-
 * worker.js). To measure the real spawn this file imports the ACTUAL BUILT
 * ARTIFACT at ../../dist/lib/auto-pull.js (produced by `bun run build` /
 * `bun install`'s `prepare` hook) so `import.meta.url` resolves inside dist/lib/
 * and the real dist/lib/auto-pull-worker.js is found. Both regimes are benched
 * explicitly below so the guard-path cost and the real fork+exec cost are never
 * conflated.
 *
 * No mocking: every call below hits the real filesystem (real PATH, real
 * ~/.agents/.cache files) and, in the "real spawn" group, a real
 * child_process.spawn of the real dist/lib/auto-pull-worker.js -- which itself
 * does a real `git fetch` against this machine's real ~/.agents repos in the
 * background (detached, unref'd, so it does not block this process or this
 * benchmark's timing; see auto-pull-worker.ts). That group is therefore bounded
 * to a small iteration count, mirroring exec.bench.ts's execAgent group.
 *
 * Lives at src/lib/index.bench.ts, not src/index.bench.ts, so that
 * `typecheck:bench` (package.json:58, globs `src/lib/*.bench.ts
 * src/lib/**\/*.bench.ts`) actually type-checks it -- a prior version at
 * src/index.bench.ts silently sat outside that glob and shipped a stale
 * `@ts-expect-error` (TS2578, unused directive) that no gate caught.
 */
import { describe, bench, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { detectDevBuild } from './startup/dev-build.js';
import {
  readUpdateCache,
  shouldPromptUpgrade,
  buildMultiInstallInventory,
  findAgentsCliInstalls,
  resolveRunningPackageRoot,
} from './self-update.js';
import {
  getAgentsDir,
  getLegacySystemAgentsDir,
  getMigratedSentinelPath,
  getUpdateCheckPath,
  readMeta,
} from './state.js';
import { isGitRepo } from './git.js';
import { emit, redactArgs, _resetForTest } from './feed/events.js';
import { stampProvenance } from './event-provenance.js';
import { installMenubarLaunchAgentOnUpgrade } from './menubar/install-menubar.js';
import {
  resolveBrandName,
  activeBrandName,
  isBranded,
  disabledCommandsForActiveBrand,
} from './brand.js';
// Real built artifact (see docblock above) -- NOT './auto-pull.js', which
// would resolve to the unbuilt TS source and always miss the worker script.
// dist/lib/auto-pull.d.ts exists (tsconfig.json declaration:true), so this
// resolves and type-checks normally -- no @ts-expect-error needed here.
import { spawnDetachedSync } from '../../dist/lib/auto-pull.js';
import { loadDoctor, loadVersions, loadPrune, loadSessions } from '../cli/command-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPDATE_CHECK_FILE = getUpdateCheckPath();
const REAL_PATH = process.env.PATH || '';
const SYSTEM_DIR = getAgentsDir();
const LEGACY_SYSTEM_DIR = getLegacySystemAgentsDir();
const MIGRATED_SENTINEL_FILE = getMigratedSentinelPath();
// Mirrors `sentinelValue` in bootstrap.ts — keep in sync or the bench measures the
// non-short-circuiting path that a real (already-migrated) install never takes.
const MIGRATION_SENTINEL_VALUE = 'v21';

describe('checkForUpdates — maybeWarnMultiInstall (index.ts:535-575): the PATH + known-install-root scan', () => {
  bench('resolveRunningPackageRoot(__dirname) — walks up from the module dir to the package.json naming this package (a few stat/read calls, bounded by nesting depth)', () => {
    resolveRunningPackageRoot(__dirname);
  });

  bench(`findAgentsCliInstalls(process.env.PATH) — real PATH scan (${REAL_PATH.split(path.delimiter).filter(Boolean).length} real entries on this box) + known nvm/fnm/volta/bun/npx roots (self-update.ts:509)`, () => {
    findAgentsCliInstalls(REAL_PATH);
  });

  bench('maybeWarnMultiInstall end-to-end: resolveRunningPackageRoot + findAgentsCliInstalls + buildMultiInstallInventory (index.ts:539-550) -- dominated by the PATH scan above; the Map-based aggregation itself (self-update.ts:401) is negligible over the small install list it runs on', () => {
    const runningRoot = resolveRunningPackageRoot(__dirname);
    const installs = findAgentsCliInstalls(REAL_PATH);
    buildMultiInstallInventory(runningRoot, '0.0.0-bench', installs);
  });
});

describe('checkForUpdates — cache read + prompt decision (index.ts:755-779)', () => {
  bench(`readUpdateCache(UPDATE_CHECK_FILE) — real ~/.agents/.cache/.update-check read (self-update.ts:79)`, () => {
    readUpdateCache(UPDATE_CHECK_FILE);
  });

  bench('shouldPromptUpgrade — pure comparison against the real cached value, incl. compareVersions (self-update.ts:128)', () => {
    const cache = readUpdateCache(UPDATE_CHECK_FILE);
    shouldPromptUpgrade(cache, '0.0.0-bench');
  });
});

describe('spawnDetachedSync (index.ts:1330, auto-pull.ts:46-72) — guard-path only (AGENTS_NO_AUTOPULL=1, no spawn)', () => {
  bench('early return: env check only (auto-pull.ts:47)', () => {
    process.env.AGENTS_NO_AUTOPULL = '1';
    spawnDetachedSync();
  });
});

describe('spawnDetachedSync — real detached child_process.spawn against the built dist/lib/auto-pull-worker.js', () => {
  bench('fileURLToPath + path.join + fs.existsSync + spawn().unref() (auto-pull.ts:51-68) — forks a real process, real background git fetch', () => {
    delete process.env.AGENTS_NO_AUTOPULL;
    spawnDetachedSync();
  }, { time: 2000, iterations: 10 });
});

/**
 * ============================================================================
 * Command registration hot path: registerEagerForRequest / COMMAND_LOADERS
 * (index.ts:1007-1063, lib/startup/command-registry.ts) and the
 * program.parseAsync() call it feeds (index.ts:1440).
 *
 * Every ordinary `agents <cmd>` invocation resolves `requestedCommand` from
 * argv (index.ts:1232), looks it up in COMMAND_LOADERS
 * (command-registry.ts:155-274), dynamically imports the one-or-two command
 * modules that name maps to, and calls the returned registrar(program)
 * (index.ts:1010-1012 `reg`) BEFORE program.parseAsync() ever runs
 * (index.ts:1440) -- unconditionally, regardless of `--help`/`--version`
 * (index.ts:1271-1280 has no helpOrVersionRequested guard). An unrecognized
 * top-level name (typo, or the brand-disabled path) instead falls back to
 * registerAllEagerCommands() (index.ts:1072-1161), which imports and
 * registers EVERY command module in the CLI so the Levenshtein "did you mean"
 * spellcheck (index.ts:1184-1226) has the full candidate set.
 *
 * index.ts cannot be imported directly (see the docblock at the top of this
 * file -- top-level await, process.argv reads, eventual program.parse()), and
 * neither `reg` nor `registerEagerForRequest` nor `registerAllEagerCommands`
 * is exported, so there is no way to call them in-process without duplicating
 * their dispatch/ordering logic -- exactly the real coupling command-
 * registry.ts's own docblock (command-registry.ts:141-153) says not to
 * re-derive. Two complementary regimes are benched instead:
 *
 *   1. REAL SPAWNED PROCESS (below): `spawnSync` the actual built
 *      dist/index.js with a handful of representative top-level names, each a
 *      fresh Node process -- i.e. a genuinely COLD run of the entire dispatch
 *      path above, exactly as a user's shell invokes it. `--help` is appended
 *      to every invocation so each run exits fast and deterministically
 *      (commander prints help and exits 0) without touching stdin. `--help`
 *      does skip checkForUpdates/spawnDetachedSync, ensureInitialized, the
 *      menu-bar self-heal, AND the migration hops (foldLegacySystemRepo via
 *      migrate-fold.js + runMigration via migrate.js) — all gated by
 *      `!helpOrVersionRequested` (RUSH-2454). A `--help` row therefore does
 *      not pay `await import('./lib/migrate.js')`. Registration/import cost
 *      measured here is isolated from those pieces.
 *   2. WARM IN-PROCESS REGISTRATION (further below): call the real, exported
 *      command-registry.ts loaders directly -- `(await loadX())(new
 *      Command())` -- for a representative subset. Node's ESM loader caches a
 *      module after its first import in this process, so after the first
 *      sample every further call pays ONLY the registrar function's own
 *      synchronous commander-construction work (.command/.option/.action
 *      calls), not disk read + parse + top-level module evaluation. Compared
 *      against group 1's real cold-process numbers for the SAME command, the
 *      gap approximates how much of the real-world cost is "importing the
 *      module and its dependency graph" versus "building the commander
 *      command tree" -- the same decomposition PR #2277 used to show
 *      ensureInitialized's hot-path body is a single syscall dwarfed by its
 *      eager unconditional import.
 *
 * No mocking: group 1 runs the real built dist/index.js against this
 * machine's real ~/.agents (same real filesystem/PATH every other group in
 * this file uses); group 2 calls the real, unmodified command registrars
 * exported from command-registry.ts.
 */
const CLI_ENTRY = path.join(__dirname, '../../dist/index.js');

function runCli(args: string[]): number | null {
  // spawnSync (not execFileSync) so a non-zero exit never throws inside the
  // timed callback -- every arg list below is verified to exit 0 on this
  // machine, but the bench must stay robust to environment drift. The status
  // is RETURNED rather than swallowed so a caller whose row depends on
  // reaching a specific code path can assert it (see expectExit below);
  // callers that only need "a real cold process ran" ignore it.
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], { stdio: 'ignore' }).status;
}

/**
 * Assert a `runCli` row actually reached the code path it claims to measure.
 *
 * Without this, a row is only ever "a cold node process ran": if the argv
 * intercept it targets were moved or renamed, commander would take over,
 * print "unknown command" and exit 1, and the row would keep posting a
 * plausible number for entirely different work. Same reason coldEval throws.
 *
 * Takes a SET of acceptable codes, not one: an intercepted token's exit code
 * can legitimately differ by machine, and the property being defended is
 * "the intercept answered", not "it answered with this specific number".
 */
function expectExit(status: number | null, allowed: readonly number[], label: string): void {
  if (status === null || !allowed.includes(status)) {
    throw new Error(
      `${label}: expected exit in {${allowed.join(', ')}}, got ${status} — this row is measuring the wrong path`,
    );
  }
}

describe('registerEagerForRequest / COMMAND_LOADERS — real cold `node dist/index.js <cmd> --help` process spawn (index.ts:1007-1063, 1271-1280)', () => {
  bench('baseline: `agents --help` — requestedCommand undefined, ZERO command loaders run (index.ts:1281-1284)', () => {
    runCli(['--help']);
  }, { time: 4000, iterations: 15 });

  bench('`agents doctor --help` — 1 loader (loadDoctor), single COMMAND_LOADERS entry (command-registry.ts:201)', () => {
    runCli(['doctor', '--help']);
  }, { time: 4000, iterations: 15 });

  bench('`agents prune --help` — 2 loaders in sequence (loadVersions, loadPrune — command-registry.ts:177, ordering comment at 148-149)', () => {
    runCli(['prune', '--help']);
  }, { time: 4000, iterations: 15 });

  bench('`agents sessions --help` — lazy-tree command, the SQLite-backed session module (index.ts:1290-1291, LAZY_COMMAND_NAMES)', () => {
    runCli(['sessions', '--help']);
  }, { time: 4000, iterations: 15 });

  bench('`agents <unknown> --help` — registerAllEagerCommands() fallback, EVERY command module in the CLI (index.ts:1072-1161, 1271-1280)', () => {
    runCli(['zzzznotarealcommand', '--help']);
  }, { time: 6000, iterations: 12 });
});

describe('command-registry.ts loaders — warm in-process registration only (module import cached after the first sample; see docblock above)', () => {
  bench('loadDoctor()(new Command()) — registerDoctorCommand body only, no import cost after first sample', async () => {
    (await loadDoctor())(new Command());
  });

  bench('loadVersions()(new Command()) then loadPrune()(...) — the real `prune` two-loader sequence, in order', async () => {
    const program = new Command();
    (await loadVersions())(program);
    (await loadPrune())(program);
  });

  bench('loadSessions()(new Command()) — registerSessionsCommands body only, no import cost after first sample', async () => {
    (await loadSessions())(new Command());
  });
});

/**
 * ============================================================================
 * The core bootstrap block: everything index.ts evaluates and RUNS before the
 * first argv fast path can return — `detectDevBuild()` (index.ts:113) and the
 * root commander program (index.ts:262-270) with its audit hooks
 * (index.ts:305-371). Paid by `--version` and `--help` too: the
 * `!helpOrVersionRequested` guard is at index.ts:1322, ~1200 lines below all of
 * it, and it only gates `checkForUpdates()` + `spawnDetachedSync()`. The
 * secrets-broker token dispatch this block used to also cover moved out of
 * this CLI entirely with the standalone `secrets` engine (PHNX-3989).
 *
 * The groups below measure the WORK these lines do, not the cost of loading
 * their modules. The module-graph question was previously deferred here to a
 * sibling PR (#2280) that was CLOSED unmerged, so no group ever landed for it:
 * `import { Command } from 'commander'` (index.ts:10) is now priced by the
 * commander group further down, and `import chalk from 'chalk'` (index.ts:11)
 * remains unmeasured. Where a number here needs the import cost to be
 * interpretable it uses the whole-invocation anchor at the bottom instead.
 *
 * One of these IS in scope here and is not in that PR, because it is
 * inventory rather than a counterfactual:
 *   - the real cold `node dist/index.js --version`, the denominator every
 *     other row in this file is a fraction of.
 *
 * No mocking anywhere below: real syscalls against this checkout and this
 * machine's real filesystem, real cold `node` processes importing the real
 * built dist/ artifacts, and the real unmodified `commander` package.
 *
 * `detectDevBuild` is imported from the TS source (`./startup/dev-build.js` ->
 * src/lib/startup/dev-build.ts under vitest), unlike `spawnDetachedSync` above
 * which had to come from dist/. The distinction is `import.meta.url`:
 * spawnDetachedSync resolves a sibling worker script relative to its own module
 * location (auto-pull.ts:51), so the source copy takes a different branch;
 * detectDevBuild reads nothing but its two arguments (dev-build.ts:25-38), so
 * source and dist are the same code doing the same syscalls.
 */

/** cli of THIS checkout. */
const CLI_ROOT = path.resolve(__dirname, '../..');
/** Derived from CLI_ENTRY (declared above) so the two can never disagree. */
const DIST_ROOT = path.dirname(CLI_ENTRY);

/**
 * A real symlink to the built entry, modelling the npm-global bin shim
 * (`<prefix>/bin/agents -> <prefix>/lib/node_modules/@phnx-labs/agents-cli/dist
 * /index.js`) that is `process.argv[1]` on a real user's invocation. It exists
 * so the `fs.realpathSync` hop at dev-build.ts:28 is measured on a genuine
 * symlink, which is the input the whole function was rewritten for: without
 * resolving it, `dirname(dirname())` walks to the npm prefix, and on Homebrew
 * that prefix is itself a git repo, so every Homebrew-node user was misread as
 * a dev build (dev-build.ts:13-23). A real link, not a fixture: the readlink is
 * a real syscall on a real inode.
 *
 * Three things keep the link from becoming a hazard, and they are
 * complementary rather than alternatives:
 *   - Named per-pid, so two concurrent runs of this file (two worktrees on one
 *     box, or CI beside a local run) cannot collide on the same path. A fixed
 *     name raced them into an EEXIST at MODULE scope, which kills the whole
 *     file rather than one row.
 *   - Removed in afterAll, so a normal run leaves nothing in tmpdir.
 *   - Unlinked before creation anyway, because afterAll does NOT run when a
 *     module-scope throw happens after it is registered (verified in review:
 *     the hook is skipped and the file exits 1). A leaked link would then make
 *     `symlinkSync` throw EEXIST for whichever later worker lands on that pid,
 *     killing that run at module scope for an unrelated reason. `force: true`
 *     unlinks the link itself without following it, and is a no-op when absent.
 */
const SHIM_LINK = path.join(os.tmpdir(), `agents-cli-bench-shim-agents-${process.pid}`);
fs.rmSync(SHIM_LINK, { force: true });
fs.symlinkSync(CLI_ENTRY, SHIM_LINK);
afterAll(() => {
  fs.rmSync(SHIM_LINK, { force: true });
});

/**
 * A real file two levels under a real, synthetic git-repo root —
 * `<fixture>/scripts/release.sh`. `dirname(dirname())` of it is
 * FOREIGN_GIT_ROOT, which carries both a real `.git` entry and a real
 * `package.json`, so this is the only one of these inputs that reaches the end
 * of detectDevBuild: realpath -> existsSync(.git) HIT -> existsSync(package.json)
 * HIT -> readFileSync -> JSON.parse -> name compare (dev-build.ts:28-34). The
 * fixture's package.json name is `agents-cli-monorepo` (this repo's own root
 * manifest, before RUSH-2463 removed it), so the compare returns false — this
 * is exactly the false-positive the guard at dev-build.ts:34 was added to
 * reject, priced end to end.
 *
 * Built as a synthetic fixture rather than pointed at the real repo root
 * because the repo root no longer carries a `package.json` (RUSH-2463) —
 * the same construction `dev-build.test.ts` already uses for its "unrelated
 * ancestor git repo" case, just with real syscalls on a real inode instead of
 * vitest's in-memory fs. Per-pid named and removed in afterAll for the same
 * collision/cleanup reasons as SHIM_LINK above.
 */
const FOREIGN_GIT_ROOT = path.join(
  os.tmpdir(),
  `agents-cli-bench-foreign-git-root-${process.pid}`,
);
fs.rmSync(FOREIGN_GIT_ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(FOREIGN_GIT_ROOT, '.git'), { recursive: true });
fs.mkdirSync(path.join(FOREIGN_GIT_ROOT, 'scripts'), { recursive: true });
fs.writeFileSync(
  path.join(FOREIGN_GIT_ROOT, 'package.json'),
  JSON.stringify({ name: 'agents-cli-monorepo' }),
);
fs.writeFileSync(path.join(FOREIGN_GIT_ROOT, 'scripts', 'release.sh'), '');
afterAll(() => {
  fs.rmSync(FOREIGN_GIT_ROOT, { recursive: true, force: true });
});
const GIT_ROOT_TWO_LEVELS_DOWN = path.join(FOREIGN_GIT_ROOT, 'scripts', 'release.sh');

/**
 * The real installed version string, read from this checkout's package.json the
 * same way index.ts:31-34 does. Using a literal here would silently take the
 * `0.0.0-dev` fast path (dev-build.ts:26) and measure nothing.
 */
const REAL_VERSION: string = JSON.parse(
  fs.readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf-8'),
).version;

describe('detectDevBuild(process.argv[1], VERSION) — runs unconditionally at index.ts:113, before --version/--help can return (dev-build.ts:25-38)', () => {
  bench(`version fast path: a 0.0.0-dev stamp returns at dev-build.ts:26 with ZERO syscalls — what scripts/install.sh dev installs hit (real version here is ${REAL_VERSION}, which does NOT take this branch)`, () => {
    detectDevBuild(SHIM_LINK, '0.0.0-dev.deadbeef');
  });

  bench('npm-global shim (the real production input): realpathSync through a real symlink + ONE existsSync(.git) miss -> false (dev-build.ts:28-30)', () => {
    detectDevBuild(SHIM_LINK, REAL_VERSION);
  });

  bench('`node cli/dist/index.js` from this working tree: realpathSync (no link) + ONE existsSync(.git) miss -> false. dirname(dirname(dist/index.js)) is cli, and .git is ONE level above that, so index.ts:106 case 2 ("running node dist/index.js from a working tree") does not fire in the monorepo layout', () => {
    detectDevBuild(CLI_ENTRY, REAL_VERSION);
  });

  bench('full path — realpath + existsSync(.git) HIT + existsSync(package.json) HIT + readFileSync + JSON.parse + name compare (dev-build.ts:28-34). The Homebrew-shaped false positive the rewrite rejects', () => {
    detectDevBuild(GIT_ROOT_TWO_LEVELS_DOWN, REAL_VERSION);
  });
});

/**
 * Cold-import `specs` in a fresh Node process; empty list = the bare spawn floor.
 *
 * Node caches an ESM module for the life of a process, so a second in-process
 * `import()` of the same specifier measures a Map lookup, not a module load.
 * An honest module-load number only comes from a fresh process. Every row in
 * the group below spawns the identical shape, so the constant Node floor
 * cancels between rows and (row - FLOOR) is that graph's own load cost.
 *
 * The throw on a non-zero exit stops a dead child from posting a good number: a
 * mistyped or moved specifier makes the child exit in LESS time than the
 * bare-spawn floor, so a swallowed failure would read as the fastest row in the
 * table. Be precise about how loud that throw actually is, though — measured
 * under this repo's pinned vitest, a throw inside a `bench` callback does NOT
 * fail the run: tinybench catches it and the row reports no result (the summary
 * prints `NaNx faster than …`). So the throw alone buys "no false number", not
 * "the run fails". `preflightColdImports()` below is what makes it genuinely
 * loud: it runs each spec list ONCE at module scope, where a throw aborts the
 * whole bench file before a single sample is taken.
 */
function coldEval(specs: string[], extraEnv?: NodeJS.ProcessEnv): void {
  const src = specs.map((s) => `await import(${JSON.stringify(s)});`).join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], {
    stdio: ['ignore', 'ignore', 'pipe'],
    ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
  });
  if (r.status !== 0) {
    throw new Error(
      `cold import failed (status ${r.status}, signal ${r.signal}): ${String(r.stderr).slice(0, 400)}`,
    );
  }
}

const distUrl = (rel: string): string => pathToFileURL(path.join(DIST_ROOT, rel)).href;
const COLD_OPTS = { time: 3000, iterations: 12 } as const;

const DEV_BUILD_SPEC = distUrl('lib/startup/dev-build.js');
const SELF_UPDATE_SPEC = distUrl('lib/self-update.js');
const COMMAND_REGISTRY_SPEC = distUrl('lib/startup/command-registry.js');
const HELP_SPEC = distUrl('lib/help.js');
const WHATS_NEW_SPEC = distUrl('lib/whats-new.js');
const PLATFORM_SPEC = distUrl('lib/platform/index.js');
const CLI_ENTRY_SPEC = distUrl('lib/cli-entry.js');
const EVENTS_SPEC = distUrl('lib/events.js');
const EVENT_PROVENANCE_SPEC = distUrl('lib/event-provenance.js');
const FORMAT_SPEC = distUrl('lib/format.js');
const VIEW_COMMAND_SPEC = distUrl('commands/view.js');
const DOCTOR_COMMAND_SPEC = distUrl('commands/doctor.js');
const SESSIONS_COMMAND_SPEC = distUrl('commands/sessions.js');
const MENUBAR_INSTALL_SPEC = distUrl('lib/menubar/install-menubar.js');
const BRAND_SPEC = distUrl('lib/brand.js');
const AGENTS_REGISTRY_SPEC = distUrl('lib/agents.js');
const VERSIONS_SPEC = distUrl('lib/installations/versions.js');
const PRIMITIVES_SPEC = distUrl('lib/agent-spec/primitives.js');
const STATE_SPEC = distUrl('lib/state.js');
const TYPES_SPEC = distUrl('lib/types.js');

/**
 * `commander` itself (index.ts:10, `import { Command } from 'commander'`).
 *
 * Every other cold-import spec in this file is a `distUrl(...)` of a FIRST-PARTY
 * module, and the two multi-module bundles below are described in their own
 * docblock as "index.ts's own eager local-module imports" — so no row in this
 * file, and none in events.bench.ts / brand.bench.ts, has ever priced the
 * third-party edge that index.ts:10 declares. It is not optional and not lazy:
 * `Command` is used at index.ts:262 (`new Command()`) and as a type in
 * `auditCommandPath` (index.ts:280), so it is evaluated before argv is even
 * looked at, on EVERY invocation including `--version` / `--help`.
 *
 * Resolved through `createRequire(...).resolve` rather than a hand-built path so
 * a hoisted / relocated `node_modules` can never silently point this row at
 * nothing (require.resolve throws, and the module-scope preflight below turns
 * that into a failed suite). commander 15.0.0 is `"type": "module"` with
 * `"main": "./index.js"`, so the resolved path IS the ESM entry the CLI loads.
 */
const COMMANDER_SPEC = pathToFileURL(
  createRequire(import.meta.url).resolve('commander'),
).href;

/**
 * A warm on-disk V8 code cache for the same cold imports. `NODE_COMPILE_CACHE`
 * is Node's supported env knob for `module.enableCompileCache()` (present on
 * this box's node v24.11.1; the package floor is `"node": ">=22.5.0"`,
 * package.json:84, and the API landed in 22.1), so it is a real, shipped
 * configuration — not a patched runtime. The directory is populated by
 * `preflightColdImports` below before any row is timed, so the timed samples
 * read a warm cache rather than paying to write it.
 */
const COMPILE_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-compile-cache-'));
const COMPILE_CACHE_ENV = { NODE_COMPILE_CACHE: COMPILE_CACHE_DIR } as const;

afterAll(() => {
  try { fs.rmSync(COMPILE_CACHE_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

/**
 * index.ts's own eager local-module imports, EXCLUDING brand.js — by line:
 * dev-build (16), self-update (86), command-registry
 * (124), help (208), whats-new (209), platform/index (211), cli-entry (212),
 * events (213), event-provenance (214), format (215), state (513). types.js
 * (210) is type-only and erased at compile, so it is not a runtime edge and
 * is excluded here (it gets its own row in the group above instead). The
 * secrets-broker sync-commands leaf that used to sit here moved out entirely
 * with the standalone `secrets` engine (PHNX-3989) — index.ts now has no
 * static imports at all.
 */
const EAGER_MINUS_BRAND = [
  DEV_BUILD_SPEC,
  SELF_UPDATE_SPEC,
  COMMAND_REGISTRY_SPEC,
  HELP_SPEC,
  WHATS_NEW_SPEC,
  PLATFORM_SPEC,
  CLI_ENTRY_SPEC,
  EVENTS_SPEC,
  EVENT_PROVENANCE_SPEC,
  FORMAT_SPEC,
  STATE_SPEC,
];
const EAGER_WITH_BRAND = [...EAGER_MINUS_BRAND, BRAND_SPEC];

/**
 * Prove every cold-import spec resolves, and that the token intercept still
 * answers, BEFORE any row is timed. Module scope, not a bench callback, so a
 * bad or moved specifier throws where vitest actually reports it — the file
 * fails (exit 1, a real Failed Suite) instead of quietly posting `NaN` for the
 * row that measured nothing. The in-row checks below are the same assertions
 * one layer down; they stop a false number, this is what makes it loud.
 */
(function preflightColdImports(): void {
  for (const spec of [
    DEV_BUILD_SPEC,
    SELF_UPDATE_SPEC,
    COMMAND_REGISTRY_SPEC,
    HELP_SPEC,
    WHATS_NEW_SPEC,
    PLATFORM_SPEC,
    CLI_ENTRY_SPEC,
    EVENTS_SPEC,
    EVENT_PROVENANCE_SPEC,
    FORMAT_SPEC,
    VIEW_COMMAND_SPEC,
    DOCTOR_COMMAND_SPEC,
    SESSIONS_COMMAND_SPEC,
    MENUBAR_INSTALL_SPEC,
    BRAND_SPEC,
    AGENTS_REGISTRY_SPEC,
    VERSIONS_SPEC,
    PRIMITIVES_SPEC,
    STATE_SPEC,
    TYPES_SPEC,
    COMMANDER_SPEC,
  ])
    coldEval([spec]);
  // The multi-spec rows (EAGER_MINUS_BRAND / EAGER_WITH_BRAND) get their own
  // preflight since coldEval takes the whole list per sample there, not one
  // spec at a time.
  coldEval(EAGER_MINUS_BRAND);
  coldEval(EAGER_WITH_BRAND);
  coldEval([EVENTS_SPEC, EVENT_PROVENANCE_SPEC, FORMAT_SPEC]);
  coldEval([...EAGER_WITH_BRAND, VIEW_COMMAND_SPEC]);
  // Populate the code cache so the NODE_COMPILE_CACHE rows time a warm read,
  // not the one-time write. Two passes: the first writes, the second proves the
  // cache is readable (a spawn that failed either way would throw here).
  coldEval([COMMANDER_SPEC], COMPILE_CACHE_ENV);
  coldEval([COMMANDER_SPEC], COMPILE_CACHE_ENV);
  coldEval([], COMPILE_CACHE_ENV);
  expectExit(runCli(['--version']), [0], '--version preflight');
})();

// The secrets-broker sync-commands intercept this file used to benchmark
// (index.ts slim shell + `lib/secrets/sync-commands.js` leaf, and the
// `__secrets-ping` dispatch itself) moved out of this CLI entirely with the
// standalone `secrets` engine (PHNX-3989) — index.ts has no static imports
// and no synchronous broker fast path left to measure.

/**
 * `import { Command } from 'commander'` (index.ts:10) — the module load itself,
 * before a single `new Command()` is constructed. Unconditional and eager: there
 * is no argv fast path above it inside bootstrap.js (loaded after the slim
 * index.ts shell). `--version` / `--help` / every real command still pay it;
 * `__secrets-ping` no longer does (RUSH-2335).
 *
 * commander 15.0.0 is pure ESM. Its index.js imports five lib modules directly
 * (index.js:1-5: argument.js, command.js, error.js, help.js, option.js) and
 * reaches a sixth, suggestSimilar.js, transitively through command.js:12. Byte
 * sizes: command.js 87647, help.js 20812, option.js 10237, argument.js 3134,
 * suggestSimilar.js 2735, error.js 1089 — so this row prices ~126 KB of
 * third-party JS parsed + evaluated per invocation.
 */
describe('commander module load (bootstrap.ts) — the third-party eager edge no first-party spec list covers', () => {
  bench('FLOOR: bare `node --input-type=module -e ""` — the spawn cost the row below also pays; subtract it', () => {
    coldEval([]);
  }, COLD_OPTS);

  bench('import commander — the exact specifier at index.ts:10, its 6-module ESM graph into a fresh process', () => {
    coldEval([COMMANDER_SPEC]);
  }, COLD_OPTS);

  bench('FLOOR with a warm NODE_COMPILE_CACHE — the same bare process, so the pair below is comparable to the pair above', () => {
    coldEval([], COMPILE_CACHE_ENV);
  }, COLD_OPTS);

  bench('import commander with a warm NODE_COMPILE_CACHE — same graph, V8 compilation served from the on-disk code cache instead of re-parsing ~126 KB per process', () => {
    coldEval([COMMANDER_SPEC], COMPILE_CACHE_ENV);
  }, COLD_OPTS);
});

/**
 * ============================================================================
 * The root program and its audit backbone (index.ts:260-371).
 *
 * After the eager module graph, every invocation runs this block before
 * `program.parseAsync()` (index.ts:1480) can dispatch anything:
 *
 *   index.ts:260  const BRAND = resolveBrandName()            (priced in brand.bench.ts)
 *   index.ts:262  const program = new Command()
 *   index.ts:264-270  .name/.description/.version/.option/.helpOption/.addHelpCommand
 *   index.ts:290  const auditStarts = new WeakMap<Command, number>()
 *   index.ts:300-303  AUDIT_EXEMPT_COMMANDS = new Set([...])
 *   index.ts:305  program.hook('preAction', ...)
 *   index.ts:325  program.hook('postAction', ...)
 *
 * `auditCommandPath` (index.ts:280-288), the two hook closures, `auditStarts`
 * and `AUDIT_EXEMPT_COMMANDS` are all PRIVATE to index.ts and index.ts cannot be
 * imported (top-level await, argv reads, an eventual `program.parse()` — see the
 * docblock at the top of this file), so they are reproduced verbatim below,
 * character for character against index.ts:280-371, with two mechanical
 * adjustments that are named rather than hidden:
 *
 *   1. `BRAND` (index.ts:260) becomes the constant `'agents'` — the unbranded
 *      value `resolveBrandName()` returns for every plain `agents`/`ag` call on
 *      this fleet (brand.ts:34-38; brand.bench.ts prices the branded variant).
 *   2. The two `void import(...)` specifiers are rewritten from index.ts's
 *      `./lib/analytics/usage-db.js` / `./lib/perf/spool.js` to
 *      `./analytics/usage-db.js` / `./perf/spool.js`, because this file sits in
 *      src/lib/ and index.ts in src/. Same modules.
 *
 * WHAT IS AND IS NOT INSIDE A SAMPLE. The postAction spool branch
 * (index.ts:351-367) is `void import(...).then(...)` — fire-and-forget, never
 * awaited by the hook. Its module import and `recordSample` write therefore
 * settle on a later turn, OUTSIDE the timed body; what the rows below capture
 * from it is the synchronous `stampProvenance()` (index.ts:356, which runs
 * in-line) plus the dynamic-import initiation. Be precise about what "outside"
 * buys, though: `recordSample` ends in a synchronous `fs.appendFileSync`
 * (perf/spool.ts:78, inside recordSample at perf/spool.ts:49), so on a bench that dispatches thousands of times per
 * second that write lands BETWEEN samples on the same thread — it is excluded
 * from the sample, not from the machine. It is present identically in the
 * hooked and the one-append rows, so it cancels in the delta those rows are
 * read for. The `parts[0] === 'run'` usage-db branch (index.ts:338-349) is
 * never reached by the benched command paths. This is stated, not glossed,
 * because a reader could otherwise take the composed number as including a
 * real perf-spool append.
 *
 * NO MOCKING. The hook bodies call the REAL `redactArgs` / `emit` /
 * `stampProvenance` from events.ts / event-provenance.ts against a real temp
 * events sink (proper-lockfile lock + appendFileSync + rotate/prune checks), the
 * REAL commander dispatch (`_chainOrCallHooks`, command.js:1511-1531, invoked at
 * command.js:1614 and 1623), and real `parseAsync` runs over registered
 * commands. events.bench.ts owns the ISOLATED function timings —
 * `redactArgs` (events.bench.ts:177-179), `stampProvenance`
 * (events.bench.ts:183-191), `emit` (events.bench.ts:195-205) and the
 * hand-composed envelope (events.bench.ts:209-213). What is measured here and
 * NOWHERE else is the commander-side wiring — hook registration,
 * `_chainOrCallHooks`'s ancestor-walk + filter + array build per dispatch,
 * `auditCommandPath`'s own walk, and the exempt gate — plus the composed
 * per-invocation delta as commander actually dispatches it.
 */
const BENCH_BRAND = 'agents';

/** Verbatim index.ts:280-288, with BRAND -> BENCH_BRAND (see docblock). */
function auditCommandPath(cmd: Command): string[] {
  const parts: string[] = [];
  let c: Command | null | undefined = cmd;
  while (c && c.name() && c.name() !== BENCH_BRAND) {
    parts.unshift(c.name());
    c = c.parent;
  }
  return parts;
}

/** Verbatim index.ts:290. */
const auditStarts = new WeakMap<Command, number>();

/** Verbatim index.ts:300-303. */
const AUDIT_EXEMPT_COMMANDS: ReadonlySet<string> = new Set([
  'events emit',
  '_internal friction',
]);

/** Verbatim index.ts:264-270 — the root option chain, unbranded, real VERSION. */
function buildRootProgram(): Command {
  return new Command()
    .name(BENCH_BRAND)
    .description('Environment manager for AI agents')
    .version(REAL_VERSION)
    .option('--verbose', 'Show startup self-heal details on stderr')
    .helpOption('-h, --help', 'Show help')
    .addHelpCommand(false);
}

/** Verbatim index.ts:305-371 (both hook registrations and both bodies). */
function attachAuditHooks(program: Command): Command {
  program.hook('preAction', (_thisCommand, actionCommand) => {
    try {
      const parts = auditCommandPath(actionCommand);
      if (parts.length === 0) return;
      if (AUDIT_EXEMPT_COMMANDS.has(parts.join(' '))) return;
      auditStarts.set(actionCommand, Date.now());
      emit('command.start', {
        module: parts[0],
        command: parts.join(' '),
        args: redactArgs(process.argv.slice(2, 22)),
        cwd: process.cwd(),
      });
    } catch {
      // Audit logging must never break command dispatch.
    }
  });

  program.hook('postAction', (_thisCommand, actionCommand) => {
    try {
      const parts = auditCommandPath(actionCommand);
      if (parts.length === 0) return;
      if (AUDIT_EXEMPT_COMMANDS.has(parts.join(' '))) return;
      const started = auditStarts.get(actionCommand);
      const durationMs = started !== undefined ? Date.now() - started : undefined;
      const command = parts.join(' ');
      emit('command.end', {
        module: parts[0],
        command,
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
      if (parts[0] === 'run') {
        const agentName = actionCommand.args?.[0] ? String(actionCommand.args[0]).split('@')[0] : 'run';
        void import('./analytics/usage-db.js').then(({ recordUsage }) => {
          recordUsage({
            kind: 'agent',
            name: agentName || 'run',
            event: 'invoke',
            source: 'cli',
            meta: durationMs !== undefined ? { durationMs } : undefined,
          });
        }).catch(() => { /* fail soft */ });
      }
      if (durationMs !== undefined && parts[0] !== 'perf') {
        const { sessionId, agent } = stampProvenance();
        void import('./perf/spool.js').then(({ recordSample }) => {
          recordSample({
            kind: 'command.end',
            label: command,
            durationMs,
            cwd: process.cwd(),
            sessionId,
            agent,
          });
        }).catch(() => { /* fail soft */ });
      }
    } catch {
      // Best-effort completion record; the start line is the durable audit fact.
    }
  });
  return program;
}

/**
 * Register the command shapes the dispatch rows parse. `noop` is a depth-1
 * action command (`auditCommandPath` -> ['noop']); `sessions list` is depth-2
 * (['sessions','list']) so the ancestor walk in BOTH `auditCommandPath`
 * (index.ts:283-286) and commander's `_getCommandAndAncestors()`
 * (command.js:1514) runs one level deeper; `events emit` is depth-2 AND the
 * first member of AUDIT_EXEMPT_COMMANDS (index.ts:301), so both hooks return at
 * index.ts:309 / index.ts:329 before any emit.
 *
 * Each action bumps a counter the preflight asserts on — a row whose command
 * silently stopped dispatching (renamed, mis-parsed) would otherwise keep
 * posting a plausible number for work that never ran.
 */
let dispatchCount = 0;
function registerBenchCommands(program: Command): Command {
  program.command('noop').action(() => { dispatchCount++; });
  const sessions = program.command('sessions');
  sessions.command('list').action(() => { dispatchCount++; });
  const events = program.command('events');
  events.command('emit').action(() => { dispatchCount++; });
  return program;
}

/**
 * COUNTERFACTUAL, not the shipped path: the preAction `emit('command.start', …)`
 * (index.ts:311-319) is FOLDED INTO the postAction record rather than deleted,
 * so one record is appended per invocation instead of two and no audited field
 * is lost. It prices the single change the measured numbers point at — a row
 * that prices a decision the source has not taken.
 *
 * Exactly two differences from `attachAuditHooks`, and no others — the wiring,
 * the path walk, the exempt gate, the WeakMap stamp, the spool branch and the
 * `run` branch are all carried over unchanged:
 *
 *   1. preAction keeps `auditStarts.set` (index.ts:310) and drops the `emit`
 *      (index.ts:311-319).
 *   2. postAction's `command.end` record (index.ts:333-337) gains the two
 *      fields that record carried — `args: redactArgs(process.argv.slice(2, 22))`
 *      (index.ts:317) and `cwd` (index.ts:318).
 *
 * So `redactArgs` is NOT dropped: it moves. That matters for reading the row —
 * the saving this prices is one full lock/append cycle, not the redaction work.
 */
function attachPostActionOnlyAuditHook(program: Command): Command {
  program.hook('preAction', (_thisCommand, actionCommand) => {
    try {
      const parts = auditCommandPath(actionCommand);
      if (parts.length === 0) return;
      if (AUDIT_EXEMPT_COMMANDS.has(parts.join(' '))) return;
      auditStarts.set(actionCommand, Date.now());
    } catch {
      // Audit logging must never break command dispatch.
    }
  });

  program.hook('postAction', (_thisCommand, actionCommand) => {
    try {
      const parts = auditCommandPath(actionCommand);
      if (parts.length === 0) return;
      if (AUDIT_EXEMPT_COMMANDS.has(parts.join(' '))) return;
      const started = auditStarts.get(actionCommand);
      const durationMs = started !== undefined ? Date.now() - started : undefined;
      const command = parts.join(' ');
      emit('command.end', {
        module: parts[0],
        command,
        args: redactArgs(process.argv.slice(2, 22)),
        cwd: process.cwd(),
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
      if (parts[0] === 'run') {
        const agentName = actionCommand.args?.[0] ? String(actionCommand.args[0]).split('@')[0] : 'run';
        void import('./analytics/usage-db.js').then(({ recordUsage }) => {
          recordUsage({
            kind: 'agent',
            name: agentName || 'run',
            event: 'invoke',
            source: 'cli',
            meta: durationMs !== undefined ? { durationMs } : undefined,
          });
        }).catch(() => { /* fail soft */ });
      }
      if (durationMs !== undefined && parts[0] !== 'perf') {
        const { sessionId, agent } = stampProvenance();
        void import('./perf/spool.js').then(({ recordSample }) => {
          recordSample({
            kind: 'command.end',
            label: command,
            durationMs,
            cwd: process.cwd(),
            sessionId,
            agent,
          });
        }).catch(() => { /* fail soft */ });
      }
    } catch {
      // Best-effort completion record; the start line is the durable audit fact.
    }
  });
  return program;
}

/** Root wired exactly like index.ts:262-371, plus the benched command shapes. */
const HOOKED_PROGRAM = registerBenchCommands(attachAuditHooks(buildRootProgram()));
/** Identical root with NO hooks — the commander-only dispatch baseline. */
const UNHOOKED_PROGRAM = registerBenchCommands(buildRootProgram());
/** Identical root, one audit append per invocation instead of two. */
const ONE_APPEND_PROGRAM = registerBenchCommands(attachPostActionOnlyAuditHook(buildRootProgram()));

/**
 * Real temp events sink so the hooks' `emit()` takes the real proper-lockfile
 * lock and appends to a real file. Same seam events.bench.ts:137 and
 * events.test.ts:42 use. The perf spool is redirected too: the postAction
 * branch at index.ts:351-367 writes through `getPerfDir()`, which reads
 * AGENTS_PERF_DIR at call time (state.ts:654-656), so without this a bench run
 * would append samples into the user's real ~/.agents/.cache. Set at module
 * scope so the cold-spawn rows elsewhere in this file inherit the same
 * redirect.
 */
const AUDIT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-audit-bench-'));
const AUDIT_SINK = path.join(AUDIT_TMP, 'events.jsonl');
process.env.AGENTS_PERF_DIR = path.join(AUDIT_TMP, 'perf');
_resetForTest(AUDIT_SINK);

/**
 * The hook bodies read `process.argv.slice(2, 22)` verbatim (index.ts:317).
 * Under vitest that is the worker's argv, whose `slice(2)` is EMPTY — so
 * without this swap every hooked row would redact and serialize nothing, and
 * the measured tax would be for a record with `args: []` rather than a real
 * command line. The realistic shape below matches events.bench.ts:145-158 (a
 * >200-char prompt hitting the sha256 marker branch at events.ts:557/582, a
 * session id, a device, a path), so the redaction branches exercised here are
 * the ones a real `agents` invocation takes.
 *
 * THIS MUST BE MODULE SCOPE, NOT A SUITE `beforeAll`. Verified against this
 * repo's pinned vitest 4.1.9: in BENCH mode `runBenchmarkSuite` recurses into
 * nested suites itself and never dispatches `callSuiteHook(..., 'beforeAll')`,
 * so a `beforeAll` inside a `describe` silently never fires — an earlier
 * revision of this file put the swap there and every hooked row measured the
 * empty worker argv. Only FILE-level hooks run, which is why the `afterAll`
 * restore below does work. argv[0]/argv[1] are preserved; nothing else in this
 * file reads `process.argv`.
 */
const REAL_ARGV = process.argv;
process.argv = [
  process.argv[0], process.argv[1],
  'sessions', 'list', '--json', '--limit', '50',
  '--query', 'benchmark the commander root bootstrap and audit hooks in cli/src/index.ts, read the call path end to end, commit a vitest bench beside the source, and propose optimizations from the measured numbers only',
  '--session', 'ce1e00cb-61dc-4c62-b30e-f053ef6ce990',
  '--device', 'yosemite-s1',
  '--cwd', '/home/muqsit/src/github.com/muqsitnawaz/agents-cli',
];

afterAll(() => {
  process.argv = REAL_ARGV;
  _resetForTest();
  try { fs.rmSync(AUDIT_TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

/**
 * Prove every dispatch row actually reaches its action handler BEFORE any row is
 * timed — module scope, so a throw here fails the suite instead of posting NaN
 * (same reasoning as preflightColdImports above). Also primes the sink's prune
 * marker and the provenance/chmod caches so timed emits measure steady state,
 * not the one-time first-append prune.
 */
await (async function preflightAuditDispatch(): Promise<void> {
  const before = dispatchCount;
  await HOOKED_PROGRAM.parseAsync(['node', 'agents', 'noop']);
  await HOOKED_PROGRAM.parseAsync(['node', 'agents', 'sessions', 'list']);
  await HOOKED_PROGRAM.parseAsync(['node', 'agents', 'events', 'emit']);
  await UNHOOKED_PROGRAM.parseAsync(['node', 'agents', 'noop']);
  await UNHOOKED_PROGRAM.parseAsync(['node', 'agents', 'events', 'emit']);
  await ONE_APPEND_PROGRAM.parseAsync(['node', 'agents', 'noop']);
  if (dispatchCount !== before + 6) {
    throw new Error(
      `audit dispatch preflight: expected 6 actions to fire, got ${dispatchCount - before} — these rows are measuring the wrong path`,
    );
  }
  if (!fs.existsSync(AUDIT_SINK)) {
    throw new Error(`audit dispatch preflight: the hooks never wrote ${AUDIT_SINK} — emit() is not on this path`);
  }
  // The argv swap above is the whole difference between measuring a real
  // command line and measuring an empty one, and it is invisible in the row
  // output — so assert the record the hooks actually wrote carries the redacted
  // args, not `[]`. Without this the file would silently regress to the bug a
  // suite-level `beforeAll` introduced.
  const starts = fs.readFileSync(AUDIT_SINK, 'utf-8').trimEnd().split('\n')
    .map((line) => JSON.parse(line) as { event?: string; args?: unknown })
    .filter((rec) => rec.event === 'command.start');
  if (starts.length === 0) {
    throw new Error(`audit dispatch preflight: no command.start record in ${AUDIT_SINK} — the preAction hook did not emit`);
  }
  for (const rec of starts) {
    if (!Array.isArray(rec.args) || rec.args.length === 0) {
      throw new Error(
        `audit dispatch preflight: a command.start record carries args=${JSON.stringify(rec.args)} — the process.argv swap did not take, so every hooked row would measure an empty command line`,
      );
    }
  }
})();

/**
 * Time-bounded so the cumulative sink stays far below the 10 MiB gzip-rotation
 * threshold (events.ts:107) and no rotation skews a sample — the same bound and
 * the same reason as events.bench.ts:169-174.
 */
const PARSE_OPTS = { time: 400, iterations: 20, warmupTime: 100 } as const;

describe('root program construction (index.ts:262-270) — commander work every invocation does before parse, warm in-process', () => {
  bench('new Command() alone (index.ts:262)', () => {
    new Command();
  });

  bench('the real chain: new Command() + .name().description().version().option().helpOption().addHelpCommand(false) (index.ts:262-270), with the real VERSION and the unbranded name', () => {
    buildRootProgram();
  });

  bench('program.hook("preAction", …) + program.hook("postAction", …) — registration ONLY (index.ts:305, 325). commander pushes each listener onto `_lifeCycleHooks[event]` (command.js:488-499); no body runs here', () => {
    const p = new Command();
    attachAuditHooks(p);
  });

  bench('the COMPLETE root bootstrap: option chain + both audit-hook registrations (index.ts:262-371) — everything between resolveBrandName() and the first command registration', () => {
    attachAuditHooks(buildRootProgram());
  });
});

describe('audit-hook body pieces (index.ts:280-288, 309) — the per-dispatch work that runs BEFORE emit(), measured nowhere else', () => {
  bench('auditCommandPath(depth-1 action command) — one loop turn + one unshift, then the BRAND compare stops at the root (index.ts:283-286)', () => {
    auditCommandPath(HOOKED_PROGRAM.commands[0]);
  });

  bench('auditCommandPath(depth-2 action command, `sessions list`) — two loop turns, two unshifts into the same array (index.ts:283-286)', () => {
    auditCommandPath(HOOKED_PROGRAM.commands[1].commands[0]);
  });

  bench('the exempt gate as written: parts.join(" ") + AUDIT_EXEMPT_COMMANDS.has(...) on a depth-2 path (index.ts:309). preAction and postAction each run this, and postAction joins a THIRD time at index.ts:332', () => {
    const parts = ['sessions', 'list'];
    AUDIT_EXEMPT_COMMANDS.has(parts.join(' '));
  });
});

describe('the real per-invocation audit tax — `program.parseAsync` through commander\'s hook dispatch (command.js:1614, 1623), hooks attached vs not', () => {
  bench('BASELINE `agents noop`: NO hooks attached. Pure commander dispatch — argv parse, _processArguments, _chainOrCall(action). `_chainOrCallHooks` still runs twice but finds nothing (command.js:1511-1531)', async () => {
    await UNHOOKED_PROGRAM.parseAsync(['node', 'agents', 'noop']);
  }, PARSE_OPTS);

  bench('BASELINE `agents events emit`: NO hooks, depth-2. The depth-matched control for the exempt row below — commander descends one more subcommand level (_dispatchSubcommand), which the depth-1 baseline does not pay', async () => {
    await UNHOOKED_PROGRAM.parseAsync(['node', 'agents', 'events', 'emit']);
  }, PARSE_OPTS);

  bench('`agents noop` WITH both audit hooks: the same dispatch plus the real preAction+postAction — auditCommandPath ×2, join ×3, WeakMap set/get, redactArgs, TWO real emit() appends, stampProvenance. Delta vs the baseline above IS the audit tax per invocation', async () => {
    await HOOKED_PROGRAM.parseAsync(['node', 'agents', 'noop']);
  }, PARSE_OPTS);

  bench('`agents events emit` WITH both hooks — AUDIT_EXEMPT_COMMANDS hit (index.ts:301, 309/329), so both bodies return before emit. Read against the DEPTH-MATCHED unhooked `events emit` row above, not the depth-1 one: that delta isolates the WIRING alone — commander\'s per-dispatch hook assembly + the path walk + the join/Set gate, with zero fs work', async () => {
    await HOOKED_PROGRAM.parseAsync(['node', 'agents', 'events', 'emit']);
  }, PARSE_OPTS);

  bench('`agents sessions list` WITH both hooks — depth-2, non-exempt: one more ancestor in commander\'s _getCommandAndAncestors() (command.js:1514) and one more unshift per auditCommandPath call, on top of the same two emits', async () => {
    await HOOKED_PROGRAM.parseAsync(['node', 'agents', 'sessions', 'list']);
  }, PARSE_OPTS);

  bench('COUNTERFACTUAL `agents noop` with ONE append: same wiring, preAction\'s emit(command.start) (index.ts:311-319) folded into the postAction record. Not the shipped path — this row prices dropping one of the two synchronous appends', async () => {
    await ONE_APPEND_PROGRAM.parseAsync(['node', 'agents', 'noop']);
  }, PARSE_OPTS);
});

describe('whole-invocation anchor — real cold `node dist/index.js --version` (the denominator for every row above)', () => {
  bench('`agents --version` — pays the full eager module graph (index.ts:10-218), detectDevBuild (index.ts:113), the program chain + audit hooks (index.ts:262-371), It skips checkForUpdates + spawnDetachedSync, ensureInitialized, the menu-bar self-heal, AND the migration hops (foldLegacySystemRepo via migrate-fold.js + runMigration via migrate.js) — all gated by !helpOrVersionRequested (RUSH-2454). A real command with a current v20 sentinel still pays only the leaf fold import, not the full migrate.js graph', () => {
    expectExit(runCli(['--version']), [0], '--version');
  }, { time: 4000, iterations: 15 });

  bench('FLOOR: bare `node --input-type=module -e ""` — same Node startup, no CLI. The gap is everything agents-cli adds to `--version`', () => {
    coldEval([]);
  }, { time: 4000, iterations: 15 });
});

/**
 * ============================================================================
 * The menu-bar startup self-heal (index.ts:1421-1425):
 *
 *   if (process.platform === 'darwin' && process.env.AGENTS_SKIP_MIGRATION !== '1') {
 *     try {
 *       const { installMenubarLaunchAgentOnUpgrade } = await import('./lib/menubar/install-menubar.js');
 *       installMenubarLaunchAgentOnUpgrade();
 *     } catch { }
 *   }
 *
 * Same `!helpOrVersionRequested` gate as checkForUpdates/spawnDetachedSync
 * and the migration hops (RUSH-2346 / RUSH-2454): on darwin the self-heal
 * runs for real commands only, not `--help`/`--version`. It sits between
 * the migration hops and the bare-invocation help branch.
 *
 * THIS BOX IS LINUX (yosemite-s1), so `process.platform === 'darwin'` is
 * false and in real production this whole block -- import included -- never
 * executes here. Two things are still truthfully measurable on Linux and are
 * benched below; nothing about the macOS decision path is inferred or
 * invented from them:
 *
 *   1. THE MODULE IMPORT ITSELF (index.ts:1423) is plain ESM module
 *      resolution/evaluation with no platform branch at module scope in
 *      install-menubar.ts or any of its static imports (fs-atomic.ts,
 *      state.ts, version.ts, app-bundle-install.ts, agent-spec/primitives.ts
 *      -- verified by reading each for `^import`/`process.platform` before
 *      writing this bench). The bytes evaluated and the syscalls issued to
 *      resolve them are the same on darwin and Linux; only wall-clock speed
 *      differs by machine, which is why this whole file is dispatched on a
 *      fixed box rather than compared across boxes. So a cold-process import
 *      of dist/lib/menubar/install-menubar.js on this box IS the real cost
 *      index.ts:1423 pays before installMenubarLaunchAgentOnUpgrade() can
 *      even be called, on any platform.
 *   2. CALLING installMenubarLaunchAgentOnUpgrade() ITSELF, in-process, on
 *      this real Linux box. install-menubar.ts:630-632:
 *
 *        export function installMenubarLaunchAgentOnUpgrade(): void {
 *          try {
 *            if (!onDarwin()) return;
 *
 *      `onDarwin()` (install-menubar.ts:49-51) is `process.platform ===
 *      'darwin'`, so on THIS box the call returns after one property read --
 *      that is what the row below actually measures, honestly, for Linux.
 *
 * What is explicitly NOT benched, because it cannot be invoked truthfully on
 * a non-darwin box (the task's own instruction): everything past the
 * `!onDarwin()` guard -- menubarDisabledByUser() (existsSync on
 * disabledSentinelPath), menubarServiceInstalled() (existsSync on
 * servicePlistPath), menubarSetupStale() (existsSync + readFileSync on the
 * installed version marker), menubarSetupNeedsRepoint() (readFileSync +
 * regex match on the plist XML), installedNeedsDevIdHeal() (existsSync +
 * codesign spawnSync via hasDeveloperIdSignature), and mayHealMenubar()'s
 * cooldown read (install-menubar.ts:633-654). Those are the "two existsSync
 * checks then return" the index.ts:1418 comment describes, and the docblock
 * at install-menubar.ts:616-628 names them as running "on every darwin CLI
 * invocation" -- but on Linux `onDarwin()` returns before a single one of
 * them executes, so their real filesystem cost is UNVERIFIED here. No
 * darwin timings are invented for them; the pure decision functions among
 * them (isMenubarStale, menubarPlistNeedsRepoint, mayInstallMenubarHelper)
 * are unit-tested in install-menubar.test.ts, not benched, since they take
 * no I/O and are not where the described cost lives.
 *
 * No mocking: both groups run the real built dist/lib/menubar/install-
 * menubar.js and the real exported installMenubarLaunchAgentOnUpgrade().
 */
describe('menu-bar startup self-heal (index.ts:1421-1425) — cold module import, the real cost paid before the darwin gate can even run', () => {
  bench('FLOOR: bare `node --input-type=module -e ""` — same spawn cost every row below also pays; subtract it', () => {
    coldEval([]);
  }, COLD_OPTS);

  bench('lib/menubar/install-menubar.js — the exact specifier dynamically imported at index.ts:1423, its static graph incl. state.js (1382 lines), version.js, app-bundle-install.js, fs-atomic.js, agent-spec/primitives.js', () => {
    coldEval([MENUBAR_INSTALL_SPEC]);
  }, COLD_OPTS);
});

describe('installMenubarLaunchAgentOnUpgrade() — warm in-process call on THIS Linux box (install-menubar.ts:630-658)', () => {
  bench('real call on Linux: returns at the `!onDarwin()` guard (install-menubar.ts:632) after one process.platform read — NOT representative of the darwin decision path (menubarServiceInstalled/menubarSetupStale/mayHealMenubar fs checks), which is unverified on this box; see docblock above', () => {
    installMenubarLaunchAgentOnUpgrade();
  });
});

/**
 * ============================================================================
 * White-label bootstrap: `resolveBrandName()` (index.ts:241) and
 * `disabledCommandsForActiveBrand()` (index.ts:1244), both from
 * `./lib/brand.js` (statically imported at index.ts:514). Unlike every other
 * group above, this import is a plain top-level `import { ... } from
 * './lib/brand.js'` — ESM hoists it, so it is evaluated at module-load time
 * regardless of where the line sits textually, and it runs on EVERY
 * invocation: `resolveBrandName()` at index.ts:241 fires unconditionally
 * before `program = new Command()`, and `disabledCommandsForActiveBrand()` at
 * index.ts:1244 fires unconditionally before command registration, gated by
 * neither `--help`/`--version` nor a `requestedCommand` check. This includes
 * the plain, unbranded `agents` CLI — brand.ts's docblock says brands make
 * "everything below ... byte-identical to before" for the unbranded case, but
 * that claim is about *behavior*, not *import cost*: the module graph brand.ts
 * pulls in at load time is paid before `resolveBrandName()` can tell you which
 * case you are in.
 *
 * RUSH-2331 cut the brand → agents → versions edge: brand.ts now imports the
 * zero-dep `agent-cli-commands.js` leaf for reservedBrandNames(), so a cold
 * `import('./lib/brand.js')` no longer evaluates agents.js or versions.js.
 * The agents.js / versions.js rows below remain as regression baselines (and
 * as isolated costs for callers that still import those modules on demand).
 * brand.js's remaining real imports are state.js (already eager at index.ts
 * near brand) and the leaf command-name list.
 *
 * No mocking: every row spawns a real cold `node --input-type=module`
 * process and imports the real built dist/lib/*.js artifact — the same files
 * `node dist/index.js` loads on a real invocation.
 */
describe('brand.js eager import (index.ts:514) — cold module import, the graph paid before resolveBrandName()/disabledCommandsForActiveBrand() can even run, on EVERY invocation incl. the unbranded fast path', () => {
  bench('FLOOR: bare `node --input-type=module -e ""` — same spawn cost every row below also pays; subtract it', () => {
    coldEval([]);
  }, COLD_OPTS);

  bench('lib/brand.js alone — the exact specifier statically imported at index.ts:514 (brand.ts is 134 lines; this row is dominated by its own static imports, not its own body)', () => {
    coldEval([BRAND_SPEC]);
  }, COLD_OPTS);

  bench('lib/agents.js alone — REGRESSION BASELINE (RUSH-2331): brand.ts no longer imports this; was the sole eager edge into agents/versions. agents.ts still imports versions.ts for on-demand callers', () => {
    coldEval([AGENTS_REGISTRY_SPEC]);
  }, COLD_OPTS);

  bench('lib/versions.js alone — the graph agents.ts:26 imports back from (circular with agents.ts, versions.ts:35), 3738 lines, the largest static-import fan-out in this package: resources.ts, resource-profiles.ts, permissions.ts, mcp.ts, convert.ts, import.ts, subagents.ts, workflows.ts, hooks.ts, capabilities.ts, plugins.ts, rules/compose.ts, staleness/*, memory.ts, project-resources.ts, @inquirer/prompts (versions.ts:17-68)', () => {
    coldEval([VERSIONS_SPEC]);
  }, COLD_OPTS);

  bench('lib/state.js alone — brand.ts\'s other real import (types.js is type-only, erased at compile). Already paid separately at index.ts:513 regardless of the brand edge, so this row is the baseline the marginal-cost group below needs', () => {
    coldEval([STATE_SPEC]);
  }, COLD_OPTS);

  bench('lib/types.js alone — the third brand.ts import (brand.ts:21 `import type { BrandConfig } from \'./types.js\'`), erased at compile so this row prices only its OWN static value imports, not a type-only reference', () => {
    coldEval([TYPES_SPEC]);
  }, COLD_OPTS);
});

/**
 * The rows above measure each module ISOLATED — a fresh process importing
 * ONLY that one specifier. That answers "how much does brand.js cost on its
 * own", but not "how much does brand.js cost ON TOP OF what a real `agents`
 * invocation already loaded by the time it reaches index.ts:514" — and those
 * two numbers are very different, because self-update.js (index.ts:86-95,
 * BEFORE brand.js) already imports versions.js (self-update.ts:20), which
 * pulls in agents.js via the versions.ts<->agents.ts circular pair verified
 * above. By the time index.ts:514's `import ... from './lib/brand.js'`
 * evaluates, agents.js may already be warm in the SAME process's module
 * cache from self-update.js's own import — cold-import isolation cannot see
 * that sharing, because each isolated row above starts from a bare process
 * with nothing preloaded.
 *
 * This group measures the two real invocation shapes back to back in the
 * SAME kind of fresh process: index.ts's 12 other eager local-module imports
 * (dev-build, sync-commands, self-update, command-registry, help, whats-new,
 * platform/index, cli-entry, events, event-provenance, format, state — every
 * eager local import EXCEPT brand.js) with and without brand.js appended.
 * The delta between the two rows is brand.js's TRUE marginal cost inside a
 * real invocation, net of whatever self-update.js already shared with it —
 * which the isolated numbers above cannot show.
 */
describe('brand.js MARGINAL cost on top of the rest of the eager graph — does self-update.js already pay for what brand.js needs?', () => {
  bench('EAGER_MINUS_BRAND: the 12 other index.ts eager local imports (index.ts:16,36,86-95,124,208,209,211-215,513), no brand.js edge', () => {
    coldEval(EAGER_MINUS_BRAND);
  }, COLD_OPTS);

  bench('EAGER_WITH_BRAND: same 12 + lib/brand.js (index.ts:514) — the delta vs the row above is brand.js\'s real marginal startup cost once self-update.js\'s own versions.js->agents.js edge has already run in this process', () => {
    coldEval(EAGER_WITH_BRAND);
  }, COLD_OPTS);
});

/**
 * The call-time cost, warm in-process, on THIS real machine's real
 * ~/.agents/agents.yaml — contrasted against the import-time cost measured
 * above. resolveBrandName() (brand.ts:34-38) is one env-var read plus a
 * regex test; disabledCommandsForActiveBrand() (brand.ts:102-105) calls
 * getActiveBrandConfig() (brand.ts:84-90), which short-circuits at
 * `if (!name) return null` the moment activeBrandName() reports unbranded —
 * so on the unbranded fast path it NEVER calls readMeta() (state.ts:1124),
 * i.e. zero filesystem syscalls. Only when AGENTS_BRAND names something (real
 * or not) does getBrandConfig() -> listBrands() -> readMeta() actually touch
 * disk. readMeta() caches its parsed result keyed to a file-content stamp
 * (state.ts:1127-1134: "reduces N readMeta calls per CLI invocation to ~2 stat
 * syscalls"), so after the very first sample in a bench loop every further
 * iteration measures that warm 2-stat cache-hit path, not a genuinely cold
 * single-process disk read — an honest caveat, not a claim of a cold read.
 * This box's real ~/.agents/agents.yaml (verified: `ls -la ~/.agents/agents.yaml`)
 * has no `brands:` key configured, so the third row exercises a real,
 * unconfigured brand name rather than a fabricated meta.brands entry.
 *
 * The point these rows make together with the group above: on the unbranded
 * fast path, the CALL is free (no readMeta) but the IMPORT is not — the
 * entire cost this file's brand.js group measures is paid at module-load
 * time regardless of which branch resolveBrandName() ends up reporting.
 */
describe('resolveBrandName() / disabledCommandsForActiveBrand() — warm in-process calls (index.ts:241, 1244), real ~/.agents/agents.yaml on this box', () => {
  const ORIGINAL_AGENTS_BRAND = process.env.AGENTS_BRAND;
  afterAll(() => {
    if (ORIGINAL_AGENTS_BRAND === undefined) delete process.env.AGENTS_BRAND;
    else process.env.AGENTS_BRAND = ORIGINAL_AGENTS_BRAND;
  });

  bench('resolveBrandName() unbranded (AGENTS_BRAND unset) — index.ts:241, one env read + DEFAULT_CLI_NAME return, no regex test on the unset path (brand.ts:34-38)', () => {
    delete process.env.AGENTS_BRAND;
    resolveBrandName();
  });

  bench('activeBrandName() unbranded — resolveBrandName() + one string compare, returns null (brand.ts:41-44)', () => {
    delete process.env.AGENTS_BRAND;
    activeBrandName();
  });

  bench('isBranded() unbranded — activeBrandName() + one null check (brand.ts:47-49)', () => {
    delete process.env.AGENTS_BRAND;
    isBranded();
  });

  bench('disabledCommandsForActiveBrand() unbranded — index.ts:1244, short-circuits at getActiveBrandConfig (brand.ts:86: `if (!name) return null`) BEFORE readMeta() ever runs. This is the real cost every unbranded invocation on this fleet pays today: zero fs syscalls', () => {
    delete process.env.AGENTS_BRAND;
    disabledCommandsForActiveBrand();
  });

  bench('resolveBrandName() branded — AGENTS_BRAND set to a real-shaped name, regex-validated and returned as-is (brand.ts:36)', () => {
    process.env.AGENTS_BRAND = 'agents-cli-bench-nonexistent-brand';
    resolveBrandName();
  });

  bench('disabledCommandsForActiveBrand() with AGENTS_BRAND set to a real-shaped but unconfigured name — the branded-invocation floor: getBrandConfig (brand.ts:75) -> listBrands (brand.ts:70) -> readMeta() (state.ts:1124), a real ~/.agents/agents.yaml stat+read+parse (warm-cached after the first sample; see docblock), even though the brand does not exist in this box\'s real meta.brands and cfg ends up undefined', () => {
    process.env.AGENTS_BRAND = 'agents-cli-bench-nonexistent-brand';
    disabledCommandsForActiveBrand();
  });

  bench('readMeta() alone, warm — the exact hop the branded row above pays (state.ts:1124), isolated from brand.ts\'s own dispatch so its warm cache-hit cost (state.ts:1127-1134) can be read on its own', () => {
    readMeta();
  });
});

/**
 * Startup package metadata (index.ts:30-34). These top-level statements run
 * before either argv intercept can exit. The in-process rows decompose the real
 * read and parse; the existing cold `--version` row above is the end-to-end
 * process anchor, and asserts its child exit status.
 */
const PACKAGE_JSON_PATH = path.join(CLI_ROOT, 'package.json');
const PACKAGE_JSON_RAW = fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8');

describe('startup package.json read + parse (index.ts:30-34)', () => {
  bench('fs.readFileSync(packageJsonPath, "utf-8") — the real cli/package.json', () => {
    fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8');
  });

  bench('JSON.parse(already-read package.json) — parse cost without the filesystem read', () => {
    JSON.parse(PACKAGE_JSON_RAW);
  });

  bench('readFileSync + JSON.parse + .version — the complete top-level metadata statement', () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as { version?: unknown };
    void pkg.version;
  });
});

/**
 * The settled-install work represented by index.ts:1394-1446, without invoking
 * either mutating entry point. Calling foldLegacySystemRepo() could rename or
 * remove the live legacy tree; calling ensureInitialized() can prompt, exit, or
 * run setup. The rows therefore execute only the exact non-mutating probes those
 * functions use on the steady path, against paths from state.ts.
 */
function probeLegacySystemRepo(): void {
  try {
    fs.lstatSync(LEGACY_SYSTEM_DIR);
  } catch {
    // An absent legacy directory is the normal post-fold state.
  }
}

function probeMigrationSentinel(): void {
  if (
    fs.existsSync(MIGRATED_SENTINEL_FILE) &&
    fs.readFileSync(MIGRATED_SENTINEL_FILE, 'utf-8').trim() === MIGRATION_SENTINEL_VALUE
  ) {
    // needRun = false; the mutating migration sweep stays outside this bench.
  }
}

describe('settled init/migration probes (index.ts:1394-1446) — non-mutating startup work', () => {
  bench('legacy fold probe — lstat(getLegacySystemAgentsDir()) + ENOENT catch (index.ts:1401-1405)', () => {
    probeLegacySystemRepo();
  });

  bench('system-repo readiness probe — isGitRepo(getAgentsDir()), the settled branch used before setup (index.ts:1408-1416)', () => {
    isGitRepo(SYSTEM_DIR);
  });

  bench('v20 migration sentinel gate — existsSync + readFileSync + trim, without runMigration (index.ts:1421-1443)', () => {
    probeMigrationSentinel();
  });

  bench('all settled probes — legacy lstat + system-repo existsSync + v18 sentinel read', () => {
    probeLegacySystemRepo();
    isGitRepo(SYSTEM_DIR);
    probeMigrationSentinel();
  });
});

/**
 * Individual eager imports complement EAGER_MINUS_BRAND/EAGER_WITH_BRAND above.
 * Every row uses coldEval, so a fresh Node process pays real module evaluation;
 * every spec is also exercised once by preflightColdImports at module scope.
 */
describe('eager startup module graph — selected cold import contributors', () => {
  bench('FLOOR: bare Node ESM process', () => {
    coldEval([]);
  }, COLD_OPTS);

  bench('startup/dev-build.js — index.ts:16', () => {
    coldEval([DEV_BUILD_SPEC]);
  }, COLD_OPTS);

  bench('startup/command-registry.js — index.ts eager loader table', () => {
    coldEval([COMMAND_REGISTRY_SPEC]);
  }, COLD_OPTS);

  bench('events.js + event-provenance.js + format.js — eager hook support graph', () => {
    coldEval([EVENTS_SPEC, EVENT_PROVENANCE_SPEC, FORMAT_SPEC]);
  }, COLD_OPTS);

  bench('commands/view.js — representative command module after eager bootstrap', () => {
    coldEval([VIEW_COMMAND_SPEC]);
  }, COLD_OPTS);

  bench('commands/doctor.js — representative diagnostics module after eager bootstrap', () => {
    coldEval([DOCTOR_COMMAND_SPEC]);
  }, COLD_OPTS);

  bench('commands/sessions.js — representative SQLite-backed command module', () => {
    coldEval([SESSIONS_COMMAND_SPEC]);
  }, COLD_OPTS);

  bench('eager graph then commands/view.js — real shared-cache shape for one command', () => {
    coldEval([...EAGER_WITH_BRAND, VIEW_COMMAND_SPEC]);
  }, COLD_OPTS);
});

/**
 * self-update.js is a static index.ts import. Its compareVersions dependency is
 * owned by the zero-dependency agent-spec/primitives.js leaf but can also arrive
 * through versions.js. These rows price the real built graphs; they do not
 * infer a production refactor or duplicate a child-process helper.
 */
describe('eager self-update import graph — cold module evaluation', () => {
  bench('FLOOR: bare Node ESM process', () => {
    coldEval([]);
  }, COLD_OPTS);

  bench('agent-spec/primitives.js — compareVersions owner', () => {
    coldEval([PRIMITIVES_SPEC]);
  }, COLD_OPTS);

  bench('platform/index.js — self-update platform dependency', () => {
    coldEval([PLATFORM_SPEC]);
  }, COLD_OPTS);

  bench('self-update.js — exact eager module imported by index.ts', () => {
    coldEval([SELF_UPDATE_SPEC]);
  }, COLD_OPTS);

  bench('versions.js — heavy comparison graph reached by the legacy re-export edge', () => {
    coldEval([VERSIONS_SPEC]);
  }, COLD_OPTS);
});
