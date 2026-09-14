import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import * as yaml from 'yaml';
import * as state from '../state.js';
import * as profiles from './profiles.js';
import { query, _resetForTest } from '../feed/events.js';
import { machineId } from '../machine-id.js';
import { resolveFfmpeg } from './ffmpeg.js';

const TEST_HOME = path.join(tmpdir(), 'agents-cli-browser-service-test');
const TEST_AGENTS_DIR = path.join(TEST_HOME, '.agents');
const TEST_BROWSER_DIR = path.join(TEST_AGENTS_DIR, 'browser');

vi.spyOn(state, 'getUserAgentsDir').mockReturnValue(TEST_AGENTS_DIR);
vi.spyOn(state, 'getAgentsDir').mockReturnValue(TEST_AGENTS_DIR);
vi.spyOn(state, 'getBrowserRuntimeDir').mockReturnValue(TEST_BROWSER_DIR);

// Override the four profiles.js exports the test needs via vi.spyOn instead
// of a full vi.mock factory — keeps every other export real and avoids
// needing vi.hoisted / vi.importActual, neither of which Bun's native test
// runner supports.
function readProfileYaml(name: string): { name: string; browser: string; endpoints: string[] } | null {
  const profilePath = path.join(TEST_BROWSER_DIR, 'profiles', `${name}.yaml`);
  if (!fs.existsSync(profilePath)) return null;
  const raw = yaml.parse(fs.readFileSync(profilePath, 'utf-8')) as {
    name: string;
    browser: string;
    endpoints: string[];
  };
  return { name: raw.name, browser: raw.browser, endpoints: raw.endpoints };
}

vi.spyOn(profiles, 'getBrowserRuntimeDir').mockReturnValue(TEST_BROWSER_DIR);
vi.spyOn(profiles, 'getProfileRuntimeDir').mockImplementation(
  (name: string) => path.join(TEST_BROWSER_DIR, name),
);
vi.spyOn(profiles, 'listProfiles').mockImplementation(async () => {
  const profilesDir = path.join(TEST_BROWSER_DIR, 'profiles');
  if (!fs.existsSync(profilesDir)) return [];
  return fs
    .readdirSync(profilesDir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => readProfileYaml(path.basename(f, '.yaml')))
    .filter((p): p is { name: string; browser: string; endpoints: string[] } => p !== null);
});
vi.spyOn(profiles, 'getProfile').mockImplementation(async (name: string) => readProfileYaml(name));

const { BrowserService, resolveScreenshotOutputPath, resolveTaskIdentity, arcNotDrivableError } = await import('./service.js');

function reset() {
  try {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    // ignore
  }
  fs.mkdirSync(TEST_AGENTS_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEST_AGENTS_DIR, 'browser', 'profiles'), { recursive: true });
}

function writeProfile(
  name: string,
  endpoints: string[],
  browserType = 'chrome',
  device = machineId(),
): void {
  const profile = { name, browser: browserType, endpoints };
  fs.writeFileSync(
    path.join(TEST_AGENTS_DIR, 'browser', 'profiles', `${name}.yaml`),
    yaml.stringify(profile)
  );
  const file = path.join(TEST_AGENTS_DIR, 'devices', device, 'agents.yaml');
  let doc: { browser?: Record<string, { browser: string; endpoints: string[] }> } = {};
  if (fs.existsSync(file)) {
    doc = (yaml.parse(fs.readFileSync(file, 'utf8')) as typeof doc) ?? {};
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    yaml.stringify({
      ...doc,
      browser: { ...doc.browser, [name]: { browser: browserType, endpoints } },
    }),
  );
}

function writeRunningChrome(profileName: string, port: number, pid: number): void {
  const runtimeDir = path.join(TEST_AGENTS_DIR, 'browser', profileName);
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'pid'), String(pid));
  fs.writeFileSync(path.join(runtimeDir, 'port'), String(port));
}

function writeTaskState(
  profileName: string,
  tasks: Array<{ id: string; tabIds: string[]; createdAt: number }>
): void {
  const runtimeDir = path.join(TEST_AGENTS_DIR, 'browser', profileName);
  fs.mkdirSync(runtimeDir, { recursive: true });
  const state: Record<string, unknown> = {};
  for (const t of tasks) {
    state[t.id] = {
      id: t.id,
      profile: profileName,
      tabIds: t.tabIds,
      createdAt: t.createdAt,
      pid: 0,
    };
  }
  fs.writeFileSync(path.join(runtimeDir, 'tasks.json'), JSON.stringify(state));
}

beforeEach(reset);
afterEach(() => {
  try {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('resolveScreenshotOutputPath', () => {
  it('uses the runtime autopath when a requested output path is outside browser runtime', () => {
    const automaticPath = path.join(TEST_BROWSER_DIR, 'sessions', 'task', '1.jpg');
    const outsidePath = path.join(tmpdir(), 'outside-browser-runtime.jpg');

    expect(resolveScreenshotOutputPath(outsidePath, automaticPath)).toBe(automaticPath);
  });

  it('allows requested output paths inside browser runtime', () => {
    const automaticPath = path.join(TEST_BROWSER_DIR, 'sessions', 'task', '1.jpg');
    const requestedPath = path.join(TEST_BROWSER_DIR, 'exports', 'shot.jpg');
    const resolved = resolveScreenshotOutputPath(requestedPath, automaticPath);

    expect(resolved.endsWith(path.join('exports', 'shot.jpg'))).toBe(true);
    expect(resolved).not.toBe(automaticPath);
  });
});

describe('resolveTaskIdentity — task owner/launchId attribution', () => {
  it('stamps the forwarded actor + launchId verbatim and never re-resolves', () => {
    let localCalled = false;
    const id = resolveTaskIdentity(
      { actor: 'agent:kimi-run-7', launchId: 'launch-abc' },
      () => {
        localCalled = true;
        return 'daemon-owner';
      }
    );
    expect(id).toEqual({ owner: 'agent:kimi-run-7', launchId: 'launch-abc' });
    // The daemon must NOT re-resolve when the caller forwarded an actor — that
    // was the RUSH-2020 bug (every task attributed to the daemon's own actor).
    expect(localCalled).toBe(false);
  });

  it('falls back to the local actor only when none was forwarded (pre-field CLI)', () => {
    const id = resolveTaskIdentity({ launchId: 'launch-xyz' }, () => 'muqsit');
    expect(id).toEqual({ owner: 'muqsit', launchId: 'launch-xyz' });
  });

  it('carries an undefined launchId through untouched', () => {
    const id = resolveTaskIdentity({ actor: 'muqsit' }, () => 'unused');
    expect(id.owner).toBe('muqsit');
    expect(id.launchId).toBeUndefined();
  });
});

describe('BrowserService.status — disk reconciliation (Issue #6)', () => {
  it('returns empty when no profiles exist', async () => {
    const service = new BrowserService();
    const result = await service.status();
    expect(result).toEqual([]);
  });

  it('reconciles a profile whose pid is alive but daemon has no in-memory connection', async () => {
    writeProfile('rush-mini', ['cdp://localhost:9222']);
    writeRunningChrome('rush-mini', 9222, process.pid); // process.pid is guaranteed alive
    writeTaskState('rush-mini', [{ id: 'work', tabIds: ['tab1', 'tab2'], createdAt: 100 }]);

    const service = new BrowserService();
    const result = await service.status();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'rush-mini',
      running: true,
      port: 9222,
      pid: process.pid,
    });
    expect(result[0].tasks).toHaveLength(1);
    expect(result[0].tasks[0]).toMatchObject({ id: 'work', tabCount: 2, createdAt: 100 });
  });

  // Regression: soft rehydrate must not clearProfileRuntime (CI shard 2).
  it('status still reconciles from disk when CDP is unreachable (no clear of pid files)', async () => {
    // Port with nothing listening — soft rehydrate must not clear pid/port
    // (connectProfile used to, which made status return [] on CI).
    const deadPort = 19_987;
    writeProfile('disk-only', [`cdp://localhost:${deadPort}`]);
    writeRunningChrome('disk-only', deadPort, process.pid);
    writeTaskState('disk-only', [{ id: 'orphan', tabIds: ['t1'], createdAt: 50 }]);

    const service = new BrowserService();
    const result = await service.status();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'disk-only',
      running: true,
      port: deadPort,
      pid: process.pid,
    });
    expect(result[0].tasks).toHaveLength(1);
    expect(result[0].tasks[0]).toMatchObject({ id: 'orphan', tabCount: 1 });

    // Runtime files must survive the failed soft attach.
    const runtimeDir = path.join(TEST_AGENTS_DIR, 'browser', 'disk-only');
    expect(fs.existsSync(path.join(runtimeDir, 'pid'))).toBe(true);
    expect(fs.existsSync(path.join(runtimeDir, 'port'))).toBe(true);
  });

  it('drops profiles whose pid is no longer alive (stale pid file)', async () => {
    writeProfile('dead-profile', ['cdp://localhost:9222']);
    writeRunningChrome('dead-profile', 9222, 999_999); // unlikely to be alive

    const service = new BrowserService();
    const result = await service.status();

    expect(result).toHaveLength(0);

    // getRunningChromeInfo should have cleaned up the stale files
    const runtimeDir = path.join(TEST_AGENTS_DIR, 'browser', 'dead-profile');
    expect(fs.existsSync(path.join(runtimeDir, 'pid'))).toBe(false);
    expect(fs.existsSync(path.join(runtimeDir, 'port'))).toBe(false);
  });

  it('surfaces configured-vs-running port when they differ (Loop C residual)', async () => {
    writeProfile('drift', ['cdp://localhost:9222']);
    writeRunningChrome('drift', 9200, process.pid); // configured 9222, running 9200

    const service = new BrowserService();
    const result = await service.status();

    expect(result).toHaveLength(1);
    expect(result[0].port).toBe(9200);
    expect(result[0].configuredPort).toBe(9222);
  });

  it('omits configuredPort when configured matches running', async () => {
    writeProfile('match', ['cdp://localhost:9222']);
    writeRunningChrome('match', 9222, process.pid);

    const service = new BrowserService();
    const result = await service.status();

    expect(result).toHaveLength(1);
    expect(result[0].port).toBe(9222);
    expect(result[0].configuredPort).toBeUndefined();
  });

  it('filters by profile name when one is provided', async () => {
    writeProfile('a', ['cdp://localhost:9222']);
    writeProfile('b', ['cdp://localhost:9223']);
    writeRunningChrome('a', 9222, process.pid);
    writeRunningChrome('b', 9223, process.pid);

    const service = new BrowserService();
    const result = await service.status('a');

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('a');
  });

  /**
   * RUSH-2709. A live browser is keyed `<profile>@<endpoint>` on disk and in
   * the connection map, but `--profile` takes the BARE name. These pin both
   * halves of the contract: the scoped query finds the running browser, and
   * what comes back never leaks the runtime key into a user-facing field.
   */
  describe('composite-keyed profiles (RUSH-2709)', () => {
    it('status --profile <bare> reports the LIVE composite-keyed browser', async () => {
      writeProfile('comet-local', ['cdp://localhost:9222']);
      writeRunningChrome('comet-local@endpoint-0', 9222, process.pid);
      writeTaskState('comet-local@endpoint-0', [
        { id: 'live-task', tabIds: ['tab1'], createdAt: 100 },
      ]);

      const service = new BrowserService();
      const result = await service.status('comet-local');

      // The regression this replaces: an empty list for a running profile.
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ running: true, port: 9222, pid: process.pid });
      expect(result[0].tasks.map((t) => t.id)).toEqual(['live-task']);
    });

    it('surfaces the bare name and the endpoint as SEPARATE fields, never the raw key', async () => {
      writeProfile('comet-local', ['cdp://localhost:9222']);
      writeRunningChrome('comet-local@endpoint-0', 9222, process.pid);
      writeTaskState('comet-local@endpoint-0', [{ id: 't', tabIds: ['x'], createdAt: 1 }]);

      const service = new BrowserService();
      const [scoped] = await service.status('comet-local');
      const [unscoped] = await service.status();

      for (const status of [scoped, unscoped]) {
        expect(status.name).toBe('comet-local');
        expect(status.name).not.toContain('@');
        expect(status.endpoint).toBe('endpoint-0');
        expect(status.key).toBe('comet-local@endpoint-0');
      }
    });

    it('accepts a runtime key pasted from an older listing', async () => {
      writeProfile('comet-local', ['cdp://localhost:9222']);
      writeRunningChrome('comet-local@endpoint-0', 9222, process.pid);
      writeTaskState('comet-local@endpoint-0', [{ id: 't', tabIds: ['x'], createdAt: 1 }]);

      const service = new BrowserService();
      const result = await service.status('comet-local@endpoint-0');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('comet-local');
    });

    it('back-compat: finds a browser running under a LEGACY pre-composite key', async () => {
      // Older builds keyed the runtime dir by the bare profile name, with no
      // `@endpoint`. That dir must still resolve, or a browser the user has
      // running is orphaned.
      writeProfile('legacy', ['cdp://localhost:9222']);
      writeRunningChrome('legacy', 9222, process.pid);
      writeTaskState('legacy', [{ id: 'old', tabIds: ['t1'], createdAt: 7 }]);

      const service = new BrowserService();
      const result = await service.status('legacy');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('legacy');
      expect(result[0].key).toBe('legacy');
      expect(result[0].tasks.map((t) => t.id)).toEqual(['old']);
    });

    it('finds a fork of a composite key, and never a separate `<name>.<n>` profile', async () => {
      writeProfile('forked', ['cdp://localhost:9222']);
      writeRunningChrome('forked@endpoint-0.2', 9222, process.pid);
      writeTaskState('forked@endpoint-0.2', [{ id: 'f', tabIds: ['t1'], createdAt: 7 }]);
      // A DIFFERENT profile whose name merely ends in `.2`. Claiming its runtime
      // dir would stop somebody else's browser.
      writeProfile('forked.2', ['cdp://localhost:9223']);
      writeRunningChrome('forked.2', 9223, process.pid);

      const service = new BrowserService();
      const result = await service.status('forked');

      expect(result.map((s) => s.key)).toEqual(['forked@endpoint-0.2']);
      expect(await service.status('forked.2')).toHaveLength(1);
    });

    it('does not claim another profile that merely shares a name prefix', async () => {
      writeProfile('comet', ['cdp://localhost:9222']);
      writeProfile('comet-local', ['cdp://localhost:9223']);
      writeRunningChrome('comet-local@endpoint-0', 9223, process.pid);

      const service = new BrowserService();
      expect(await service.status('comet')).toHaveLength(0);
      expect(await service.status('comet-local')).toHaveLength(1);
    });
  });
});

