import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as secretsClient from '../secrets-client.js';
import * as stateModule from '../state.js';
import { buildBootstrapScript, leaseAndRun, leaseWorkspaceId, isExpiredPoolStray, STRAY_GRACE_SECS, LEASE_BOOTSTRAP_FAILED_CODE } from './lease.js';
import { resetCrabboxSecretsMemosForTest, type CrabboxBox } from './cli.js';
import { LEASE_AGENT_MARKER, leasePhaseSentinel } from './progress.js';
import type { DetectedRuntime } from './runtimes.js';

describe('buildBootstrapScript', () => {
  const detected: DetectedRuntime[] = [
    { id: 'claude', label: 'Claude Code', email: 'a@b.com', signedIn: true, credPath: null },
  ];

  it('ensures agents-cli, installs runtimes, runs the agent, and shreds creds', () => {
    const script = buildBootstrapScript({
      agent: 'claude',
      prompt: 'print hostname',
      runtimes: ['claude'],
      detected,
    });
    expect(script).toContain('command -v agents');
    expect(script).toContain('npm install -g @phnx-labs/agents-cli');
    expect(script).toContain("agents add 'claude'");
    expect(script).toContain("agents run 'claude' 'print hostname' --quiet");
    expect(script).toContain('rm -f "$HOME/.claude.json"'); // shred
    expect(script).toContain('exit $rc');
  });

  it('emits the agent-output marker immediately before the run (splits setup from output)', () => {
    const script = buildBootstrapScript({ agent: 'claude', prompt: 'hi', runtimes: ['claude'], detected });
    const markerAt = script.indexOf(`echo '${LEASE_AGENT_MARKER}'`);
    const runAt = script.indexOf("agents run 'claude' 'hi' --quiet");
    expect(markerAt).toBeGreaterThan(-1);
    // Marker is emitted after credential setup and directly before the agent run.
    expect(markerAt).toBeLessThan(runAt);
    expect(script.slice(markerAt, runAt).trim()).toBe(`echo '${LEASE_AGENT_MARKER}'`);
  });

  it('bootstraps node user-level and fails loud when agents-cli is not runnable', () => {
    const script = buildBootstrapScript({
      agent: 'claude',
      prompt: 'print hostname',
      runtimes: ['claude'],
      detected,
    });
    // Fresh crabbox images ship without node; everything must land in ~/.local.
    expect(script).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect(script).toContain('command -v node');
    expect(script).toContain('nodejs.org/dist/latest-v22.x');
    expect(script).toContain('npm config set prefix "$HOME/.local"');
    // A missing CLI must abort with a diagnostic, not run into `agents: command not found`.
    expect(script).toContain('exit 96');
    // First-run setup is gated on the same postcondition the run-side gate checks
    // (`~/.agents/.system` is a git repo), and a setup that leaves it absent aborts the bootstrap.
    // `-e` matches isGitRepo's existsSync (a gitfile counts).
    expect(script).toContain('if [ ! -e "$HOME/.agents/.system/.git" ]; then');
    expect(script).toContain('setup_out=$(agents setup 2>&1)');
    expect(script).toContain(`exit ${LEASE_BOOTSTRAP_FAILED_CODE}`);
    // The old swallow (`agents setup >/dev/null 2>&1 || true`) is gone.
    expect(script).not.toContain('agents setup >/dev/null 2>&1 || true');
    // Node bootstrap runs before the credential write — never after.
    expect(script.indexOf('command -v node')).toBeLessThan(script.indexOf("agents run 'claude'"));
  });

  it('shreds the claude OAuth token file after the run, regardless of --keep-box', () => {
    for (const keep of [false, true]) {
      const script = buildBootstrapScript({
        agent: 'claude',
        prompt: 'print hostname',
        runtimes: ['claude'],
        detected,
        keep,
      });
      // Both the config AND the token file are removed post-run (shred is in the
      // box body, not teardown — a kept box still loses the token).
      expect(script).toContain('rm -f "$HOME/.claude.json"');
      expect(script).toContain('rm -f "$HOME/.claude/.credentials.json"');
    }
  });

  it('materializes a profile-dispatch run without copying Claude OAuth when the profile has its own auth', () => {
    const script = buildBootstrapScript({
      agent: 'kimi',
      prompt: 'hi',
      runtimes: ['claude'],
      credentialRuntimes: [],
      detected,
      dispatchProfile: {
        name: 'kimi',
        agent: 'claude',
        env: {
          ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
          ANTHROPIC_MODEL: 'moonshotai/kimi-k2.5',
          ANTHROPIC_AUTH_TOKEN: 'sk-or-profile',
        },
        provider: 'openrouter',
        preset: 'kimi',
      },
    });
    expect(script).toContain("agents add 'claude'");
    expect(script).toContain('cat > "$HOME/.agents/profiles/kimi.yml" <<');
    expect(script).toContain('ANTHROPIC_AUTH_TOKEN: sk-or-profile');
    expect(script).toContain("agents run 'kimi' 'hi' --quiet");
    expect(script).not.toContain('cat > "$HOME/.claude.json"');
    expect(script).not.toContain('cat > "$HOME/.claude/.credentials.json"');
    expect(script).toContain('rm -f "$HOME/.agents/profiles/kimi.yml"');
  });

  it('installs the pinned base runtime version for a profile-dispatch run', () => {
    const script = buildBootstrapScript({
      agent: 'kimi',
      prompt: 'hi',
      runtimes: ['claude'],
      credentialRuntimes: [],
      detected,
      dispatchProfile: {
        name: 'kimi',
        agent: 'claude',
        version: '2.1.113',
        env: {
          ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
          ANTHROPIC_MODEL: 'moonshotai/kimi-k2.5',
          ANTHROPIC_AUTH_TOKEN: 'sk-or-profile',
        },
      },
    });
    expect(script).toContain("agents add 'claude@2.1.113'");
    expect(script).toContain('version: 2.1.113');
    expect(script.indexOf("agents add 'claude@2.1.113'")).toBeLessThan(
      script.indexOf('cat > "$HOME/.agents/profiles/kimi.yml"'),
    );
    expect(script).toContain("agents run 'kimi' 'hi' --quiet");
  });

  it('REFUSES to copy a base runtime native credential (SING-1b) — the profile auth is portable, the native login is not', () => {
    // A profile-dispatch run's portable auth is fine, but `credentialRuntimes: ['claude']` also
    // asks to copy the native Claude OAuth login, the forbidden transfer, so the bootstrap must
    // refuse rather than serialize it.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-profile-'));
    const credPath = path.join(tmpDir, 'claude.json');
    fs.writeFileSync(credPath, '{"oauthAccount":{"emailAddress":"a@b.com"}}');
    const detectedWithCred: DetectedRuntime[] = [{ ...detected[0], credPath }];
    try {
      expect(() =>
        buildBootstrapScript({
          agent: 'internal-claude',
          prompt: 'hi',
          runtimes: ['claude'],
          credentialRuntimes: ['claude'],
          detected: detectedWithCred,
          claudeCredentialsJson: '{"claudeAiOauth":{"accessToken":"tok"}}',
          dispatchProfile: {
            name: 'internal-claude',
            agent: 'claude',
            env: {
              ANTHROPIC_BASE_URL: 'https://gateway.example.test',
              ANTHROPIC_MODEL: 'claude-sonnet-4-5',
            },
          },
        }),
      ).toThrow(/Refusing to copy native OAuth/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('threads mode/model into the remote run', () => {
    const script = buildBootstrapScript({
      agent: 'codex',
      prompt: 'fix it',
      mode: 'edit',
      model: 'gpt-5',
      runtimes: ['codex'],
      detected,
    });
    expect(script).toContain("agents run 'codex' 'fix it' --quiet --mode 'edit' --model 'gpt-5'");
  });

  it('emits ordered phase sentinels around each setup block', () => {
    const script = buildBootstrapScript({ agent: 'claude', prompt: 'hi', runtimes: ['claude'], detected });
    const order = ['sync', 'install', 'runtime', 'creds', 'copy-setup'].map((n) =>
      script.indexOf(`echo '${leasePhaseSentinel(n)}'`),
    );
    for (const at of order) expect(at).toBeGreaterThan(-1);
    // Strictly increasing — sentinels appear in block order.
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
    // install sentinel precedes the node bootstrap; creds precedes the marker.
    expect(script.indexOf(`echo '${leasePhaseSentinel('install')}'`)).toBeLessThan(script.indexOf('command -v node'));
    expect(script.indexOf(`echo '${leasePhaseSentinel('copy-setup')}'`)).toBeLessThan(
      script.indexOf(`echo '${LEASE_AGENT_MARKER}'`),
    );
  });

  it('omits the copy-setup sentinel when copySetup is false (--bare)', () => {
    const script = buildBootstrapScript({ agent: 'claude', prompt: 'hi', runtimes: ['claude'], detected, copySetup: false });
    expect(script).not.toContain(`echo '${leasePhaseSentinel('copy-setup')}'`);
    // The other sentinels still fire.
    expect(script).toContain(`echo '${leasePhaseSentinel('sync')}'`);
    expect(script).toContain(`echo '${leasePhaseSentinel('creds')}'`);
  });

  it('materializes the pushed config with `agents sync --local` at the copy-setup step (F1 wiring)', () => {
    // The host rsyncs ~/.agents before the box run (leaseAndRun); the box then
    // reconciles it into the runtime home — but only after the install step has
    // put agents-cli on PATH, and only when copySetup is on.
    const on = buildBootstrapScript({ agent: 'claude', prompt: 'hi', runtimes: ['claude'], detected });
    expect(on).toContain('agents sync --local');
    // Sync runs after the runtime install (agents-cli present) and before the agent marker.
    expect(on.indexOf('agents sync --local')).toBeGreaterThan(on.indexOf(`echo '${leasePhaseSentinel('install')}'`));
    expect(on.indexOf('agents sync --local')).toBeLessThan(on.indexOf(LEASE_AGENT_MARKER));
    // --bare drops the sync with the sentinel.
    const bare = buildBootstrapScript({ agent: 'claude', prompt: 'hi', runtimes: ['claude'], detected, copySetup: false });
    expect(bare).not.toContain('agents sync --local');
  });

  it('emits the joined-tailnet sentinel only for a tailscale lease', () => {
    const pub = buildBootstrapScript({ agent: 'claude', prompt: 'hi', runtimes: ['claude'], detected });
    expect(pub).not.toContain(`echo '${leasePhaseSentinel('joined-tailnet')}'`);
    const ts = buildBootstrapScript({ agent: 'claude', prompt: 'hi', runtimes: ['claude'], detected, netMode: 'tailscale' });
    expect(ts).toContain(`echo '${leasePhaseSentinel('joined-tailnet')}'`);
    // It sits before the install block (the box joined during warmup).
    expect(ts.indexOf(`echo '${leasePhaseSentinel('joined-tailnet')}'`)).toBeLessThan(
      ts.indexOf(`echo '${leasePhaseSentinel('install')}'`),
    );
  });

  it('single-quote-escapes a prompt containing quotes (no argv injection)', () => {
    const script = buildBootstrapScript({
      agent: 'claude',
      prompt: "don't break; rm -rf /",
      runtimes: [],
      detected,
    });
    // The dangerous prompt is fully contained in a single-quoted argument.
    expect(script).toContain("'don'\\''t break; rm -rf /'");
  });

  it('copies the synced checkout into a per-run workspace before launching the agent', () => {
    const script = buildBootstrapScript({
      agent: 'claude',
      prompt: 'work concurrently',
      runtimes: ['claude'],
      detected,
      workspaceId: 'agents-cli-task-a',
    });

    expect(script).toContain('WORKSPACE_DIR="$BOX_HOME"/\'workspaces/agents-cli-task-a\'');
    expect(script).toContain('rsync -a --delete --exclude=node_modules --exclude=.agents/worktrees "$REPO_DIR/" "$WORKSPACE_DIR/"');
    expect(script).toContain('export HOME="$BOX_HOME"/\'lease-homes/agents-cli-task-a\'');
    expect(script).toContain('ln -sfn "$BOX_HOME/.agents/.system" "$HOME/.agents/.system"');
    expect(script.indexOf('cd "$WORKSPACE_DIR"')).toBeLessThan(script.indexOf("agents run 'claude'"));
  });
});

describe('leaseAndRun — refuses a native OAuth copy BEFORE leasing a box (SING-1b, no leak)', () => {
  it('rejects a signed-in native runtime before any crabbox interaction', async () => {
    // credPath is set, so `assertNoNativeOAuthTransfer` at the top of leaseAndRun throws before
    // crabboxFind / crabboxWarmup, so no box is leased. If the refusal lived only in
    // buildBootstrapScript it would reach crabbox and fail differently.
    const signedIn: DetectedRuntime[] = [
      { id: 'claude', label: 'Claude Code', email: 'a@b.com', signedIn: true, credPath: '/tmp/claude-signedin.json' },
    ];
    await expect(
      leaseAndRun({ agent: 'claude', prompt: 'hi', runtimes: ['claude'], detected: signedIn }),
    ).rejects.toThrow(/Refusing to copy native OAuth/i);
  });
});

describe('leaseWorkspaceId', () => {
  it('keeps the repo name readable and separates concurrent process runs', () => {
    expect(leaseWorkspaceId('/src/Agents CLI', 1_800_000_000_000, 41)).toMatch(/^agents-cli-[a-z0-9]+-15$/);
    expect(leaseWorkspaceId('/src/Agents CLI', 1_800_000_000_000, 42)).not.toBe(
      leaseWorkspaceId('/src/Agents CLI', 1_800_000_000_000, 41),
    );
  });
});

// POSIX-only: stands up a `#!/bin/sh` fake crabbox on PATH, which Windows can
// neither resolve nor execute (see crabbox/cli.test.ts for the same pattern).
describe.skipIf(process.platform === 'win32')('leaseAndRun reused crabbox boxes', () => {
  // Hermetic lease-bundle resolution: otherwise leaseAndRun auto-detects the developer's real
  // provider-token bundle and its agentOnly read throws "not unlocked" (SEC-13), a dev-only
  // failure. Pin readMeta to {} and listBundlesSync to [].
  beforeEach(() => {
    resetCrabboxSecretsMemosForTest();
    vi.spyOn(stateModule, 'readMeta').mockReturnValue({} as ReturnType<typeof stateModule.readMeta>);
    vi.spyOn(secretsClient, 'listBundlesSync').mockReturnValue([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetCrabboxSecretsMemosForTest();
  });

  const detected: DetectedRuntime[] = [
    { id: 'claude', label: 'Claude Code', email: 'a@b.com', signedIn: true, credPath: null },
  ];

  function writeFakeCrabbox(tmpDir: string): { log: string; script: string; list: string } {
    const bin = path.join(tmpDir, 'crabbox');
    const log = path.join(tmpDir, 'crabbox.log');
    const script = path.join(tmpDir, 'remote.sh');
    const list = path.join(tmpDir, 'boxes.json');
    fs.writeFileSync(
      list,
      JSON.stringify([
        {
          name: 'crabbox-warm-one',
          status: 'running',
          labels: {
            slug: 'warm-one',
            lease: 'cbx_warmone',
            state: 'ready',
            keep: 'true',
            created_at: '1800000000',
            expires_at: '1800003600',
            last_touched_at: '1800000100',
            idle_timeout_secs: '1800',
          },
          public_net: { ipv4: { ip: '203.0.113.10' } },
        },
      ]),
      'utf-8',
    );
    fs.writeFileSync(
      bin,
      [
        '#!/bin/sh',
        'printf "%s\\n" "$*" >> "$CRABBOX_LOG"',
        'case "$1" in',
        '  --help) exit 0 ;;',
        '  list) cat "$CRABBOX_LIST"; exit 0 ;;',
        '  run) cat > "$CRABBOX_SCRIPT"; printf "%s\\nagent ok\\n" "' + LEASE_AGENT_MARKER + '"; exit 7 ;;',
        '  warmup) echo "unexpected warmup" >&2; exit 55 ;;',
        '  stop) echo "unexpected stop" >&2; exit 66 ;;',
        '  *) echo "unexpected command: $*" >&2; exit 1 ;;',
        'esac',
      ].join('\n'),
      'utf-8',
    );
    fs.chmodSync(bin, 0o755);
    return { log, script, list };
  }

  it('finds an existing warm box, runs the bootstrap script, and never warms or stops it', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-reuse-'));
    const fake = writeFakeCrabbox(tmpDir);
    const oldEnv = {
      PATH: process.env.PATH,
      CRABBOX_LOG: process.env.CRABBOX_LOG,
      CRABBOX_LIST: process.env.CRABBOX_LIST,
      CRABBOX_SCRIPT: process.env.CRABBOX_SCRIPT,
    };
    process.env.PATH = `${tmpDir}${path.delimiter}${oldEnv.PATH ?? ''}`;
    process.env.CRABBOX_LOG = fake.log;
    process.env.CRABBOX_LIST = fake.list;
    process.env.CRABBOX_SCRIPT = fake.script;
    const phases: string[] = [];
    let output = '';

    try {
      const result = await leaseAndRun({
        agent: 'claude',
        prompt: 'reuse the box',
        runtimes: ['claude'],
        detected,
        reuseBox: 'warm-one',
        // Tests box reuse and bootstrap-script generation, not push-from-local copy. Keep it off
        // so leaseAndRun never spawns a real `rsync -e ssh` to the fake TEST-NET address, which
        // would hang on ConnectTimeout in CI.
        copySetup: false,
        onData: (chunk) => { output += chunk; },
        onPhase: (phase) => { phases.push(phase.kind); },
      });

      expect(result.box.slug).toBe('warm-one');
      expect(result.exitCode).toBe(7);
      expect(result.toreDown).toBe(false);
      expect(phases).toEqual(['reuse', 'ready']);
      expect(output).toContain('agent ok');

      const calls = fs.readFileSync(fake.log, 'utf-8').trim().split('\n');
      expect(calls).toContain('list --json');
      expect(calls).toContain('run --id warm-one --reclaim --script-stdin');
      expect(calls.some((line) => line.startsWith('warmup'))).toBe(false);
      expect(calls.some((line) => line.startsWith('stop'))).toBe(false);

      const remoteScript = fs.readFileSync(fake.script, 'utf-8');
      expect(remoteScript).toContain("agents run 'claude' 'reuse the box' --quiet");
    } finally {
      for (const [key, value] of Object.entries(oldEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// POSIX-only fake crabbox, same seam as the reuse suite above.
describe.skipIf(process.platform === 'win32')('leaseAndRun warm profile-pool reuse (reuse-first --lease)', () => {
  const detected: DetectedRuntime[] = [
    { id: 'claude', label: 'Claude Code', email: 'a@b.com', signedIn: true, credPath: null },
  ];

  /** A `crabbox list --json` entry. `profile` undefined → no profile label. */
  function poolBoxJson(
    slug: string,
    over: { profile?: string; tailscale?: boolean; state?: string; expiresAt?: string } = {},
  ) {
    return {
      name: `crabbox-${slug}`,
      status: 'running',
      labels: {
        slug,
        lease: `cbx_${slug.replace(/-/g, '')}`,
        state: over.state ?? 'ready',
        keep: 'true',
        profile: over.profile,
        created_at: '1800000000',
        expires_at: over.expiresAt ?? '1800003600',
        last_touched_at: '1800000100',
        idle_timeout_secs: '1800',
        ...(over.tailscale ? { tailscale_ipv4: '100.64.0.9' } : {}),
      },
      public_net: { ipv4: { ip: '203.0.113.10' } },
    };
  }

  /** A fake crabbox with a pool: `list` serves `boxes` until a `warmup` flips the marker, then
   * `boxes + warmedBoxes`; `status --id` reports ready only for `readySlugs`. Every invocation is
   * logged. */
  function setupPoolFake(opts: {
    boxes: unknown[];
    readySlugs: string[];
    warmedBoxes?: unknown[];
    runExit?: number;
    /** false = the box-side script exits BEFORE the agent marker (a pre-agent bootstrap abort). */
    runEmitsMarker?: boolean;
  }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-pool-'));
    const log = path.join(dir, 'crabbox.log');
    const script = path.join(dir, 'remote.sh');
    const runExit = opts.runExit ?? 7;
    // A real bootstrap abort exits BEFORE echoing LEASE_AGENT_MARKER; a run that
    // reached the agent echoes it first. `runEmitsMarker` picks which the fake models.
    const runBody = opts.runEmitsMarker === false
      ? `printf "bootstrap aborted\\n" >&2; exit ${runExit}`
      : `printf "%s\\nagent ok\\n" "${LEASE_AGENT_MARKER}"; exit ${runExit}`;
    fs.writeFileSync(path.join(dir, 'before.json'), JSON.stringify(opts.boxes), 'utf-8');
    fs.writeFileSync(
      path.join(dir, 'after.json'),
      JSON.stringify([...opts.boxes, ...(opts.warmedBoxes ?? [poolBoxJson('fresh-one')])]),
      'utf-8',
    );
    for (const slug of opts.readySlugs) fs.writeFileSync(path.join(dir, `ready-${slug}`), '', 'utf-8');
    fs.writeFileSync(
      path.join(dir, 'crabbox'),
      [
        '#!/bin/sh',
        'printf "%s\\n" "$*" >> "$CRABBOX_LOG"',
        'case "$1" in',
        '  --help) exit 0 ;;',
        '  list) if [ -f "$CRABBOX_DIR/warmed" ]; then cat "$CRABBOX_DIR/after.json"; else cat "$CRABBOX_DIR/before.json"; fi; exit 0 ;;',
        '  status) if [ -f "$CRABBOX_DIR/ready-$3" ]; then printf "lease x\\nready=true\\n"; else printf "ready=false\\n"; fi; exit 0 ;;',
        '  warmup) touch "$CRABBOX_DIR/warmed"; echo "leased cbx_freshone"; exit 0 ;;',
        `  run) cat > "$CRABBOX_SCRIPT"; ${runBody} ;;`,
        '  stop) exit 0 ;;',
        '  *) echo "unexpected command: $*" >&2; exit 1 ;;',
        'esac',
      ].join('\n'),
      'utf-8',
    );
    fs.chmodSync(path.join(dir, 'crabbox'), 0o755);
    return { dir, log, script };
  }

  async function runWithPool(
    fake: { dir: string; log: string; script: string },
    runOpts: Partial<Parameters<typeof leaseAndRun>[0]> = {},
  ) {
    const oldEnv = {
      PATH: process.env.PATH,
      CRABBOX_LOG: process.env.CRABBOX_LOG,
      CRABBOX_SCRIPT: process.env.CRABBOX_SCRIPT,
      CRABBOX_DIR: process.env.CRABBOX_DIR,
    };
    process.env.PATH = `${fake.dir}${path.delimiter}${oldEnv.PATH ?? ''}`;
    process.env.CRABBOX_LOG = fake.log;
    process.env.CRABBOX_SCRIPT = fake.script;
    process.env.CRABBOX_DIR = fake.dir;
    const phases: string[] = [];
    try {
      const result = await leaseAndRun({
        agent: 'claude',
        prompt: 'pool run',
        runtimes: ['claude'],
        detected,
        profile: 'agents-cli',
        // copy-setup is covered elsewhere; keep it off so no real rsync/ssh spawns.
        copySetup: false,
        onPhase: (phase) => { phases.push(phase.kind); },
        ...runOpts,
      });
      const calls = fs.existsSync(fake.log) ? fs.readFileSync(fake.log, 'utf-8').trim().split('\n') : [];
      return { result, phases, calls };
    } finally {
      for (const [key, value] of Object.entries(oldEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(fake.dir, { recursive: true, force: true });
    }
  }

  it('reuses a ready pool box matching the run profile — and never warms or stops it', async () => {
    const fake = setupPoolFake({ boxes: [poolBoxJson('warm-one', { profile: 'agents-cli' })], readySlugs: ['warm-one'] });
    const { result, phases, calls } = await runWithPool(fake);

    expect(result.box.slug).toBe('warm-one');
    expect(result.exitCode).toBe(7);
    // Teardown is skipped for a pool-reused box (same semantics as --box).
    expect(result.toreDown).toBe(false);
    expect(phases).toEqual(['reuse', 'ready']);
    expect(calls).toContain('list --json');
    expect(calls).toContain('status --id warm-one');
    expect(calls).toContain('run --id warm-one --reclaim --idle-timeout 1800s --script-stdin');
    expect(calls.some((l) => l.startsWith('warmup'))).toBe(false);
    expect(calls.some((l) => l.startsWith('stop'))).toBe(false);
  });

  it('renews with the stable idle window after a prior reuse moved expiresAt', async () => {
    const fake = setupPoolFake({
      boxes: [poolBoxJson('warm-one', { profile: 'agents-cli', expiresAt: '1800007200' })],
      readySlugs: ['warm-one'],
    });
    const { calls } = await runWithPool(fake);

    expect(calls).toContain('run --id warm-one --reclaim --idle-timeout 1800s --script-stdin');
  });

  it('skips a pool box that is not SSH-ready, then warms and keeps a replacement pool box', async () => {
    // status=running but `crabbox status` says ready=false (bootstrap dud) —
    // the sandbox.sh box_ready gate. The dud is left alone, never stopped.
    const fake = setupPoolFake({ boxes: [poolBoxJson('dud-one', { profile: 'agents-cli' })], readySlugs: [] });
    const { result, phases, calls } = await runWithPool(fake);

    expect(result.box.slug).toBe('fresh-one');
    expect(result.toreDown).toBe(false);
    expect(phases).toEqual(['warmup', 'ready']);
    expect(calls).toContain('status --id dud-one');
    expect(calls.some((l) => l.startsWith('warmup'))).toBe(true);
    expect(calls).not.toContain('stop fresh-one');
    expect(calls.some((l) => l.startsWith('stop dud-one'))).toBe(false);
  });

  it('skips a profile-mismatched box and warms fresh', async () => {
    const fake = setupPoolFake({ boxes: [poolBoxJson('other-one', { profile: 'other-repo' })], readySlugs: ['other-one'] });
    const { result, calls } = await runWithPool(fake);

    expect(result.box.slug).toBe('fresh-one');
    expect(calls).not.toContain('status --id other-one'); // filtered before the status gate
    expect(calls.some((l) => l.startsWith('warmup'))).toBe(true);
  });

  it('never hands a tailnet box to a public run (netMode partition)', async () => {
    const fake = setupPoolFake({
      boxes: [poolBoxJson('tailnet-one', { profile: 'agents-cli', tailscale: true })],
      readySlugs: ['tailnet-one'],
    });
    const { result, calls } = await runWithPool(fake); // netMode defaults to public

    expect(result.box.slug).toBe('fresh-one');
    expect(calls).not.toContain('status --id tailnet-one');
    expect(calls.some((l) => l.startsWith('warmup'))).toBe(true);
  });

  it('reuses a tailnet pool box for a tailnet run', async () => {
    const fake = setupPoolFake({
      boxes: [poolBoxJson('tailnet-one', { profile: 'agents-cli', tailscale: true })],
      readySlugs: ['tailnet-one'],
    });
    const { result, phases, calls } = await runWithPool(fake, { netMode: 'tailscale' });

    expect(result.box.slug).toBe('tailnet-one');
    expect(result.toreDown).toBe(false);
    expect(phases).toEqual(['reuse', 'ready']);
    expect(calls.some((l) => l.startsWith('warmup'))).toBe(false);
  });

  it('warms and keeps a pool box when the pool is empty', async () => {
    const fake = setupPoolFake({ boxes: [], readySlugs: [] });
    const { result, phases, calls } = await runWithPool(fake);

    expect(result.box.slug).toBe('fresh-one');
    expect(result.toreDown).toBe(false);
    expect(phases).toEqual(['warmup', 'ready']);
    expect(calls.some((l) => l.startsWith('status'))).toBe(false);
  });

  it('--fresh forces a brand-new box (torn down after) even when a ready pool box exists', async () => {
    const fake = setupPoolFake({ boxes: [poolBoxJson('warm-one', { profile: 'agents-cli' })], readySlugs: ['warm-one'] });
    const { result, phases, calls } = await runWithPool(fake, { fresh: true });

    expect(result.box.slug).toBe('fresh-one');
    expect(result.toreDown).toBe(true);
    expect(phases).toEqual(['warmup', 'ready', 'teardown']);
    expect(calls.some((l) => l.startsWith('status'))).toBe(false); // pool never consulted
    expect(calls).toContain('stop fresh-one');
  });

  it('stops a box THIS run provisioned when its bootstrap failed — even without --fresh or --keep-box', async () => {
    // Empty pool means warmup a fresh box; the box-side bootstrap exits
    // LEASE_BOOTSTRAP_FAILED_CODE before the agent marker. A new unusable box is pure cost, so it
    // is torn down despite a normal (non --fresh) lease.
    const fake = setupPoolFake({ boxes: [], readySlugs: [], runExit: LEASE_BOOTSTRAP_FAILED_CODE, runEmitsMarker: false });
    const { result, phases, calls } = await runWithPool(fake);

    expect(result.box.slug).toBe('fresh-one');
    expect(result.exitCode).toBe(LEASE_BOOTSTRAP_FAILED_CODE);
    expect(result.toreDown).toBe(true);
    expect(phases).toEqual(['warmup', 'ready', 'teardown']);
    expect(calls).toContain('stop fresh-one');
  });

  it('KEEPS a provisioned box when the AGENT (not the bootstrap) exits with the same code', async () => {
    // The agent ran (marker emitted) and merely happened to exit 97 — not a
    // bootstrap abort. Teardown is gated on the marker never being seen, so the
    // box is kept: an arbitrary agent exit code must not destroy a warm box.
    const fake = setupPoolFake({ boxes: [], readySlugs: [], runExit: LEASE_BOOTSTRAP_FAILED_CODE, runEmitsMarker: true });
    const { result, phases, calls } = await runWithPool(fake);

    expect(result.box.slug).toBe('fresh-one');
    expect(result.exitCode).toBe(LEASE_BOOTSTRAP_FAILED_CODE);
    expect(result.toreDown).toBe(false);
    expect(phases).toEqual(['warmup', 'ready']);
    expect(calls.some((l) => l.startsWith('stop'))).toBe(false);
  });

  it('never stops a REUSED box even when its bootstrap aborts', async () => {
    // A reused pool box may be shared by a concurrent run — a failed run on it never
    // tears it down (only a box this run provisioned is auto-stopped on failure).
    const fake = setupPoolFake({
      boxes: [poolBoxJson('warm-one', { profile: 'agents-cli' })],
      readySlugs: ['warm-one'],
      runExit: LEASE_BOOTSTRAP_FAILED_CODE,
      runEmitsMarker: false,
    });
    const { result, phases, calls } = await runWithPool(fake);

    expect(result.box.slug).toBe('warm-one');
    expect(result.exitCode).toBe(LEASE_BOOTSTRAP_FAILED_CODE);
    expect(result.toreDown).toBe(false);
    expect(phases).toEqual(['reuse', 'ready']);
    expect(calls.some((l) => l.startsWith('stop'))).toBe(false);
  });
});

describe('isExpiredPoolStray — the on-lease expired-stray sweep', () => {
  const NOW = 1_800_000_000;
  const strayBox = (over: Partial<CrabboxBox> = {}): CrabboxBox => ({
    name: 'crabbox-x',
    status: 'running',
    slug: 'x',
    lease: 'cbx_x',
    state: 'ready',
    ready: true,
    keep: true,
    createdAt: NOW - 10_000,
    expiresAt: NOW - 100, // expired
    lastTouchedAt: NOW - STRAY_GRACE_SECS - 10, // idle past the grace window
    idleTimeoutSecs: 1800,
    profile: 'default',
    ...over,
  });
  const opts = { profile: 'default', netMode: 'public' as const, keepSlug: 'mine', nowSecs: NOW };

  it('is a stray: expired, idle, same pool, not the box we hold', () => {
    expect(isExpiredPoolStray(strayBox(), opts)).toBe(true);
  });
  it('never the box this run is using', () => {
    expect(isExpiredPoolStray(strayBox({ slug: 'mine' }), opts)).toBe(false);
  });
  it('never an UNEXPIRED box (it is still reusable)', () => {
    expect(isExpiredPoolStray(strayBox({ expiresAt: NOW + 500 }), opts)).toBe(false);
  });
  it('never a box touched within the grace window (a run may hold it)', () => {
    expect(isExpiredPoolStray(strayBox({ lastTouchedAt: NOW - 30 }), opts)).toBe(false);
  });
  it('never a box with unknown last-touched age', () => {
    expect(isExpiredPoolStray(strayBox({ lastTouchedAt: null }), opts)).toBe(false);
  });
  it('never a box in a different profile pool', () => {
    expect(isExpiredPoolStray(strayBox({ profile: 'agents-cli' }), opts)).toBe(false);
  });
  it('never a tailnet box for a public run (partitioned by netMode)', () => {
    expect(isExpiredPoolStray(strayBox({ tailscaleIPv4: '100.1.2.3' }), opts)).toBe(false);
  });
  it('never a non-running box', () => {
    expect(isExpiredPoolStray(strayBox({ status: 'off' }), opts)).toBe(false);
  });
});
