/* Benchmarks the real filesystem, PATH, cache, built worker, and process-spawn paths without mocks. */
/* The built auto-pull module is intentional: source resolution cannot find its emitted worker. */
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
// resolves and type-checks normally -- no @ts-expect-error needed here.
import { spawnDetachedSync } from '../../dist/lib/auto-pull.js';
import { loadDoctor, loadVersions, loadPrune, loadSessions } from '../cli/command-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPDATE_CHECK_FILE = getUpdateCheckPath();
const REAL_PATH = process.env.PATH || '';
const SYSTEM_DIR = getAgentsDir();
const LEGACY_SYSTEM_DIR = getLegacySystemAgentsDir();
const MIGRATED_SENTINEL_FILE = getMigratedSentinelPath();
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

const CLI_ENTRY = path.join(__dirname, '../../dist/index.js');

function runCli(args: string[]): number | null {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], { stdio: 'ignore' }).status;
}

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


const CLI_ROOT = path.resolve(__dirname, '../..');
const DIST_ROOT = path.dirname(CLI_ENTRY);

const SHIM_LINK = path.join(os.tmpdir(), `agents-cli-bench-shim-agents-${process.pid}`);
fs.rmSync(SHIM_LINK, { force: true });
fs.symlinkSync(CLI_ENTRY, SHIM_LINK);
afterAll(() => {
  fs.rmSync(SHIM_LINK, { force: true });
});

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

const COMMANDER_SPEC = pathToFileURL(
  createRequire(import.meta.url).resolve('commander'),
).href;

const COMPILE_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-compile-cache-'));
const COMPILE_CACHE_ENV = { NODE_COMPILE_CACHE: COMPILE_CACHE_DIR } as const;

afterAll(() => {
  try { fs.rmSync(COMPILE_CACHE_DIR, { recursive: true, force: true }); } catch {  }
});

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
  coldEval(EAGER_MINUS_BRAND);
  coldEval(EAGER_WITH_BRAND);
  coldEval([EVENTS_SPEC, EVENT_PROVENANCE_SPEC, FORMAT_SPEC]);
  coldEval([...EAGER_WITH_BRAND, VIEW_COMMAND_SPEC]);
  coldEval([COMMANDER_SPEC], COMPILE_CACHE_ENV);
  coldEval([COMMANDER_SPEC], COMPILE_CACHE_ENV);
  coldEval([], COMPILE_CACHE_ENV);
  expectExit(runCli(['--version']), [0], '--version preflight');
})();


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

const BENCH_BRAND = 'agents';

function auditCommandPath(cmd: Command): string[] {
  const parts: string[] = [];
  let c: Command | null | undefined = cmd;
  while (c && c.name() && c.name() !== BENCH_BRAND) {
    parts.unshift(c.name());
    c = c.parent;
  }
  return parts;
}

const auditStarts = new WeakMap<Command, number>();

const AUDIT_EXEMPT_COMMANDS: ReadonlySet<string> = new Set([
  'events emit',
  '_internal friction',
]);

function buildRootProgram(): Command {
  return new Command()
    .name(BENCH_BRAND)
    .description('Environment manager for AI agents')
    .version(REAL_VERSION)
    .option('--verbose', 'Show startup self-heal details on stderr')
    .helpOption('-h, --help', 'Show help')
    .addHelpCommand(false);
}

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
        }).catch(() => {  });
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
        }).catch(() => {  });
      }
    } catch {
    }
  });
  return program;
}

let dispatchCount = 0;
function registerBenchCommands(program: Command): Command {
  program.command('noop').action(() => { dispatchCount++; });
  const sessions = program.command('sessions');
  sessions.command('list').action(() => { dispatchCount++; });
  const events = program.command('events');
  events.command('emit').action(() => { dispatchCount++; });
  return program;
}

function attachPostActionOnlyAuditHook(program: Command): Command {
  program.hook('preAction', (_thisCommand, actionCommand) => {
    try {
      const parts = auditCommandPath(actionCommand);
      if (parts.length === 0) return;
      if (AUDIT_EXEMPT_COMMANDS.has(parts.join(' '))) return;
      auditStarts.set(actionCommand, Date.now());
    } catch {
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
        }).catch(() => {  });
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
        }).catch(() => {  });
      }
    } catch {
    }
  });
  return program;
}

const HOOKED_PROGRAM = registerBenchCommands(attachAuditHooks(buildRootProgram()));
const UNHOOKED_PROGRAM = registerBenchCommands(buildRootProgram());
const ONE_APPEND_PROGRAM = registerBenchCommands(attachPostActionOnlyAuditHook(buildRootProgram()));

const AUDIT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-audit-bench-'));
const AUDIT_SINK = path.join(AUDIT_TMP, 'events.jsonl');
process.env.AGENTS_PERF_DIR = path.join(AUDIT_TMP, 'perf');
_resetForTest(AUDIT_SINK);

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
  try { fs.rmSync(AUDIT_TMP, { recursive: true, force: true }); } catch {  }
});

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

describe('brand.js MARGINAL cost on top of the rest of the eager graph — does self-update.js already pay for what brand.js needs?', () => {
  bench('EAGER_MINUS_BRAND: the 12 other index.ts eager local imports (index.ts:16,36,86-95,124,208,209,211-215,513), no brand.js edge', () => {
    coldEval(EAGER_MINUS_BRAND);
  }, COLD_OPTS);

  bench('EAGER_WITH_BRAND: same 12 + lib/brand.js (index.ts:514) — the delta vs the row above is brand.js\'s real marginal startup cost once self-update.js\'s own versions.js->agents.js edge has already run in this process', () => {
    coldEval(EAGER_WITH_BRAND);
  }, COLD_OPTS);
});

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

function probeLegacySystemRepo(): void {
  try {
    fs.lstatSync(LEGACY_SYSTEM_DIR);
  } catch {
  }
}

function probeMigrationSentinel(): void {
  if (
    fs.existsSync(MIGRATED_SENTINEL_FILE) &&
    fs.readFileSync(MIGRATED_SENTINEL_FILE, 'utf-8').trim() === MIGRATION_SENTINEL_VALUE
  ) {
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