// -----------------------------------------------------------------------------
// pickWindowTarget / parseTargetFilter
//
// These helpers exist because Electron apps frequently expose multiple
// `type: 'page'` CDP targets per process: the visible window plus invisible
// helpers (background services, OAuth windows, file:// shells). Without these,
// `agents browser start` against an Electron app silently latches onto whatever
// target is enumerated first by CDP — almost always wrong, with no signal to
// the user other than blank screenshots.
// -----------------------------------------------------------------------------
describe('parseTargetFilter', () => {
  it('parses url:<substring>', async () => {
    const { parseTargetFilter } = await import('./service.js');
    expect(parseTargetFilter('url:https://www.canva.com/')).toEqual({
      kind: 'url',
      value: 'https://www.canva.com/',
    });
  });

  it('parses title:<substring>', async () => {
    const { parseTargetFilter } = await import('./service.js');
    expect(parseTargetFilter('title:Home - Canva')).toEqual({
      kind: 'title',
      value: 'Home - Canva',
    });
  });

  it('treats kind as case-insensitive', async () => {
    const { parseTargetFilter } = await import('./service.js');
    expect(parseTargetFilter('URL:foo')?.kind).toBe('url');
    expect(parseTargetFilter('Title:bar')?.kind).toBe('title');
  });

  it('returns null for unknown kind, missing colon, empty value, or undefined', async () => {
    const { parseTargetFilter } = await import('./service.js');
    expect(parseTargetFilter('hostname:foo')).toBeNull();
    expect(parseTargetFilter('foobar')).toBeNull();
    expect(parseTargetFilter('url:')).toBeNull();
    expect(parseTargetFilter('')).toBeNull();
    expect(parseTargetFilter(undefined)).toBeNull();
  });

  it('trims whitespace around the value (copy-paste safety)', async () => {
    // `url: https://x` (space after colon) used to parse to value=' https://x',
    // which silently never matched any real URL. Strip both sides.
    const { parseTargetFilter } = await import('./service.js');
    expect(parseTargetFilter('url: https://www.canva.com/ ')).toEqual({
      kind: 'url',
      value: 'https://www.canva.com/',
    });
    // Whitespace-only value is equivalent to empty value.
    expect(parseTargetFilter('url:   ')).toBeNull();
  });
});

describe('pickWindowTarget', () => {
  // Canonical Canva target list captured live against `:9201/json`.
  // The first page is the invisible Desktop Background Service — the bug
  // we're fixing is that the original `find(t.type === 'page')` returns
  // this target and screenshots come back blank.
  const canvaTargets = [
    {
      targetId: 'C1AEAD00',
      type: 'page',
      url: 'https://www.canva.com/_desktop-background-service',
      title: 'Desktop Background Service',
    },
    {
      targetId: 'B351F950',
      type: 'page',
      url: 'https://www.canva.com/',
      title: 'Home - Canva',
    },
    {
      targetId: 'FBBCAA2F',
      type: 'page',
      url: 'file:///Applications/Canva.app/Contents/Resources/app.asar/dist/index.dynamic_locale.html',
      title: 'index.dynamic_locale.html',
    },
    { targetId: 'SW1', type: 'service_worker', url: 'https://www.canva.com/sw.js' },
  ];

  it('explicit url filter wins over enumeration order', async () => {
    const { pickWindowTarget } = await import('./service.js');
    const hit = pickWindowTarget(canvaTargets, 'url:https://www.canva.com/');
    expect(hit?.targetId).toBe('B351F950');
  });

  it('explicit title filter wins over enumeration order', async () => {
    const { pickWindowTarget } = await import('./service.js');
    const hit = pickWindowTarget(canvaTargets, 'title:Home - Canva');
    expect(hit?.targetId).toBe('B351F950');
  });

  it('substring match is case-insensitive on both haystack and needle', async () => {
    const { pickWindowTarget } = await import('./service.js');
    const hit = pickWindowTarget(canvaTargets, 'title:HOME');
    expect(hit?.targetId).toBe('B351F950');
  });

  it('explicit filter that misses returns undefined — caller must surface the failure', async () => {
    const { pickWindowTarget } = await import('./service.js');
    // The caller (getOrCreateWindow) turns this into a thrown error listing
    // the candidates. Returning undefined here keeps the helper pure.
    expect(pickWindowTarget(canvaTargets, 'url:does-not-exist')).toBeUndefined();
  });

  it('with no filter, skips _desktop-background-service and file:// shells', async () => {
    const { pickWindowTarget } = await import('./service.js');
    const hit = pickWindowTarget(canvaTargets, undefined);
    expect(hit?.targetId).toBe('B351F950');
  });

  it('with no filter and no visible candidate, falls back to first page target', async () => {
    const { pickWindowTarget } = await import('./service.js');
    const allInvisible = [
      { targetId: 'A', type: 'page', url: 'about:blank' },
      { targetId: 'B', type: 'page', url: 'file:///x' },
    ];
    const hit = pickWindowTarget(allInvisible, undefined);
    expect(hit?.targetId).toBe('A');
  });

  it('returns undefined when no page targets exist at all', async () => {
    const { pickWindowTarget } = await import('./service.js');
    const workerOnly = [{ targetId: 'SW', type: 'service_worker', url: 'sw.js' }];
    expect(pickWindowTarget(workerOnly, undefined)).toBeUndefined();
  });

  it('malformed filter falls back to heuristic instead of throwing', async () => {
    const { pickWindowTarget } = await import('./service.js');
    // Garbage filter should not crash; treat as if absent.
    const hit = pickWindowTarget(canvaTargets, 'not-a-valid-filter');
    expect(hit?.targetId).toBe('B351F950');
  });

  it('explicit filter, all matches invisible — returns first match (documented fallback)', async () => {
    // If every match is invisible, the helper still returns *something* rather
    // than `undefined`. The caller can decide to surface a warning if needed.
    // Caught here so a future refactor doesn't accidentally drop the `?? matches[0]`.
    const { pickWindowTarget } = await import('./service.js');
    const invisibleMatches = [
      {
        targetId: 'BG1',
        type: 'page',
        url: 'https://www.canva.com/_desktop-background-service',
        title: 'Desktop Background Service',
      },
      {
        targetId: 'BG2',
        type: 'page',
        url: 'https://www.canva.com/_internal',
        title: 'Internal',
      },
    ];
    const hit = pickWindowTarget(invisibleMatches, 'url:canva.com');
    expect(hit?.targetId).toBe('BG1');
  });
});

// -----------------------------------------------------------------------------
// recordStop ffmpeg-exit handling (#560)
//
// Before the fix, recordStop's 5s wait only RESOLVED the promise — it never
// killed a hung ffmpeg and never inspected the exit code, so a failed encode
// (bad codec, missing encoder, corrupt output) reported success with a
// silently-empty .webm. We inject a fake ffmpeg + recording state straight into
// the private `recordings` map so the finalize path runs without spawning real
// ffmpeg or CDP.
// -----------------------------------------------------------------------------
function fakeFfmpeg() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: { end: () => void };
    kill: (sig?: string) => void;
  };
  child.stdin = { end: () => {} };
  child.kill = () => {};
  return child;
}

function injectRecording(
  svc: InstanceType<typeof BrowserService>,
  taskId: string,
  overrides: {
    outputPath?: string;
    ffmpeg?: ReturnType<typeof fakeFfmpeg>;
    ffmpegStderr?: () => string;
  } = {}
): ReturnType<typeof fakeFfmpeg> {
  const ffmpeg = overrides.ffmpeg ?? fakeFfmpeg();
  const durationTimer = setTimeout(() => {}, 1_000_000);
  const sizeCheckInterval = setInterval(() => {}, 1_000_000);
  (svc as unknown as { recordings: Map<string, unknown> }).recordings.set(taskId, {
    outputPath: overrides.outputPath ?? path.join(tmpdir(), 'rec-missing.webm'),
    startedAt: Date.now() - 1000,
    fps: 5,
    maxBytes: 25 * 1024 * 1024,
    durationMs: 60_000,
    ffmpeg,
    ffmpegStderr: overrides.ffmpegStderr ?? (() => ''),
    sessionId: 'sess-1',
    conn: { cdp: { off: () => {}, send: async () => {} } },
    frameHandler: () => {},
    durationTimer,
    sizeCheckInterval,
  });
  return ffmpeg;
}

describe('recordStop ffmpeg exit handling (#560)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('surfaces a non-zero ffmpeg exit as failure (not silent success)', async () => {
    const svc = new BrowserService();
    const ffmpeg = fakeFfmpeg();
    // Closing stdin makes a broken ffmpeg flush and exit non-zero.
    ffmpeg.stdin.end = () => setImmediate(() => ffmpeg.emit('exit', 1));
    injectRecording(svc, 'task-fail', {
      ffmpeg,
      ffmpegStderr: () => '[libvpx-vp9] failed to encode frame',
    });

    await expect(svc.recordStop('task-fail')).rejects.toThrow(/exited abnormally \(code 1\)/);
  });

  it('includes ffmpeg stderr in the failure so the encode error is diagnosable', async () => {
    const svc = new BrowserService();
    const ffmpeg = fakeFfmpeg();
    ffmpeg.stdin.end = () => setImmediate(() => ffmpeg.emit('exit', 234));
    injectRecording(svc, 'task-diag', {
      ffmpeg,
      ffmpegStderr: () => 'Unknown encoder libvpx-vp9',
    });

    await expect(svc.recordStop('task-diag')).rejects.toThrow(/Unknown encoder libvpx-vp9/);
  });

  it('drops the recording from the map even when finalize fails', async () => {
    const svc = new BrowserService();
    const ffmpeg = fakeFfmpeg();
    ffmpeg.stdin.end = () => setImmediate(() => ffmpeg.emit('exit', 1));
    injectRecording(svc, 'task-clean', { ffmpeg });

    await expect(svc.recordStop('task-clean')).rejects.toThrow();
    const recordings = (svc as unknown as { recordings: Map<string, unknown> }).recordings;
    expect(recordings.has('task-clean')).toBe(false);
  });

  it('kills a hung ffmpeg on the 5s timeout and reports failure', async () => {
    vi.useFakeTimers();
    const svc = new BrowserService();
    const kill = vi.fn();
    const ffmpeg = fakeFfmpeg();
    ffmpeg.kill = kill;
    ffmpeg.stdin.end = () => {}; // never emits 'exit' — ffmpeg is hung
    injectRecording(svc, 'task-hang', { ffmpeg });

    const p = svc.recordStop('task-hang');
    const assertion = expect(p).rejects.toThrow(/did not exit within 5s/);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('returns success with a real byte count on a clean (exit 0) finalize', async () => {
    const svc = new BrowserService();
    const outputPath = path.join(tmpdir(), `rec-ok-${process.pid}-${Date.now()}.webm`);
    fs.writeFileSync(outputPath, Buffer.alloc(2048, 7));
    try {
      const ffmpeg = fakeFfmpeg();
      ffmpeg.stdin.end = () => setImmediate(() => ffmpeg.emit('exit', 0));
      injectRecording(svc, 'task-ok', { ffmpeg, outputPath });

      const res = await svc.recordStop('task-ok');
      expect(res.path).toBe(outputPath);
      expect(res.bytes).toBe(2048);
      expect(res.reason).toBe('manual');
    } finally {
      fs.rmSync(outputPath, { force: true });
    }
  });
});

describe('browser recording frame pipe (PHNX-2600)', () => {
  it('catches a frame emitted before startScreencast responds and finalizes a playable WebM', async () => {
    const ffmpeg = await resolveFfmpeg();
    const jpegPath = path.join(TEST_HOME, 'frame.jpg');
    execFileSync(ffmpeg, [
      '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=1',
      '-frames:v', '1', '-update', '1', '-y', jpegPath,
    ]);
    const jpeg = fs.readFileSync(jpegPath).toString('base64');

    const handlers = new Map<string, (params: unknown, sessionId?: string) => void>();
    const cdp = {
      on: (event: string, handler: (params: unknown, sessionId?: string) => void) => handlers.set(event, handler),
      off: (event: string) => handlers.delete(event),
      send: async (method: string) => {
        if (method === 'Page.startScreencast') {
          // This is the production race: Chrome's event can precede the command response.
          handlers.get('Page.screencastFrame')?.({ data: jpeg, sessionId: 41 }, 'session-1');
        }
        return {};
      },
    };
    const task = { name: 'frame-race', tabIds: ['tab-1'], currentTabId: 'tab-1' };
    const svc = new BrowserService();
    const internals = svc as unknown as Record<string, (...args: unknown[]) => unknown>;
    internals.findTask = async () => ({ conn: { cdp }, task, key: 'test@endpoint-0' });
    internals.resolveCurrentTab = () => 'tab-1';
    internals.getCdpTargetId = () => 'target-1';
    internals.getTarget = async () => ({ targetId: 'target-1' });
    internals.getSessionId = async () => 'session-1';

    await svc.recordStart('frame-race', undefined, { fps: 10, duration: 10 });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const result = await svc.recordStop('frame-race');
    expect(result.bytes).toBeGreaterThan(0);
    // A successful full decode is the real corruption check; the live browser
    // verification uses ffprobe to assert the exact frame count and duration.
    execFileSync(ffmpeg, ['-v', 'error', '-i', result.path, '-f', 'null', '-']);
    expect(result.bytes).toBeGreaterThan(1000);
    // 120s ceiling (below): this test spawns several REAL ffmpeg processes end to
    // end — resolveFfmpeg (a one-time `-version` probe, or an install), an
    // execFileSync to synthesize the JPEG frame, the recording ffmpeg behind
    // recordStart/recordStop, and a final execFileSync decode of the produced
    // WebM. That is a few seconds on an idle box, but under concurrent CI load
    // (several PRs running the ~18-min suite on one runner) process spawns balloon
    // and the default 30s testTimeout was exceeded intermittently — red-CI'ing
    // unrelated PRs (PHNX-3465). The 120s ceiling sits well above the true cost
    // (like ChildProcess.doctorTimeout's 180s over a 136s command) so a load
    // spike can't flake it, while still failing a genuinely hung spawn in bounded
    // time. Do NOT globally raise testTimeout — only this real-multi-spawn test
    // needs the headroom.
  }, 120_000);
});

describe('BrowserService.stopProfile — composite-key cleanup (#559)', () => {
  it('cleans up a connection stored under the composite `<profile>@<endpoint>` when called with the bare profile name', async () => {
    writeProfile('winmini', ['ssh://muqsit@win-mini?port=9222&os=windows'], 'edge');
    const service = new BrowserService();

    const cleanup = vi.fn();
    const fakeConn = {
      cdp: { close: vi.fn() },
      pid: 2_000_000_000, // non-existent → killChrome's process.kill throws ESRCH (caught)
      cleanup,
      tasks: new Map(),
      sessionCache: new Map(),
    };
    // start() keys the map on the composite, not the bare name.
    const conns = (service as unknown as { connections: Map<string, unknown> }).connections;
    conns.set('winmini@win-mini', fakeConn);

    await service.stopProfile('winmini');

    // Before the fix, get('winmini') missed the composite key and cleanup never ran.
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(fakeConn.cdp.close).toHaveBeenCalledTimes(1);
    expect(conns.has('winmini@win-mini')).toBe(false);
  });

  it('does not touch a different profile that happens to share a name prefix', async () => {
    const service = new BrowserService();
    const conns = (service as unknown as { connections: Map<string, unknown> }).connections;
    const otherCleanup = vi.fn();
    conns.set('winmini2@ep', { cdp: { close: vi.fn() }, pid: 2_000_000_000, cleanup: otherCleanup, tasks: new Map() });

    await service.stopProfile('winmini');

    // "winmini2@ep" must NOT match the "winmini" stop (prefix must be `winmini@`).
    expect(otherCleanup).not.toHaveBeenCalled();
    expect(conns.has('winmini2@ep')).toBe(true);
  });
});

// PHNX-3317: stopProfile() is the task-less `stop --profile` path. ipc.ts's
// bindTask() short-circuits it before resolveOrCreateTask ever runs (the one
// chokepoint every other page/close verb's consent gate lives behind), so this
// destructive fleet-remote path — kills the profile's browser process, clears
// its runtime dir — reached the daemon with no consent check at all. Same
// per-request marker rule as every other gated verb; remote-control is unset
// (off) in this test HOME.
describe('BrowserService.stopProfile — remote-control consent gate (PHNX-3317)', () => {
  it('refuses a fleet-remote stop --profile when consent is off, and touches nothing', async () => {
    const service = new BrowserService();
    const cleanup = vi.fn();
    const conns = (service as unknown as { connections: Map<string, unknown> }).connections;
    conns.set('winmini@win-mini', {
      cdp: { close: vi.fn() },
      pid: 2_000_000_000,
      cleanup,
      tasks: new Map(),
      sessionCache: new Map(),
    });

    await expect(
      service.stopProfile('winmini', { fleetRemote: true, actor: 'yosemite-s0' }),
    ).rejects.toThrow(/remote-control on/);

    // Refused before anything was touched.
    expect(cleanup).not.toHaveBeenCalled();
    expect(conns.has('winmini@win-mini')).toBe(true);
  });

  it('does not gate a local stop --profile — no marker, no refusal', async () => {
    const service = new BrowserService();
    const cleanup = vi.fn();
    const conns = (service as unknown as { connections: Map<string, unknown> }).connections;
    conns.set('winmini@win-mini', {
      cdp: { close: vi.fn() },
      pid: 2_000_000_000,
      cleanup,
      tasks: new Map(),
      sessionCache: new Map(),
    });

    await service.stopProfile('winmini');

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(conns.has('winmini@win-mini')).toBe(false);
  });
});

describe('navigate/screenshot — emit typed events (#11)', () => {
  afterEach(() => {
    _resetForTest();
  });

  function eventsPath(): string {
    return path.join(
      TEST_HOME,
      `events-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`
    );
  }

  // Minimal-but-valid PNG header: signature + IHDR length/type + width/height.
  // readPngDimensions() only inspects these 24 bytes, so this is a real decode,
  // not a canned dimension value.
  function fakePngBase64(width: number, height: number): string {
    const buf = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
    buf.write('IHDR', 12, 'ascii');
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
    return buf.toString('base64');
  }

  function makeFakeConn(taskName: string, tabId: string) {
    const tasks = new Map();
    tasks.set(taskName, {
      id: taskName,
      name: taskName,
      profile: 'evprofile',
      tabs: { [tabId]: 'cdp-target-1' },
      currentTabId: tabId,
      createdAt: Date.now(),
      pid: 123,
    });
    const conn = {
      cdp: {
        send: vi.fn(async (method: string) => {
          switch (method) {
            case 'Target.attachToTarget':
              return { sessionId: 'sess-1' };
            case 'Page.navigate':
              return {};
            case 'Target.getTargets':
              return { targetInfos: [{ targetId: 'cdp-target-1', url: 'https://example.com', title: 'Example' }] };
            case 'Page.captureScreenshot':
              return { data: fakePngBase64(10, 5) };
            default:
              throw new Error(`unexpected CDP call in test: ${method}`);
          }
        }),
      },
      port: 9333,
      pid: 123,
      tasks,
      sessionCache: new Map(),
    };
    return conn;
  }

  it('navigate() reusing the current tab emits browser.navigate with profile/task/url', async () => {
    _resetForTest(eventsPath());
    const service = new BrowserService();
    const conn = makeFakeConn('evtask', 'tab0001');
    (service as unknown as { connections: Map<string, unknown> }).connections.set('evprofile', conn);

    const result = await service.navigate('evtask', 'https://example.com/page');

    expect(result).toEqual({ tabId: 'tab0001', url: 'https://example.com/page', created: false, refreshed: false });
    const recs = query({ eventTypes: ['browser.navigate'] });
    expect(recs).toHaveLength(1);
    expect(recs[0].profile).toBe('evprofile');
    expect(recs[0].task).toBe('evtask');
    expect(recs[0].url).toBe('https://example.com/page');
    expect(recs[0].created).toBe(false);
  });

  it('screenshot() emits browser.screenshot with the real path/bytes/dimensions', async () => {
    _resetForTest(eventsPath());
    const service = new BrowserService();
    const conn = makeFakeConn('evtask2', 'tab0002');
    (service as unknown as { connections: Map<string, unknown> }).connections.set('evprofile2', conn);
    (conn as unknown as { tasks: Map<string, { profile: string }> }).tasks.get('evtask2')!.profile = 'evprofile2';

    const result = await service.screenshot('evtask2', undefined, undefined, 'raw');

    expect(result.width).toBe(10);
    expect(result.height).toBe(5);
    expect(fs.existsSync(result.path)).toBe(true);

    const recs = query({ eventTypes: ['browser.screenshot'] });
    expect(recs).toHaveLength(1);
    expect(recs[0].profile).toBe('evprofile2');
    expect(recs[0].task).toBe('evtask2');
    expect(recs[0].path).toBe(result.path);
    expect(recs[0].bytes).toBe(result.bytes);
    expect(recs[0].width).toBe(10);
    expect(recs[0].height).toBe(5);
    expect(recs[0].quality).toBe('raw');
  });
});

// ─── RUSH-2622: leftover tabs ────────────────────────────────────────────────
//
// Three leaks fed the pile-up, each covered below: the startup about:blank was
// never registered on the task (so `done` could not close it), a repeat `start`
// on the same URL always opened another copy of the page, and nothing ever
// stopped a task whose agent had exited.

/** A CDP double backed by a real target list that create/close actually mutate. */
function makeTargetedConn(
  profile: string,
  opts: { pages?: Array<{ targetId: string; url: string }>; browser?: string } = {},
) {
  const targets: Array<{ targetId: string; type: string; url: string; title: string }> = (
    opts.pages ?? []
  ).map((p) => ({ targetId: p.targetId, type: 'page', url: p.url, title: p.url }));
  let seq = 0;
  const calls: Array<{ method: string; params: any }> = [];

  const conn = {
    cdp: {
      isOpen: true,
      close: vi.fn(),
      send: vi.fn(async (method: string, params: any = {}) => {
        calls.push({ method, params });
        switch (method) {
          case 'Browser.getVersion':
            return {};
          case 'Target.getTargets':
            return { targetInfos: targets.map((t) => ({ ...t })) };
          case 'Target.createTarget': {
            const targetId = `created-${++seq}`;
            targets.push({ targetId, type: 'page', url: params.url, title: params.url });
            return { targetId };
          }
          case 'Target.closeTarget': {
            const i = targets.findIndex((t) => t.targetId === params.targetId);
            if (i >= 0) targets.splice(i, 1);
            return {};
          }
          case 'Target.activateTarget':
            return {};
          case 'Target.attachToTarget':
            return { sessionId: `sess-${params.targetId}` };
          case 'Page.navigate':
            return {};
          default:
            throw new Error(`unexpected CDP call in test: ${method}`);
        }
      }),
    },
    port: 9222,
    pid: 4242,
    profileName: profile,
    browserType: opts.browser,
    tasks: new Map(),
    sessionCache: new Map(),
  };
  return { conn, targets, calls };
}

/** Seed a live connection so `start` reuses it instead of launching a browser. */
function attach(service: any, profile: string, conn: unknown, key = `${profile}@endpoint-0`): void {
  (service as { connections: Map<string, unknown> }).connections.set(key, conn);
}

function createTargetCount(calls: Array<{ method: string }>): number {
  return calls.filter((c) => c.method === 'Target.createTarget').length;
}

describe('BrowserService.start — the startup about:blank is a task tab (RUSH-2622)', () => {
  it('registers the blank tab it opens, so `done` can close it', async () => {
    writeProfile('blankp', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets, calls } = makeTargetedConn('blankp@endpoint-0');
    attach(service, 'blankp', conn);

    const started = await service.start('blankp');

    // The daemon opened exactly one page and it belongs to the task — before
    // the fix `task.tabs` was `{}` and this tab outlived every `done`.
    expect(targets).toHaveLength(1);
    const task = conn.tasks.get(started.name)!;
    expect(Object.values(task.tabs)).toEqual([targets[0].targetId]);
    expect(task.currentTabId).toBeDefined();

    await service.done(started.name);

    expect(targets).toHaveLength(0);
    expect(calls.some((c) => c.method === 'Target.closeTarget')).toBe(true);
    expect(conn.tasks.has(started.name)).toBe(false);
  });

  it('leaves a page the daemon did not open alone', async () => {
    writeProfile('blankp2', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets, calls } = makeTargetedConn('blankp2@endpoint-0', {
      pages: [{ targetId: 'users-own-tab', url: 'https://news.example/' }],
    });
    attach(service, 'blankp2', conn);

    const started = await service.start('blankp2');

    // A page target already exists, so no blank is opened and nothing the user
    // opened is adopted — `done` must never close somebody else's tab.
    expect(createTargetCount(calls)).toBe(0);
    expect(conn.tasks.get(started.name)!.tabs).toEqual({});

    await service.done(started.name);
    expect(targets.map((t) => t.targetId)).toEqual(['users-own-tab']);
  });
});

describe('BrowserService — Arc refuses NEW-tab creation, the one CDP-only op (never Target.createTarget)', () => {
  // Arc answers Browser.getVersion and DOES expose page targets it honors
  // Page.navigate on, but CRASHES on Target.createTarget (verified, PR #2778).
  // Every tab-creating path must refuse with a clear error instead of crashing Arc.
  it('start with a url throws the clear error and never creates a target', async () => {
    writeProfile('arcp', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, calls } = makeTargetedConn('arcp@endpoint-0', { browser: 'arc' });
    attach(service, 'arcp', conn);

    await expect(service.start('arcp', { url: 'https://example.com' })).rejects.toThrow(
      /cannot open a NEW tab/,
    );
    // The whole point: not one Target.createTarget reached Arc.
    expect(createTargetCount(calls)).toBe(0);
  });

  it('bare start (startup blank window) throws instead of createTarget', async () => {
    writeProfile('arcp2', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, calls } = makeTargetedConn('arcp2@endpoint-0', { browser: 'arc' });
    attach(service, 'arcp2', conn);

    await expect(service.start('arcp2')).rejects.toThrow(/Chromium-family browser/);
    expect(createTargetCount(calls)).toBe(0);
  });

  it('the error names the offending profile and points at a drivable browser', () => {
    const msg = arcNotDrivableError('arc-local').message;
    expect(msg).toContain('arc-local');
    expect(msg).toContain('--browser comet');
  });
});

describe('BrowserService.navigate — Arc reuses a tab rather than refusing (#2786)', () => {
  // Arc crashes on Target.createTarget (#2778) but DOES expose page targets and
  // honors Page.navigate on them -- measured against a live Arc: 33 targets,
  // navigate reused one, tab count unchanged. Refusing every navigate left the
  // doc unshown and callers back on raw `open`, i.e. the tab-spam #2779 was
  // meant to end. Reuse is deliberately narrow: only a tab already showing the
  // requested URL, or an empty new-tab page.
  function arcConnWithEmptyTask(profile: string, pages: Array<{ targetId: string; url: string }>) {
    const { conn, calls, targets } = makeTargetedConn(`${profile}@endpoint-0`, { browser: 'arc', pages });
    (conn as unknown as { tasks: Map<string, unknown> }).tasks.set('arctask', {
      id: 'arctask',
      name: 'arctask',
      profile,
      tabs: {},
      currentTabId: undefined,
      createdAt: Date.now(),
      pid: 4242,
    });
    return { conn, calls, targets };
  }

  it('navigates a tab already showing that url, and never calls createTarget', async () => {
    writeProfile('arcnav', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, calls } = arcConnWithEmptyTask('arcnav', [
      { targetId: 'doc-tab', url: 'file:///tmp/plan.html' },
    ]);
    attach(service, 'arcnav', conn);

    const r = await service.navigate('arctask', 'file:///tmp/plan.html', 'arcnav');

    expect(r.created).toBe(false);
    expect(createTargetCount(calls)).toBe(0);
    expect(calls.filter((c) => c.method === 'Page.navigate')).toHaveLength(1);
  });

  it('reuses an empty new-tab page when no tab shows the url yet', async () => {
    writeProfile('arcblank', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, calls } = arcConnWithEmptyTask('arcblank', [
      { targetId: 'blank-tab', url: 'about:blank' },
    ]);
    attach(service, 'arcblank', conn);

    const r = await service.navigate('arctask', 'file:///tmp/plan.html', 'arcblank');

    expect(r.created).toBe(false);
    expect(createTargetCount(calls)).toBe(0);
    expect(calls.filter((c) => c.method === 'Page.navigate')).toHaveLength(1);
  });

  it("reuses the user's own tab showing that url — but done() must NOT close it", async () => {
    // The reviewer's scenario for the first attempt at this fix: a tab the USER
    // opened, showing the url a task navigates to, was claimed and then closed by
    // that task's done(). Reuse is still correct here (re-showing the same
    // document in place is the whole point), but the tab must outlive the task.
    writeProfile('arcborrow', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets, calls } = arcConnWithEmptyTask('arcborrow', [
      { targetId: 'users-own-tab', url: 'file:///tmp/plan.html' },
    ]);
    attach(service, 'arcborrow', conn);

    await service.navigate('arctask', 'file:///tmp/plan.html', 'arcborrow');
    const task = (conn as unknown as { tasks: Map<string, any> }).tasks.get('arctask');
    expect(Object.values(task.tabs)).toContain('users-own-tab');
    expect(task.borrowedTabs).toHaveLength(1);

    await service.done('arctask');

    // The user's tab is still there — never closed, and no close was attempted.
    expect(targets.map((t) => t.targetId)).toContain('users-own-tab');
    expect(calls.filter((c) => c.method === 'Target.closeTarget')).toHaveLength(0);
    expect(createTargetCount(calls)).toBe(0);
  });

  it('two concurrent navigates never both claim the same free target', async () => {
    // Stall an await that runs BEFORE the claim check (Target.attachToTarget,
    // inside getSessionId) -- not Page.navigate, which now runs after it. Only
    // this ordering actually exercises targetIsClaimed: with the claim written
    // before Page.navigate, a test that stalls Page.navigate passes even when
    // targetIsClaimed is neutered, so it proves nothing (reviewer-demonstrated).
    writeProfile('arcrace', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn } = arcConnWithEmptyTask('arcrace', [
      { targetId: 'free-tab', url: 'about:blank' },
    ]);
    const tasks = (conn as unknown as { tasks: Map<string, any> }).tasks;
    tasks.set('taskB', { ...tasks.get('arctask'), id: 'taskB', name: 'taskB', tabs: {} });
    attach(service, 'arcrace', conn);

    let releaseAttach: () => void = () => {};
    const attachStalled = new Promise<void>((r) => { releaseAttach = r; });
    // Signals that the FIRST attach has been entered. The test must wait on this
    // event, not on a timer: whoever calls attachToTarget first stalls until
    // `releaseAttach()`, which only runs after B's navigate returns — so if B
    // wins that race the two await each other and the test hangs to its 30s
    // timeout. It previously gave A a 5ms head start, but A alone does disk I/O
    // on the way there (`findTask` -> `touchTask` -> `await saveTaskState`,
    // service.ts:2984/2959; B's touch is coalesced by `lastTouchPersist`), and a
    // >5ms write on a loaded CI runner is ordinary. Reproduced by shrinking that
    // head start to 0: `Test timed out in 30000ms`, with no production change.
    let firstAttachEntered: () => void = () => {};
    const attachEntered = new Promise<void>((r) => { firstAttachEntered = r; });
    let attachCalls = 0;
    const inner = conn.cdp.send;
    conn.cdp.send = (async (method: string, params: any = {}, sess?: string) => {
      if (method === 'Target.attachToTarget' && ++attachCalls === 1) {
        firstAttachEntered();
        await attachStalled;
      }
      return inner(method, params, sess);
    }) as typeof conn.cdp.send;

    // A stalls before its claim check; B then runs start-to-finish and claims.
    const a = service.navigate('arctask', 'file:///tmp/doc.html', 'arcrace').catch((e) => e);
    // Race the signal against A itself: if A ever fails BEFORE reaching the
    // attach, waiting on `attachEntered` alone would hang to the same 30s
    // timeout this fix exists to remove. Losing that race is a real bug, so it
    // fails loudly here instead.
    const reached = await Promise.race([attachEntered.then(() => 'attached'), a.then(() => 'settled')]);
    expect(reached, 'A settled before it reached the claim check').toBe('attached');
    await service.navigate('taskB', 'file:///tmp/doc.html', 'arcrace');
    releaseAttach();
    const aResult = await a;

    // A must lose the race and be refused, not share B's tab.
    expect(aResult).toBeInstanceOf(Error);
    expect(Object.values(tasks.get('arctask').tabs)).not.toContain('free-tab');
    expect(Object.values(tasks.get('taskB').tabs)).toContain('free-tab');
  });

  it('a borrowed tab is never reclaimed into another task by adoptTabShowing', async () => {
    // Round-3 defect: a borrowed tab whose owning task died was reclaimed by a
    // NEW task with no borrow marking, so that task's done() closed a tab that
    // existed before either task. hygiene.ts notes agents routinely never call
    // done(), so abandoned tasks are the normal case, not the edge one.
    writeProfile('arcreclaim', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets } = arcConnWithEmptyTask('arcreclaim', [
      { targetId: 'pre-existing-tab', url: 'file:///tmp/doc.html' },
    ]);
    const tasks = (conn as unknown as { tasks: Map<string, any> }).tasks;
    attach(service, 'arcreclaim', conn);

    // A task borrows the pre-existing tab, then its owner goes away.
    await service.navigate('arctask', 'file:///tmp/doc.html', 'arcreclaim');
    const dead = tasks.get('arctask');
    expect(dead.borrowedTabs).toHaveLength(1);
    dead.sessionId = '33333333-3333-4333-8333-333333333333'; // a uuid no live process carries

    // A later start() on the same url must NOT be handed that borrowed tab.
    const live = await service.start('arcreclaim', { url: 'file:///tmp/doc.html' }).catch((e: Error) => e);

    // Arc cannot create a tab, so with reclaim correctly refused this refuses too --
    // the point is that the pre-existing tab was not silently transferred.
    expect(live).toBeInstanceOf(Error);
    expect(targets.map((t) => t.targetId)).toContain('pre-existing-tab');
  });

  it('tabClose drops the borrow record with the tab it names', async () => {
    writeProfile('arcprune', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn } = arcConnWithEmptyTask('arcprune', [
      { targetId: 'borrowed-tab', url: 'about:blank' },
    ]);
    attach(service, 'arcprune', conn);

    await service.navigate('arctask', 'file:///tmp/doc.html', 'arcprune');
    const task = (conn as unknown as { tasks: Map<string, any> }).tasks.get('arctask');
    const shortId = Object.keys(task.tabs)[0];
    expect(task.borrowedTabs).toEqual([shortId]);

    await service.tabClose('arctask', shortId);

    // Left behind, the shortId would name nothing and accumulate in tasks.json.
    expect(task.borrowedTabs).toEqual([]);
    expect(task.tabs[shortId]).toBeUndefined();
  });

  it('refuses rather than hijacking a page the user is reading', async () => {
    writeProfile('arcsafe', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, calls } = arcConnWithEmptyTask('arcsafe', [
      { targetId: 'users-article', url: 'https://news.example.com/story' },
    ]);
    attach(service, 'arcsafe', conn);

    await expect(service.navigate('arctask', 'file:///tmp/plan.html', 'arcsafe')).rejects.toThrow(
      /Chromium-family browser/,
    );
    expect(createTargetCount(calls)).toBe(0);
    expect(calls.filter((c) => c.method === 'Page.navigate')).toHaveLength(0);
  });
});

describe('BrowserService — Arc target-filter + first-use attach (PHNX-2399 review)', () => {
  // A bound --target-filter is now actually consulted when driving Arc, and the
  // documented `navigate --profile arc --url …` first-use flow attaches to an
  // existing tab instead of throwing on a task-less profile.
  function arcConnWithFilter(
    profile: string,
    pages: Array<{ targetId: string; url: string }>,
    targetFilter?: string,
  ) {
    const { conn, calls, targets } = makeTargetedConn(`${profile}@endpoint-0`, { browser: 'arc', pages });
    (conn as unknown as { targetFilter?: string }).targetFilter = targetFilter;
    (conn as unknown as { tasks: Map<string, unknown> }).tasks.set('arctask', {
      id: 'arctask',
      name: 'arctask',
      profile,
      tabs: {},
      currentTabId: undefined,
      createdAt: Date.now(),
      pid: 4242,
    });
    return { conn, calls, targets };
  }

  it('a bound url:target-filter selects the matching Space tab, never an unrelated one', async () => {
    writeProfile('arcnotion', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, calls } = arcConnWithFilter(
      'arcnotion',
      [
        { targetId: 'unrelated-tab', url: 'https://example.com/docs' },
        { targetId: 'notion-space', url: 'https://www.notion.so/team' },
      ],
      'url:notion.so',
    );
    attach(service, 'arcnotion', conn);

    await service.navigate('arctask', 'https://www.notion.so/team/page', 'arcnotion');

    const task = (conn as unknown as { tasks: Map<string, any> }).tasks.get('arctask');
    // The notion Space tab, bound by the filter — not the unrelated example.com tab.
    expect(Object.values(task.tabs)).toContain('notion-space');
    expect(Object.values(task.tabs)).not.toContain('unrelated-tab');
    expect(createTargetCount(calls)).toBe(0);
  });

  it('refuses rather than borrowing an unrelated tab when the filter matches nothing', async () => {
    writeProfile('arcnomatch', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, calls } = arcConnWithFilter(
      'arcnomatch',
      [{ targetId: 'other-tab', url: 'https://example.com' }],
      'url:notion.so',
    );
    attach(service, 'arcnomatch', conn);

    await expect(
      service.navigate('arctask', 'https://www.notion.so/page', 'arcnomatch'),
    ).rejects.toThrow(/cannot open a NEW tab/);
    expect(createTargetCount(calls)).toBe(0);
  });

  it('start({url}) on a task-less Arc profile ATTACHES to a reusable tab (the documented first-use flow)', async () => {
    // The reviewer's blocker: `navigate --profile arc --url …` with no live task
    // routes through start({url}), which used to throw for Arc. It must attach to
    // an existing tab instead — the whole point of the attach feature.
    writeProfile('arcfirst', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, calls } = makeTargetedConn('arcfirst@endpoint-0', {
      browser: 'arc',
      pages: [{ targetId: 'open-doc', url: 'https://example.com/plan' }],
    });
    attach(service, 'arcfirst', conn);

    const started = await service.start('arcfirst', { url: 'https://example.com/plan' });

    expect(started.tabId).toBeTruthy();
    expect(createTargetCount(calls)).toBe(0);
    const task = (conn as unknown as { tasks: Map<string, any> }).tasks.get(started.name);
    expect(Object.values(task.tabs)).toContain('open-doc');
  });
});

describe('BrowserService.start — URL reclaim (RUSH-2622)', () => {
  // A UUID no live process carries, so the real liveness predicate (registry +
  // process table) proves this task's owner gone without any injection.
  const GONE_SESSION = '33333333-3333-4333-8333-333333333333';

  it('reclaims the tab an abandoned task is still holding on that URL', async () => {
    writeProfile('reclaim', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets, calls } = makeTargetedConn('reclaim@endpoint-0');
    attach(service, 'reclaim', conn);

    const abandoned = await service.start('reclaim', {
      url: 'https://example.com/docs',
      sessionId: GONE_SESSION,
    });
    const next = await service.start('reclaim', { url: 'https://example.com/docs' });

    // One page, one create — the second start reclaimed the orphan's tab.
    expect(targets).toHaveLength(1);
    expect(createTargetCount(calls)).toBe(1);

    // Reclaim TRANSFERS rather than shares: two tasks pointing at one targetId
    // would mean the first `done` closes the other's tab.
    expect(conn.tasks.get(abandoned.name)!.tabs).toEqual({});
    expect(conn.tasks.get(abandoned.name)!.currentTabId).toBeUndefined();
    expect(Object.values(conn.tasks.get(next.name)!.tabs)).toEqual([targets[0].targetId]);
  });

  it('two concurrent starts never end up owning the same reclaimed tab', async () => {
    writeProfile('reclaimrace', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets } = makeTargetedConn('reclaimrace@endpoint-0');
    attach(service, 'reclaimrace', conn);

    await service.start('reclaimrace', {
      url: 'https://example.com/docs',
      sessionId: GONE_SESSION,
    });

    // Nothing serializes IPC requests, so both starts suspend on the same
    // liveness await and race for the one abandoned tab. Without the
    // post-await re-check both would return it, and the first `done` would
    // then close the other task's tab.
    const [a, b] = await Promise.all([
      service.start('reclaimrace', { url: 'https://example.com/docs' }),
      service.start('reclaimrace', { url: 'https://example.com/docs' }),
    ]);

    const owners = [a, b].map((s) => Object.values(conn.tasks.get(s.name)!.tabs)[0]);
    expect(owners[0]).not.toBe(owners[1]);
    expect(new Set(owners).size).toBe(2);
    // The loser opened its own tab rather than sharing.
    expect(targets).toHaveLength(2);
  });

  it('never takes a tab from a task whose owner cannot be proven gone', async () => {
    writeProfile('nosteal', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets, calls } = makeTargetedConn('nosteal@endpoint-0');
    attach(service, 'nosteal', conn);

    // No sessionId, so the owner can never be proven gone — the ordinary case
    // for a non-Claude harness. Stealing here would leave the first agent's
    // next `click`/`screenshot` throwing "No tabs open for this task".
    const live = await service.start('nosteal', { url: 'https://example.com/docs' });
    const other = await service.start('nosteal', { url: 'https://example.com/docs' });

    expect(createTargetCount(calls)).toBe(2);
    expect(targets).toHaveLength(2);
    expect(Object.values(conn.tasks.get(live.name)!.tabs)).toHaveLength(1);
    expect(Object.values(conn.tasks.get(other.name)!.tabs)).toHaveLength(1);
  });

  it('never adopts an unowned tab — that is the user\'s own tab', async () => {
    writeProfile('usertab', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets, calls } = makeTargetedConn('usertab@endpoint-0', {
      pages: [{ targetId: 'users-own-tab', url: 'https://example.com/docs' }],
    });
    attach(service, 'usertab', conn);

    const started = await service.start('usertab', { url: 'https://example.com/docs' });

    // Adopting it would make this task's `done` close a tab the user opened.
    expect(createTargetCount(calls)).toBe(1);
    expect(targets).toHaveLength(2);
    expect(Object.values(conn.tasks.get(started.name)!.tabs)).not.toContain('users-own-tab');

    await service.done(started.name);
    expect(targets.map((t) => t.targetId)).toEqual(['users-own-tab']);
  });

  it('never reclaims from an abandoned task that is mid-recording', async () => {
    writeProfile('recl-rec', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets, calls } = makeTargetedConn('recl-rec@endpoint-0');
    attach(service, 'recl-rec', conn);

    const abandoned = await service.start('recl-rec', {
      url: 'https://example.com/docs',
      sessionId: GONE_SESSION,
    });
    (service as unknown as { recordings: Map<string, unknown> }).recordings.set(abandoned.name, {
      outputPath: '/tmp/x.mp4',
      startedAt: Date.now(),
    });

    await service.start('recl-rec', { url: 'https://example.com/docs' });

    // Taking the recorded target would truncate the capture on the next `done`.
    expect(createTargetCount(calls)).toBe(2);
    expect(targets).toHaveLength(2);
    expect(Object.values(conn.tasks.get(abandoned.name)!.tabs)).toHaveLength(1);
  });

  it('matches a bare origin against the trailing-slash form Chrome reports', async () => {
    writeProfile('dedupurl', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, calls } = makeTargetedConn('dedupurl@endpoint-0');
    attach(service, 'dedupurl', conn);

    const abandoned = await service.start('dedupurl', {
      url: 'https://example.com/',
      sessionId: GONE_SESSION,
    });
    const reclaimed = Object.values(conn.tasks.get(abandoned.name)!.tabs)[0];

    // Requested bare, reported with the trailing slash — raw string compare
    // would miss every bare-origin match.
    const next = await service.start('dedupurl', { url: 'https://example.com' });

    expect(createTargetCount(calls)).toBe(1);
    expect(Object.values(conn.tasks.get(next.name)!.tabs)).toEqual([reclaimed]);
  });

  it('does not reclaim a different URL', async () => {
    writeProfile('dedupmiss', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets, calls } = makeTargetedConn('dedupmiss@endpoint-0');
    attach(service, 'dedupmiss', conn);

    await service.start('dedupmiss', { url: 'https://example.com/a', sessionId: GONE_SESSION });
    await service.start('dedupmiss', { url: 'https://example.com/b' });

    expect(createTargetCount(calls)).toBe(2);
    expect(targets).toHaveLength(2);
  });

  it('--fresh skips the reclaim even when an abandoned task holds that URL', async () => {
    writeProfile('freshp', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets, calls } = makeTargetedConn('freshp@endpoint-0');
    attach(service, 'freshp', conn);

    const abandoned = await service.start('freshp', {
      url: 'https://example.com/docs',
      sessionId: GONE_SESSION,
    });
    const second = await service.start('freshp', { url: 'https://example.com/docs', fresh: true });

    expect(createTargetCount(calls)).toBe(2);
    expect(targets).toHaveLength(2);
    expect(Object.values(conn.tasks.get(abandoned.name)!.tabs)).toHaveLength(1);
    expect(Object.values(conn.tasks.get(second.name)!.tabs)).toHaveLength(1);
  });
});

describe('Task.lastActionAt — activity stamp (RUSH-2622)', () => {
  it('starts equal to createdAt and advances on a task-scoped action', async () => {
    writeProfile('stampp', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn } = makeTargetedConn('stampp@endpoint-0');
    attach(service, 'stampp', conn);

    const started = await service.start('stampp', { url: 'https://example.com/one' });
    const task = conn.tasks.get(started.name)!;
    expect(task.lastActionAt).toBe(task.createdAt);

    const before = task.lastActionAt;
    await new Promise((r) => setTimeout(r, 5));
    await service.navigate(started.name, 'https://example.com/two');

    // navigate resolves through findTask, which is where the stamp is applied —
    // so every task-scoped action gets it without its own call site.
    expect(task.lastActionAt).toBeGreaterThan(before);
  });

  it('persists the stamp to tasks.json and normalizes a pre-RUSH-2622 task on read', async () => {
    writeProfile('loadp', ['cdp://localhost:9222']);
    const service = new BrowserService() as any;

    // A task written before the field existed.
    const runtimeDir = path.join(TEST_BROWSER_DIR, 'loadp');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeDir, 'tasks.json'),
      JSON.stringify({
        legacy: { id: 'legacy', name: 'legacy', profile: 'loadp', tabs: {}, createdAt: 1000, pid: 0 },
      })
    );

    const loaded = service.loadTaskState('loadp') as Map<string, { lastActionAt: number }>;
    expect(loaded.get('legacy')!.lastActionAt).toBe(1000);
  });
});

describe('BrowserService.reapAbandoned — abandoned-task reaper (RUSH-2622)', () => {
  const LIVE_SESSION = '11111111-1111-4111-8111-111111111111';
  const DEAD_SESSION = '22222222-2222-4222-8222-222222222222';

  /** Only LIVE_SESSION resolves; nothing is live on the process table. */
  const deps = {
    listEntries: () => [
      { pid: 111, agent: 'claude', sessionId: LIVE_SESSION, launchId: 'launch-live', startedAtMs: 1 },
      { pid: 222, agent: 'claude', sessionId: DEAD_SESSION, launchId: 'launch-dead', startedAtMs: 1 },
    ],
    pidAlive: (pid: number) => pid === 111,
    sessionIdOfPid: () => undefined,
    sessionLiveOnProcessTable: async () => false,
  };

  async function startTask(
    service: any,
    profile: string,
    identity: { sessionId?: string; launchId?: string }
  ) {
    return service.start(profile, { url: `https://example.com/${Math.random()}`, ...identity });
  }

  it('stops a task whose agent session is gone and leaves a live one alone', async () => {
    writeProfile('reap1', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets } = makeTargetedConn('reap1@endpoint-0');
    attach(service, 'reap1', conn);

    const dead = await startTask(service, 'reap1', { sessionId: DEAD_SESSION, launchId: 'launch-dead' });
    const live = await startTask(service, 'reap1', { sessionId: LIVE_SESSION, launchId: 'launch-live' });
    expect(targets).toHaveLength(2);

    const result = await service.reapAbandoned({ deps });

    expect(result.closed).toEqual([
      // The reaper reports the BARE profile — its output is a user-facing
      // `agents browser prune` line, not a runtime key (RUSH-2709).
      { task: dead.name, profile: 'reap1', reason: 'session-dead' },
    ]);
    expect(result.skipped).toBe(1);
    expect(conn.tasks.has(dead.name)).toBe(false);
    expect(conn.tasks.has(live.name)).toBe(true);
    // The dead task's tab is gone; the live task's is untouched.
    expect(targets).toHaveLength(1);
    expect(Object.values(conn.tasks.get(live.name)!.tabs)).toEqual([targets[0].targetId]);
  });

  it('never session-reaps a task that carries no identity at all', async () => {
    writeProfile('reap2', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets } = makeTargetedConn('reap2@endpoint-0');
    attach(service, 'reap2', conn);

    // A human running `agents browser start` by hand: no session, no launch.
    await startTask(service, 'reap2', {});

    const result = await service.reapAbandoned({ deps });

    expect(result.closed).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(targets).toHaveLength(1);
  });

  it('never session-reaps a launchId-only task — the registry is its only witness', async () => {
    writeProfile('reap2b', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets } = makeTargetedConn('reap2b@endpoint-0');
    attach(service, 'reap2b', conn);

    // Every `agents run` mints a launchId, but AGENT_SESSION_ID is Claude-only
    // and skipped on resume — so this is a live codex/droid/grok run whose
    // launch pid has already exited and been pruned from the registry. Only a
    // sessionId has a second witness (the process table); treating a missing
    // registry entry as proof of death here would close a working agent's tabs.
    const t = await startTask(service, 'reap2b', { launchId: 'launch-dead' });

    const result = await service.reapAbandoned({ deps });

    expect(result.closed).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(conn.tasks.has(t.name)).toBe(true);
    expect(targets).toHaveLength(1);
  });

  it('rejects a non-positive or non-numeric idle window instead of reaping everything', async () => {
    writeProfile('reap9', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets } = makeTargetedConn('reap9@endpoint-0');
    attach(service, 'reap9', conn);
    const fresh = await startTask(service, 'reap9', {});

    // `0` survives `??` and would close a task created a millisecond ago; NaN
    // makes every comparison false and silently disables idle reaping.
    await expect(service.reapAbandoned({ deps, idleMs: 0 })).rejects.toThrow(/positive number/);
    await expect(service.reapAbandoned({ deps, idleMs: NaN })).rejects.toThrow(/positive number/);

    expect(conn.tasks.has(fresh.name)).toBe(true);
    expect(targets).toHaveLength(1);
  });

  it('keeps a task whose launchId is still live even when its sessionId is not', async () => {
    writeProfile('reap3', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn } = makeTargetedConn('reap3@endpoint-0');
    attach(service, 'reap3', conn);

    // Half-resolved identity is not proof of death.
    const t = await startTask(service, 'reap3', { sessionId: DEAD_SESSION, launchId: 'launch-live' });

    const result = await service.reapAbandoned({ deps });

    expect(result.closed).toEqual([]);
    expect(conn.tasks.has(t.name)).toBe(true);
  });

  it('keeps a session the registry missed but the process table can still see', async () => {
    writeProfile('reap4', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn } = makeTargetedConn('reap4@endpoint-0');
    attach(service, 'reap4', conn);

    const t = await startTask(service, 'reap4', { sessionId: DEAD_SESSION });

    // RUSH-2384: the by-pid registry is often empty mid-run, so a live process
    // carrying --session-id is the authoritative second opinion.
    const result = await service.reapAbandoned({
      deps: { ...deps, listEntries: () => [], sessionLiveOnProcessTable: async () => true },
    });

    expect(result.closed).toEqual([]);
    expect(conn.tasks.has(t.name)).toBe(true);
  });

  it('reaps a task idle past the window and keeps one inside it', async () => {
    writeProfile('reap5', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets } = makeTargetedConn('reap5@endpoint-0');
    attach(service, 'reap5', conn);

    const stale = await startTask(service, 'reap5', {});
    const recent = await startTask(service, 'reap5', {});
    const now = Date.now();
    conn.tasks.get(stale.name)!.lastActionAt = now - 31 * 60_000;
    conn.tasks.get(recent.name)!.lastActionAt = now - 5 * 60_000;

    const result = await service.reapAbandoned({ deps, now });

    expect(result.closed).toEqual([
      { task: stale.name, profile: 'reap5', reason: 'idle' },
    ]);
    expect(result.skipped).toBe(1);
    expect(conn.tasks.has(recent.name)).toBe(true);
    expect(targets).toHaveLength(1);
  });

  it('closes only the reaped task\'s own tabs — never a stray tab or the browser', async () => {
    writeProfile('reap6', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets, calls } = makeTargetedConn('reap6@endpoint-0', {
      pages: [{ targetId: 'stray', url: 'https://someone-else.example/' }],
    });
    attach(service, 'reap6', conn);

    const stale = await startTask(service, 'reap6', {});
    const now = Date.now();
    conn.tasks.get(stale.name)!.lastActionAt = now - 31 * 60_000;

    await service.reapAbandoned({ deps, now });

    expect(targets.map((t) => t.targetId)).toEqual(['stray']);
    expect(calls.filter((c) => c.method === 'Target.closeTarget')).toHaveLength(1);
    // The shared profile window / browser process is not ours to kill.
    expect(conn.cdp.close).not.toHaveBeenCalled();
    expect((service as unknown as { connections: Map<string, unknown> }).connections.size).toBe(1);
  });

  it('dryRun reports what it would close without closing it', async () => {
    writeProfile('reap7', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets } = makeTargetedConn('reap7@endpoint-0');
    attach(service, 'reap7', conn);

    const stale = await startTask(service, 'reap7', {});
    const now = Date.now();
    conn.tasks.get(stale.name)!.lastActionAt = now - 31 * 60_000;

    const result = await service.reapAbandoned({ deps, now, dryRun: true });

    expect(result.closed).toEqual([
      // Same bare shape the real (non-dry) run reports, so the two agree.
      { task: stale.name, profile: 'reap7', reason: 'idle' },
    ]);
    expect(conn.tasks.has(stale.name)).toBe(true);
    expect(targets).toHaveLength(1);
  });

  it('leaves a recording task alone even when it is past the idle window', async () => {
    writeProfile('reap8', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets } = makeTargetedConn('reap8@endpoint-0');
    attach(service, 'reap8', conn);

    const stale = await startTask(service, 'reap8', {});
    const now = Date.now();
    conn.tasks.get(stale.name)!.lastActionAt = now - 31 * 60_000;
    // Reaping mid-capture would truncate a recording the user asked for.
    (service as unknown as { recordings: Map<string, unknown> }).recordings.set(stale.name, {
      outputPath: '/tmp/x.mp4',
      startedAt: now,
    });

    const result = await service.reapAbandoned({ deps, now });

    expect(result.closed).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(targets).toHaveLength(1);
  });
});

describe('BrowserService.start — registry resolution', () => {
  it('fails loud when nobody declares the name, and launches no browser', async () => {
    writeProfile('comet-local', ['cdp://localhost:9333']);
    const service = new BrowserService();
    const before = fs.existsSync(TEST_BROWSER_DIR)
      ? fs.readdirSync(TEST_BROWSER_DIR)
      : [];

    await expect(service.start('comet-locl')).rejects.toThrow(/comet-local/);
    await expect(service.start('comet-locl')).rejects.toThrow(/not declared by any device/);

    const after = fs.existsSync(TEST_BROWSER_DIR) ? fs.readdirSync(TEST_BROWSER_DIR) : [];
    expect(after.filter((entry) => entry.includes('comet-locl'))).toEqual([]);
    expect(after.filter((entry) => entry.includes('chrome-data'))).toEqual(
      before.filter((entry) => entry.includes('chrome-data')),
    );
  });

  it('fails loud when the only declaring device is unreachable, and launches no browser', async () => {
    writeProfile('comet-local', ['cdp://localhost:9333'], 'comet', 'zion');
    const service = new BrowserService();

    await expect(
      service.start('comet-local', {
        probe: () => ({ reachable: false, reason: 'No route to host' }),
      }),
    ).rejects.toThrow(/zion/);
    await expect(
      service.start('comet-local', {
        probe: () => ({ reachable: false, reason: 'No route to host' }),
      }),
    ).rejects.toThrow(/will not be launched/);

    expect(
      fs.existsSync(TEST_BROWSER_DIR)
        ? fs.readdirSync(TEST_BROWSER_DIR).filter((entry) => entry.startsWith('comet-local'))
        : [],
    ).toEqual([]);
  });

  it('two concurrent callers of an identity-bearing profile share one connection and one chrome-data dir', async () => {
    writeProfile('signed-in', ['cdp://localhost:9333'], 'comet');
    const service = new BrowserService();
    const { conn } = makeTargetedConn('signed-in@endpoint-0', {
      browser: 'comet',
      pages: [{ targetId: 'win', url: 'https://github.com' }],
    });
    (conn as { electron: boolean }).electron = true;
    (conn as { tasks: Map<string, unknown> }).tasks.set('seed', {
      id: 'seed',
      name: 'seed',
      profile: 'signed-in@endpoint-0',
      tabs: { t1: 'win' },
      currentTabId: 't1',
      createdAt: Date.now(),
      lastActionAt: Date.now(),
      pid: 4242,
    });
    attach(service, 'signed-in', conn);

    const chromeData = path.join(TEST_BROWSER_DIR, 'signed-in@endpoint-0', 'chrome-data');
    fs.mkdirSync(chromeData, { recursive: true });
    fs.writeFileSync(path.join(chromeData, 'Cookies'), 'identity');

    await Promise.all([
      service.start('signed-in'),
      service.start('signed-in'),
    ]);

    const map = (service as unknown as { connections: Map<string, unknown> }).connections;
    expect(map.size).toBe(1);

    const chromeDataDirs = fs.readdirSync(TEST_BROWSER_DIR).filter((entry) => {
      try {
        return fs.statSync(path.join(TEST_BROWSER_DIR, entry, 'chrome-data')).isDirectory();
      } catch {
        return false;
      }
    });
    expect(chromeDataDirs).toEqual(['signed-in@endpoint-0']);
    expect(fs.readFileSync(path.join(chromeData, 'Cookies'), 'utf8')).toBe('identity');
  });
});

/**
 * Production failure on a machine whose default profile is an Arc one: a task whose
 * tab had been moved or closed made `agents browser status` throw, and EVERY
 * profile vanished from the listing — including healthy ones that had nothing
 * to do with Arc.
 *
 * The refusal itself is correct and deliberate: `listArcTaskTabs` will not adopt
 * a tab that is no longer in its original window/Space, because adopting one
 * would let an action drive a tab the task does not own. That guarantee is
 * unchanged here. What changed is that a READ-ONLY status no longer inherits the
 * blast radius of that refusal.
 */
describe('BrowserService.status — a stale Arc task must not abort the listing', () => {
  /**
   * An arc-native connection whose task has an unusable Arc identity.
   *
   * `moved: true` reproduces the production defect with no mocking and no macOS:
   * the tab's ref names a different window than the task recorded, which is what
   * a moved tab looks like on disk, so the real `requireArcTask` rejects it and
   * the real throw travels the real status path.
   */
  function registerArcProfile(
    service: InstanceType<typeof BrowserService>,
    key: string,
    opts: { moved: boolean; tabIds: string[] },
  ): void {
    const windowId = 'window-1';
    const tabs: Record<string, { windowId: string; spaceId: string; tabId: string }> = {};
    for (const id of opts.tabIds) {
      tabs[id] = {
        windowId: opts.moved ? 'window-2-somewhere-else' : windowId,
        spaceId: 'space-1',
        tabId: `arc-${id}`,
      };
    }
    const task = {
      id: 'arc-task-1',
      name: 'stale-arc-task',
      label: 'stale-arc-task',
      profile: key,
      tabs: Object.fromEntries(opts.tabIds.map((id) => [id, `arc-${id}`])),
      currentTabId: opts.tabIds[0],
      createdAt: 1_700_000_000_000,
      lastActionAt: 1_700_000_000_000,
      pid: 0,
      arcNative: {
        profileId: 'arc-profile',
        windowId,
        spaceId: 'space-1',
        spaceTitle: 'Work',
        tabs,
      },
    };
    (service as unknown as { connections: Map<string, unknown> }).connections.set(key, {
      backend: 'arc-native',
      key,
      profile: key.split('@')[0],
      tasks: new Map([[task.name, task]]),
      sessionCache: new Map(),
      port: 0,
      pid: 0,
      electron: false,
      browserType: 'arc',
      arcProfile: 'arc-profile',
    });
  }

  it('reports the healthy profile even when an Arc task is unreadable', async () => {
    writeProfile('rush-mini', ['cdp://localhost:9222']);
    writeRunningChrome('rush-mini', 9222, process.pid);
    writeTaskState('rush-mini', [{ id: 'work', tabIds: ['tab1'], createdAt: 100 }]);

    const service = new BrowserService();
    registerArcProfile(service, 'arc-primary', { moved: true, tabIds: ['t1'] });

    const result = await service.status();

    // Before the fix this threw, so there was no result at all.
    const healthy = result.find((p) => p.name === 'rush-mini');
    expect(healthy).toBeDefined();
    expect(healthy).toMatchObject({ running: true, port: 9222, pid: process.pid });
    expect(healthy!.unavailable).toBeUndefined();
    expect(healthy!.tasks[0]).toMatchObject({ id: 'work', tabCount: 1 });
  });

  it('still lists the Arc profile, and says its tabs could not be read', async () => {
    const service = new BrowserService();
    registerArcProfile(service, 'arc-primary', { moved: true, tabIds: ['t1', 't2'] });

    const result = await service.status();

    const arc = result.find((p) => p.name === 'arc-primary');
    expect(arc).toBeDefined();

    const task = arc!.tasks[0];
    expect(task.unavailable).toMatch(/stable id in its original window/);
    // Never claims the stale tabs are live: absent, not an empty array, which
    // would read as "this task genuinely has no tabs open right now".
    expect(task.tabs).toBeUndefined();
    expect(task.domains).toEqual([]);
    // The recorded count is on-disk truth and stays.
    expect(task.tabCount).toBe(2);
  });

  it('reports every Arc profile when several have stale tasks', async () => {
    writeProfile('rush-mini', ['cdp://localhost:9222']);
    writeRunningChrome('rush-mini', 9222, process.pid);

    const service = new BrowserService();
    registerArcProfile(service, 'arc-one', { moved: true, tabIds: ['t1'] });
    registerArcProfile(service, 'arc-two', { moved: true, tabIds: ['t9'] });

    const result = await service.status();

    expect(result.map((p) => p.name).sort()).toEqual(['arc-one', 'arc-two', 'rush-mini']);
    for (const name of ['arc-one', 'arc-two']) {
      expect(result.find((p) => p.name === name)!.tasks[0].unavailable).toBeTruthy();
    }
  });
});

/**
 * The snapshot path status uses instead of asking Arc about each tab.
 *
 * These call the real resolver with an explicit snapshot — the same shape
 * `enumerateArcSpaces` returns — so they test the actual ownership rule rather
 * than a stand-in. They say nothing about how fast Arc answers on macOS; the
 * process-budget claim belongs to a real macOS run.
 */
describe('listArcTaskTabsFromSnapshot — ownership against one shared snapshot', () => {
  const SNAPSHOT = [
    {
      windowId: 'window-1',
      spaceId: 'space-1',
      spaceTitle: 'Work',
      tabs: [
        { windowId: 'window-1', spaceId: 'space-1', tabId: 'arc-t1', url: 'https://example.com/a', title: 'A' },
        { windowId: 'window-1', spaceId: 'space-1', tabId: 'arc-t2', url: 'https://example.org/b', title: 'B' },
      ],
    },
  ];

  function task(tabs: Record<string, { windowId: string; spaceId: string; tabId: string }>) {
    return {
      id: 'arc-task-1',
      name: 'work',
      profile: 'arc-primary',
      tabs: Object.fromEntries(Object.keys(tabs).map((k) => [k, `arc-${k}`])),
      currentTabId: 't1',
      createdAt: 1_700_000_000_000,
      arcNative: {
        profileId: 'arc-profile',
        windowId: 'window-1',
        spaceId: 'space-1',
        spaceTitle: 'Work',
        tabs,
      },
    };
  }

  function resolve(t: unknown, snapshot: unknown = SNAPSHOT) {
    const service = new BrowserService();
    return (
      service as unknown as {
        listArcTaskTabsFromSnapshot: (t: unknown, s: () => Promise<unknown>) => Promise<unknown>;
      }
    ).listArcTaskTabsFromSnapshot(t, async () => snapshot);
  }

  it('resolves every owned tab from the snapshot, with url, title and current', async () => {
    const tabs = (await resolve(
      task({
        t1: { windowId: 'window-1', spaceId: 'space-1', tabId: 'arc-t1' },
        t2: { windowId: 'window-1', spaceId: 'space-1', tabId: 'arc-t2' },
      }),
    )) as Array<{ id: string; url: string; title: string; current: boolean }>;

    expect(tabs).toEqual([
      { id: 't1', url: 'https://example.com/a', title: 'A', task: 'work', current: true },
      { id: 't2', url: 'https://example.org/b', title: 'B', task: 'work', current: false },
    ]);
  });

  it('refuses a tab that is no longer in the snapshot (closed)', async () => {
    await expect(
      resolve(task({ t1: { windowId: 'window-1', spaceId: 'space-1', tabId: 'arc-gone' } })),
    ).rejects.toThrow(/missing from its original window\/Space/);
  });

  it('refuses a tab that moved, from the record alone, before reading the snapshot', async () => {
    // The snapshot would happily match this tab id, but the ref names a window
    // the task does not own, so ownership fails first. That ordering is why a
    // stale task reports the right reason even when Arc cannot be reached.
    let snapshotRead = false;
    const service = new BrowserService();
    const moved = task({ t1: { windowId: 'window-2-somewhere-else', spaceId: 'space-1', tabId: 'arc-t1' } });

    await expect(
      (
        service as unknown as {
          listArcTaskTabsFromSnapshot: (t: unknown, s: () => Promise<unknown>) => Promise<unknown>;
        }
      ).listArcTaskTabsFromSnapshot(moved, async () => {
        snapshotRead = true;
        return SNAPSHOT;
      }),
    ).rejects.toThrow(/stable id in its original window/);

    expect(snapshotRead).toBe(false);
  });
});

/**
 * Cold status: nothing in memory, saved runtime dirs on disk, one of them
 * unreadable. Rehydration runs before any per-profile guard, so an unreadable
 * saved profile used to abort the whole pass and hide healthy ones.
 *
 * The fixture is a REAL corrupt `tasks.json` — a truncated file, which is what a
 * crash mid-write leaves — so `loadTaskState`'s own `JSON.parse` throws on the
 * real path. Nothing is mocked.
 */
describe('BrowserService.status — a cold pass survives an unreadable saved profile', () => {
  function writeCorruptRuntimeDir(key: string): void {
    const dir = path.join(TEST_BROWSER_DIR, key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tasks.json'), '{"task-a": {"id": "a", "tabs":');
  }

  it('reports the unreadable profile and still lists the healthy one', async () => {
    writeProfile('rush-mini', ['cdp://localhost:9222']);
    writeRunningChrome('rush-mini', 9222, process.pid);
    writeTaskState('rush-mini', [{ id: 'work', tabIds: ['tab1'], createdAt: 100 }]);
    writeCorruptRuntimeDir('broken-profile');

    const service = new BrowserService();
    const result = await service.status();

    // Healthy profile survives — before this, the corrupt dir threw first.
    const healthy = result.find((p) => p.name === 'rush-mini');
    expect(healthy).toBeDefined();
    expect(healthy).toMatchObject({ running: true, port: 9222 });
    expect(healthy!.unavailable).toBeUndefined();

    // The unreadable one is reported, not silently dropped, and its
    // `running: false` comes with the reason rather than standing alone.
    const broken = result.find((p) => p.name === 'broken-profile');
    expect(broken).toBeDefined();
    expect(broken!.running).toBe(false);
    expect(broken!.unavailable).toBeTruthy();
    expect(broken!.tasks).toEqual([]);
  });

  it('reports a live-but-unreadable runtime exactly ONCE, not twice', async () => {
    // A profile with a valid running pid/port AND a corrupt tasks.json is seen
    // by both rehydration and the disk reconcile, since both read that same
    // file. Reported once, keyed by the runtime that actually failed.
    writeProfile('half-broken', ['cdp://localhost:9333']);
    writeRunningChrome('half-broken', 9333, process.pid);
    const dir = path.join(TEST_BROWSER_DIR, 'half-broken');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tasks.json'), '{"task-a": {"id": "a", "tabs":');

    writeProfile('rush-mini', ['cdp://localhost:9222']);
    writeRunningChrome('rush-mini', 9222, process.pid);
    writeTaskState('rush-mini', [{ id: 'work', tabIds: ['tab1'], createdAt: 100 }]);

    const service = new BrowserService();
    const result = await service.status();

    const rows = result.filter((p) => p.name === 'half-broken');
    expect(rows).toHaveLength(1);
    expect(rows[0].unavailable).toBeTruthy();
    expect(rows[0].key).toBe('half-broken');

    // The healthy neighbour is unaffected.
    const healthy = result.find((p) => p.name === 'rush-mini');
    expect(healthy).toBeDefined();
    expect(healthy!.unavailable).toBeUndefined();
    expect(healthy).toMatchObject({ running: true, port: 9222 });
  });

  it('names the runtime that actually failed, not the first one listed', async () => {
    // Two runtimes for one profile: the FIRST is dead (no pid/port) and the
    // SECOND is live but corrupt. Reporting the first would name the wrong dir.
    writeProfile('two-runtimes', ['cdp://localhost:9444']);
    const dead = path.join(TEST_BROWSER_DIR, 'two-runtimes');
    fs.mkdirSync(dead, { recursive: true });
    const live = path.join(TEST_BROWSER_DIR, 'two-runtimes@device-b');
    fs.mkdirSync(live, { recursive: true });
    fs.writeFileSync(path.join(live, 'pid'), String(process.pid));
    fs.writeFileSync(path.join(live, 'port'), '9444');
    fs.writeFileSync(path.join(live, 'tasks.json'), '{"task-a": {"id": "a", "tabs":');

    const service = new BrowserService();
    const result = await service.status('two-runtimes');

    const row = result.find((p) => p.unavailable);
    expect(row).toBeDefined();
    expect(row!.key).toBe('two-runtimes@device-b');
  });

  it('reports it for a scoped query too', async () => {
    writeCorruptRuntimeDir('broken-profile');

    const service = new BrowserService();
    const result = await service.status('broken-profile');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'broken-profile', running: false });
    expect(result[0].unavailable).toBeTruthy();
  });
});
