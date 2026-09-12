import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { shellQuote, sshExec } from '../ssh-exec.js';
import {
  buildDetachedLaunchCommand,
  buildWindowsDetachedLaunchCommand,
  buildRunForwardedArgs,
  buildInteractiveRunForwardedArgs,
  buildStopRemoteCommand,
  buildWindowsStopRemoteCommand,
  remoteCdPrefix,
  deriveMirroredCwd,
  terminateDispatchedTask,
  withActorEnv,
  remoteRunShellPrelude,
} from './dispatch.js';
import { buildRemoteAgentsInvocation, posixEnvExports } from './remote-cmd.js';
import { resetActorCache, setActorResolvers } from '../actor.js';
import type { HostTask } from './tasks.js';

const LOCAL_HOME = process.env.HOME ?? os.homedir();
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

function runDispatchDiagnostic(debug: boolean): ReturnType<typeof spawnSync> {
  const env = { ...process.env };
  if (debug) env.AGENTS_DISPATCH_DEBUG = '1';
  else delete env.AGENTS_DISPATCH_DEBUG;
  return spawnSync('bun', [
    '-e',
    "import { buildRunForwardedArgs, buildInteractiveRunForwardedArgs } from './cli/src/lib/hosts/dispatch.ts'; " +
      "buildRunForwardedArgs({ agent: 'grok', prompt: '--token=sk-live-prompt', mode: 'auto', " +
      "env: ['API_TOKEN=sk-live-env'], passthroughArgs: ['--api-key', 'sk-live-arg'] }); " +
      "buildInteractiveRunForwardedArgs({ agent: 'grok', prompt: '--token=sk-live-interactive', " +
      "forceInteractive: true });",
  ], { cwd: REPO_ROOT, env, encoding: 'utf8' });
}

describe('dispatch diagnostics', () => {
  it('redacts the headless prompt while retaining the complete forwarded argv', () => {
    const result = runDispatchDiagnostic(true);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('[dispatch:headless] agent=grok');
    expect(result.stderr).toContain(
      '["run","grok","<prompt>","--quiet","--mode","auto","--env","API_TOKEN=<redacted>",' +
        '"--","<passthrough redacted>"]',
    );
    expect(result.stderr).not.toContain('sk-live-prompt');
    expect(result.stderr).not.toContain('sk-live-env');
    expect(result.stderr).not.toContain('sk-live-arg');
    expect(result.stderr).toContain('[dispatch:interactive] agent=grok args=["run","grok","<prompt>","--interactive"]');
    expect(result.stderr).not.toContain('sk-live-interactive');
  });

  it('emits no diagnostic when AGENTS_DISPATCH_DEBUG is unset', () => {
    const result = runDispatchDiagnostic(false);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});

function decodeWindows(command: string): string {
  const encoded = command.match(/-EncodedCommand (\S+)$/)?.[1];
  if (!encoded) throw new Error(`not encoded PowerShell: ${command}`);
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

describe('Windows detached protocol', () => {
  it('starts a hidden process with actor env, cwd, log, and exit sentinel', () => {
    const outer = decodeWindows(buildWindowsDetachedLaunchCommand({
      forwardedArgs: ['run', 'codex', 'hello world', '--mode', 'plan'],
      remoteCwd: 'C:\\src\\repo',
      remoteLog: '$HOME/.agents/.cache/hosts/abc.log',
      remoteExit: '$HOME/.agents/.cache/hosts/abc.exit',
      env: { AGENTS_ACTOR: 'overnight' },
    }));
    expect(outer).toContain('Invoke-CimMethod -ClassName Win32_Process -MethodName Create');
    expect(outer).toContain('Win32_Process.Create failed with code');
    const innerEncoded = outer.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)?.[1];
    expect(innerEncoded).toBeTruthy();
    const inner = Buffer.from(innerEncoded!, 'base64').toString('utf16le');
    expect(inner).toContain("$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'");
    expect(inner).toContain("$env:AGENTS_ACTOR = 'overnight'");
    expect(inner).toContain("Set-Location -LiteralPath 'C:\\src\\repo'");
    expect(inner).toContain("& 'agents' 'run' 'codex' 'hello world' '--mode' 'plan'");
    expect(inner).toContain('Set-Content -LiteralPath $exit -Value $code');
  });

  it('stops by pid without overwriting a completed exit sentinel', () => {
    const script = decodeWindows(buildWindowsStopRemoteCommand(4242, '$HOME/.agents/.cache/hosts/abc.exit'));
    expect(script).toContain('Get-Process -Id 4242');
    expect(script).toContain('Stop-Process -Id 4242 -Force');
    expect(script).toContain('Get-CimInstance Win32_Process');
    expect(script).toContain('foreach ($childId in $descendants)');
    expect(script).toContain('ALREADY $code');
    expect(script).not.toContain('}; elseif');
    expect(script).not.toContain('}; else');
  });
});

describe('buildStopRemoteCommand', () => {
  const exit = '$HOME/.agents/.cache/hosts/abc12345.exit';

  it('rejects non-positive pids before any remote shell is built', () => {
    expect(() => buildStopRemoteCommand(0, exit)).toThrow(/Invalid remote task pid/);
    expect(() => buildStopRemoteCommand(-1, exit)).toThrow(/Invalid remote task pid/);
    expect(() => buildStopRemoteCommand(1.5, exit)).toThrow(/Invalid remote task pid/);
  });

  it('writes 143 only after signaling a live group; keeps the log path untouched', () => {
    const cmd = buildStopRemoteCommand(4242, exit);
    // Live group: TERM then write 143 and report SIGNALED.
    expect(cmd).toContain('kill -TERM -- -4242');
    expect(cmd).toContain(`echo 143 > ${exit}`);
    expect(cmd).toContain('echo SIGNALED');
    // Already-dead group with a real exit code: adopt it, never overwrite.
    expect(cmd).toContain('echo "ALREADY $code"');
    expect(cmd).toContain(`cat ${exit}`);
    // Never deletes the log (contrast terminateRemoteLaunch's rm -f).
    expect(cmd).not.toMatch(/rm\s+-f/);
    expect(cmd).not.toContain('.log');
  });

  it('when the group is gone with no .exit, still writes 143 (GONE) without requiring kill success', () => {
    const cmd = buildStopRemoteCommand(99, exit);
    expect(cmd).toContain('echo GONE');
    // GONE branch is under the final else (group dead).
    expect(cmd).toMatch(/else[\s\S]*echo GONE/);
  });
});

describe('buildRunForwardedArgs', () => {
  it('forwards --session-id for a fresh run so the remote session gets our id', () => {
    const args = buildRunForwardedArgs({ agent: 'claude', prompt: 'do a thing', sessionId: 'abc-123' });
    expect(args).toEqual(['run', 'claude', 'do a thing', '--quiet', '--session-id', 'abc-123']);
  });

  it('forwards --resume (not --session-id) when resuming, so no new session is created', () => {
    const args = buildRunForwardedArgs({ agent: 'claude', prompt: 'keep going', resume: 'abc-123' });
    expect(args).toEqual(['run', 'claude', 'keep going', '--quiet', '--resume', 'abc-123']);
  });

  it('resume wins when both are set — they are mutually exclusive on the CLI', () => {
    const args = buildRunForwardedArgs({ agent: 'claude', prompt: 'p', sessionId: 'new-id', resume: 'old-id' });
    expect(args).toContain('--resume');
    expect(args).toContain('old-id');
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('new-id');
  });

  it('omits session flags entirely for agents with no captured id', () => {
    const args = buildRunForwardedArgs({ agent: 'codex', prompt: 'p' });
    expect(args).toEqual(['run', 'codex', 'p', '--quiet']);
  });

  it('threads mode and model through ahead of the session flag', () => {
    const args = buildRunForwardedArgs({
      agent: 'claude',
      prompt: 'p',
      mode: 'plan',
      model: 'opus',
      sessionId: 'id-1',
    });
    expect(args).toEqual(['run', 'claude', 'p', '--quiet', '--mode', 'plan', '--model', 'opus', '--session-id', 'id-1']);
  });

  it('forwards an explicit version pin as agent@version', () => {
    const args = buildRunForwardedArgs({ agent: 'claude', prompt: 'p', version: '2.1.207' });
    expect(args).toEqual(['run', 'claude@2.1.207', 'p', '--quiet']);
  });

  it('forwards #name on the agent spec so the peer resolves ITS slot (PHNX-3940 T5)', () => {
    const args = buildRunForwardedArgs({ agent: 'claude', prompt: 'p', account: 'work' });
    expect(args[1]).toBe('claude#work');
    expect(args).toContain('--account');
    expect(args).toContain('work');
    const withPin = buildRunForwardedArgs({
      agent: 'claude',
      prompt: 'p',
      version: '2.1.207',
      account: 'work',
    });
    expect(withPin[1]).toBe('claude@2.1.207#work');
  });

  it('forwards an explicit strategy', () => {
    const args = buildRunForwardedArgs({ agent: 'claude', prompt: 'p', strategy: 'balanced' });
    expect(args).toEqual(['run', 'claude', 'p', '--quiet', '--strategy', 'balanced']);
  });

  it('forwards version and strategy together before session flags', () => {
    const args = buildRunForwardedArgs({
      agent: 'claude',
      prompt: 'p',
      version: '2.1.207',
      strategy: 'balanced',
      sessionId: 'id-1',
    });
    expect(args).toEqual([
      'run', 'claude@2.1.207', 'p', '--quiet',
      '--strategy', 'balanced', '--session-id', 'id-1',
    ]);
  });

  it('forwards common behavioral flags', () => {
    const args = buildRunForwardedArgs({
      agent: 'claude',
      prompt: 'p',
      effort: 'high',
      addDir: ['~/notes', '/shared'],
      json: true,
      verbose: true,
      timeout: '30m',
      yes: true,
      acp: true,
    });
    expect(args).toEqual([
      'run', 'claude', 'p', '--quiet',
      '--effort', 'high',
      '--add-dir', '~/notes',
      '--add-dir', '/shared',
      '--timeout', '30m',
      '--json',
      '--verbose',
      '--yes',
      '--acp',
    ]);
  });
});

describe('buildInteractiveRunForwardedArgs', () => {
  it('omits prompt and --quiet so the remote agent starts interactively', () => {
    const args = buildInteractiveRunForwardedArgs({ agent: 'claude' });
    expect(args).toEqual(['run', 'claude']);
  });

  it('forwards --session-id for a fresh interactive run', () => {
    const args = buildInteractiveRunForwardedArgs({ agent: 'claude', sessionId: 'abc-123' });
    expect(args).toEqual(['run', 'claude', '--session-id', 'abc-123']);
  });

  it('forwards --resume (not --session-id) when resuming interactively', () => {
    const args = buildInteractiveRunForwardedArgs({ agent: 'claude', resume: 'abc-123' });
    expect(args).toEqual(['run', 'claude', '--resume', 'abc-123']);
  });

  it('threads mode, model, and name through', () => {
    const args = buildInteractiveRunForwardedArgs({
      agent: 'claude',
      mode: 'plan',
      model: 'opus',
      name: 'my-run',
    });
    expect(args).toEqual(['run', 'claude', '--mode', 'plan', '--model', 'opus', '--name', 'my-run']);
  });

  it('forwards --raw and passthrough args', () => {
    const args = buildInteractiveRunForwardedArgs({
      agent: 'claude',
      raw: true,
      passthroughArgs: ['--verbose', '--some-flag'],
    });
    expect(args).toEqual(['run', 'claude', '--raw', '--', '--verbose', '--some-flag']);
  });

  it('omits empty passthrough args', () => {
    const args = buildInteractiveRunForwardedArgs({ agent: 'claude', passthroughArgs: [] });
    expect(args).toEqual(['run', 'claude']);
  });

  it('forwards a prompt only when interactive mode is forced, plus --interactive flag', () => {
    const args = buildInteractiveRunForwardedArgs({
      agent: 'claude',
      prompt: 'do a thing',
      forceInteractive: true,
    });
    expect(args).toEqual(['run', 'claude', 'do a thing', '--interactive']);
  });

  it('drops the prompt when interactive mode is not forced', () => {
    const args = buildInteractiveRunForwardedArgs({ agent: 'claude', prompt: 'do a thing' });
    expect(args).toEqual(['run', 'claude']);
  });

  it('forwards version and strategy interactively', () => {
    const args = buildInteractiveRunForwardedArgs({
      agent: 'claude',
      version: '2.1.207',
      strategy: 'balanced',
    });
    expect(args).toEqual(['run', 'claude@2.1.207', '--strategy', 'balanced']);
  });

  it('forwards the account picker marker as agent# so the peer lists its own accounts', () => {
    const args = buildInteractiveRunForwardedArgs({
      agent: 'claude',
      accountPicker: true,
      forceInteractive: true,
    });
    expect(args).toEqual(['run', 'claude#', '--interactive']);
  });

  it('rejects an account picker combined with a concrete version pin', () => {
    expect(() => buildInteractiveRunForwardedArgs({
      agent: 'claude',
      version: '2.1.207',
      accountPicker: true,
    })).toThrow('cannot combine an account picker with a version pin');
  });

  it('forwards common behavioral flags interactively', () => {
    const args = buildInteractiveRunForwardedArgs({
      agent: 'claude',
      effort: 'max',
      addDir: ['~/notes'],
      json: true,
      verbose: true,
      timeout: '1h',
      yes: true,
      acp: true,
    });
    expect(args).toEqual([
      'run', 'claude',
      '--effort', 'max',
      '--add-dir', '~/notes',
      '--timeout', '1h',
      '--json',
      '--verbose',
      '--yes',
      '--acp',
    ]);
  });
});

describe('remoteCdPrefix', () => {
  it('returns no prefix when no cwd is given', () => {
    expect(remoteCdPrefix(undefined)).toBe('');
    expect(remoteCdPrefix('')).toBe('');
  });

  it('re-roots a `~/…` path at the REMOTE home via unquoted "$HOME"', () => {
    // The whole point: local `~` mustn't leak the local home to the remote.
    expect(remoteCdPrefix('~/src/github.com/muqsitnawaz/agents-cli')).toBe(
      'cd "$HOME"/src/github.com/muqsitnawaz/agents-cli && ',
    );
  });

  it('re-roots a `$HOME/…` path the same way', () => {
    expect(remoteCdPrefix('$HOME/src/x')).toBe('cd "$HOME"/src/x && ');
  });

  it('does NOT re-root a raw local-home absolute — only ~/$HOME anchor here (exec.ts makes --cwd portable)', () => {
    const p = `${LOCAL_HOME}/src/x`;
    expect(remoteCdPrefix(p)).toBe(`cd ${shellQuote(p)} && `);
  });

  it('maps bare ~ / $HOME to "$HOME"', () => {
    expect(remoteCdPrefix('~')).toBe('cd "$HOME" && ');
    expect(remoteCdPrefix('$HOME')).toBe('cd "$HOME" && ');
  });

  it('quotes a non-home absolute path verbatim (used as-is on the host)', () => {
    expect(remoteCdPrefix('/opt/work')).toBe("cd /opt/work && ");
    expect(remoteCdPrefix('/data/a b')).toBe("cd '/data/a b' && ");
  });

  it('shell-quotes a home remainder containing spaces', () => {
    expect(remoteCdPrefix('~/my projects/repo')).toBe(`cd "$HOME"/'my projects/repo' && `);
  });

  it('falls back to the remote home for a MIRRORED dir the host may not have', () => {
    // A derived cwd is a best-effort mirror of the local checkout, so a host
    // without that directory must still start the agent (in $HOME) rather than
    // die on `cd`.
    expect(remoteCdPrefix('~/src/x', { mirror: true })).toBe(
      '{ cd "$HOME"/src/x || cd "$HOME"; } && ',
    );
  });

  it('does NOT add the fallback for an explicit cwd — a missing one must fail loudly', () => {
    expect(remoteCdPrefix('~/src/x', { mirror: false })).toBe('cd "$HOME"/src/x && ');
    expect(remoteCdPrefix('~/src/x')).toBe('cd "$HOME"/src/x && ');
  });
});

describe('deriveMirroredCwd', () => {
  it('maps a cwd under the local home to its home-relative remote analogue', () => {
    expect(deriveMirroredCwd(`${LOCAL_HOME}/src/github.com/muqsitnawaz/agents-cli`)).toBe(
      '~/src/github.com/muqsitnawaz/agents-cli',
    );
  });

  it('mirrors the home itself', () => {
    expect(deriveMirroredCwd(LOCAL_HOME)).toBe('~');
  });

  it('declines a path outside the home — it says nothing about the remote filesystem', () => {
    expect(deriveMirroredCwd('/opt/work')).toBeUndefined();
    expect(deriveMirroredCwd('/var/tmp/scratch')).toBeUndefined();
  });

  it('round-trips into a cd prefix that resolves against the REMOTE home', () => {
    const derived = deriveMirroredCwd(`${LOCAL_HOME}/src/x`);
    expect(remoteCdPrefix(derived, { mirror: true })).toBe(
      '{ cd "$HOME"/src/x || cd "$HOME"; } && ',
    );
    // The local home must never appear in what we send over the wire.
    expect(remoteCdPrefix(derived, { mirror: true })).not.toContain(LOCAL_HOME);
  });
});

// The prefix is only ever consumed by a remote POSIX shell, so run it through a
// real one against a real directory tree — that is what proves the mirror lands
// in the project and the fallback lands in the home.
//
// The shell it runs through here is the LOCAL one, which is only a valid stand-in
// for the remote where the local shell is POSIX. On Windows there is no bash to
// spawn, so `spawnSync` returns a null status and the `pwd` output is empty —
// the two positive cases fail on the harness rather than on the behavior, and the
// negative case ("must exit non-zero") passes for the wrong reason. The prefix
// itself is correct on a Windows client: it targets a remote POSIX shell either
// way. Assert it there via the pure string expectations above, and run the
// real-shell block only where a real POSIX shell exists.
describe.skipIf(process.platform === 'win32')('remoteCdPrefix executed by a real shell', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-cwd-'));
  const present = 'src/github.com/acme/repo';
  fs.mkdirSync(path.join(tmpHome, present), { recursive: true });

  const pwdUnder = (prefix: string): { stdout: string; status: number | null } => {
    const r = spawnSync('bash', ['-c', `${prefix}pwd`], {
      env: { ...process.env, HOME: tmpHome },
      cwd: os.tmpdir(),
      encoding: 'utf8',
    });
    return { stdout: r.stdout.trim(), status: r.status };
  };

  afterAll(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  it('lands in the mirrored project when the host has that checkout', () => {
    const prefix = remoteCdPrefix(deriveMirroredCwd(`/somewhere/else/${present}`) ?? `~/${present}`, { mirror: true });
    const { stdout, status } = pwdUnder(`cd "$HOME" && ${prefix}`);
    expect(status).toBe(0);
    expect(fs.realpathSync(stdout)).toBe(fs.realpathSync(path.join(tmpHome, present)));
  });

  it('falls back to the remote home when the host lacks that checkout', () => {
    const { stdout, status } = pwdUnder(remoteCdPrefix('~/src/not/here', { mirror: true }));
    expect(status).toBe(0);
    expect(fs.realpathSync(stdout)).toBe(fs.realpathSync(tmpHome));
  });

  it('fails the command outright when an EXPLICIT cwd is missing', () => {
    // No mirror flag: the user named this directory, so a typo must not be
    // silently swallowed into $HOME.
    const { status } = pwdUnder(remoteCdPrefix('~/src/not/here'));
    expect(status).not.toBe(0);
  });
});

const remoteTarget = process.env.AGENTS_TEST_REMOTE_TARGET;

describe.skipIf(!remoteTarget)('terminateDispatchedTask — real remote process', () => {
  it('terminates the production wrapper and a TERM-resistant child before returning', () => {
    const id = randomUUID().slice(0, 8);
    const marker = `agents-dispatch-rollback-${id}`;
    const remoteLog = `/tmp/${marker}.log`;
    const remoteExit = `/tmp/${marker}.exit`;
    const childPidPath = `/tmp/${marker}.child-pid`;
    const childCommand = `echo $$ > ${childPidPath}; trap '' TERM; exec -a ${marker}-child sleep 30`;
    const inner =
      `trap 'exit 0' TERM; ` +
      `bash -lc ${shellQuote(childCommand)} > ${remoteLog} 2>&1; ` +
      `echo $? > ${remoteExit}`;
    const launch = sshExec(
      remoteTarget!,
      `rm -f ${remoteLog} ${remoteExit} ${childPidPath}; ${buildDetachedLaunchCommand(inner)}`,
      { timeoutMs: 10000, multiplex: true },
    );
    expect(launch.code).toBe(0);
    const pid = Number.parseInt(launch.stdout.trim().split('\n').pop() ?? '', 10);
    expect(Number.isFinite(pid)).toBe(true);

    const identity = sshExec(
      remoteTarget!,
      `for i in 1 2 3 4 5 6 7 8 9 10; do ` +
        `child=$(cat ${childPidPath} 2>/dev/null || true); ` +
        `if test -n "$child"; then ` +
          `pgid=$(ps -o pgid= -p ${pid} | tr -d ' '); ` +
          `printf '%s %s\n' "$child" "$pgid"; exit 0; ` +
        `fi; sleep 0.1; ` +
      `done; exit 1`,
      { timeoutMs: 10000, multiplex: true },
    );
    expect(identity.code).toBe(0);
    const [childPidText, groupIdText] = identity.stdout.trim().split(/\s+/);
    const childPid = Number.parseInt(childPidText ?? '', 10);
    expect(Number.isFinite(childPid)).toBe(true);
    expect(Number.parseInt(groupIdText ?? '', 10)).toBe(pid);

    const task: HostTask = {
      id,
      host: remoteTarget!,
      target: remoteTarget!,
      agent: 'test',
      prompt: marker,
      pid,
      remoteLog,
      remoteExit,
      status: 'running',
      createdAt: new Date().toISOString(),
    };

    try {
      terminateDispatchedTask(task);
      const probe = sshExec(
        remoteTarget!,
        `for process in ${pid} ${childPid}; do ` +
          `if kill -0 "$process" 2>/dev/null; then echo "ALIVE:$process"; exit 1; fi; ` +
        `done; echo DEAD`,
        { timeoutMs: 10000, multiplex: true },
      );
      expect(probe.code).toBe(0);
      expect(probe.stdout.trim()).toBe('DEAD');
    } finally {
      sshExec(
        remoteTarget!,
        `kill -KILL -- -${pid} 2>/dev/null || true; ` +
          `kill -KILL ${pid} ${childPid} 2>/dev/null || true; ` +
          `rm -f ${remoteLog} ${remoteExit} ${childPidPath}`,
        { timeoutMs: 10000, multiplex: true },
      );
    }
  });
});

describe('withActorEnv — forward actor provenance across the SSH hop (RUSH-2028)', () => {
  const SAVE = { ...process.env };
  const ACTOR_KEYS = [
    'AGENTS_ACTOR', 'AGENTS_ACTOR_KIND', 'AGENTS_ACTOR_NAME',
    'AGENTS_ACTOR_EMAIL', 'AGENTS_ACTOR_GITHUB', 'SSH_CONNECTION',
  ];
  // Force an INHERITED actor so resolveActor() is deterministic (computeActor
  // reads AGENTS_ACTOR straight from the env — no tailscale shell-out).
  function setActor(env: Record<string, string>): void {
    for (const k of ACTOR_KEYS) delete process.env[k];
    Object.assign(process.env, env);
    resetActorCache();
  }
  // Pin the tailscale resolvers to "names no one" for every test in this block,
  // so an UNRESOLVED case is genuinely unresolvable regardless of whether the box
  // running the suite is on the tailnet. Without this the local-run self-credit
  // (`tailscaleSelf`) returns the CI/dev box's own tailnet owner and the
  // UNRESOLVED assertion below sees that ambient account instead. The
  // inherited-actor tests short-circuit before any resolver, so this doesn't
  // change their behavior.
  beforeEach(() => {
    setActorResolvers({ whois: () => undefined, self: () => undefined, session: () => null });
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in SAVE)) delete process.env[k];
    Object.assign(process.env, SAVE);
    setActorResolvers(undefined);
    resetActorCache();
  });

  it('carries AGENTS_ACTOR + GIT_AUTHOR_*/GIT_COMMITTER_* into the remote command when a human resolves', () => {
    setActor({
      AGENTS_ACTOR: 'muqsit@example.com',
      AGENTS_ACTOR_KIND: 'human',
      AGENTS_ACTOR_NAME: 'Muqsit',
      AGENTS_ACTOR_EMAIL: 'muqsit@example.com',
    });
    const env = withActorEnv();
    expect(env.AGENTS_ACTOR).toBe('muqsit@example.com');
    expect(env.GIT_AUTHOR_NAME).toBe('Muqsit');
    expect(env.GIT_AUTHOR_EMAIL).toBe('muqsit@example.com');
    expect(env.GIT_COMMITTER_NAME).toBe('Muqsit');
    expect(env.GIT_COMMITTER_EMAIL).toBe('muqsit@example.com');

    // ...and they land in the actual remote command string maybeRunOnHost ships.
    const cmd = buildRemoteAgentsInvocation(['view', 'claude'], undefined, undefined, env);
    // Values are rendered as shell literals (unquoted when safe), NOT an
    // expanding double-quote context — see the posixEnvExports injection tests in
    // remote-cmd.test.ts for why (untrusted actor names must not run as shell).
    expect(cmd).toContain('export AGENTS_ACTOR=muqsit@example.com');
    expect(cmd).toContain('export GIT_AUTHOR_EMAIL=muqsit@example.com');
    expect(cmd).toContain('export GIT_COMMITTER_NAME=Muqsit');
    // The detached (run/teams) + interactive dispatch builders export via the
    // same helper, so this prefix is exactly what they prepend too.
    expect(posixEnvExports(env)).toContain('export AGENTS_ACTOR=muqsit@example.com');
  });

  it('forwards the launching tab AGENT_TERMINAL_ID so the remote registry can be joined back to it', () => {
    setActor({ AGENTS_ACTOR: 'muqsit@example.com', AGENTS_ACTOR_KIND: 'human' });
    process.env.AGENT_TERMINAL_ID = 'cl-1785738033788-17';
    const env = withActorEnv();
    expect(env.AGENT_TERMINAL_ID).toBe('cl-1785738033788-17');
    // It has to survive into the command the dispatch builders actually ship —
    // an env that stops at the local process leaves the device's session feed
    // with no way to say which session belongs to this tab.
    const cmd = buildRemoteAgentsInvocation(['run', 'claude', '--interactive'], undefined, undefined, env);
    expect(cmd).toContain('export AGENT_TERMINAL_ID=cl-1785738033788-17');
  });

  it('omits AGENT_TERMINAL_ID entirely when the launch came from no tracked terminal', () => {
    setActor({ AGENTS_ACTOR: 'muqsit@example.com', AGENTS_ACTOR_KIND: 'human' });
    delete process.env.AGENT_TERMINAL_ID;
    expect('AGENT_TERMINAL_ID' in withActorEnv()).toBe(false);
    // A whitespace-only value is not a terminal id either — forwarding it would
    // put an empty join key in the remote registry.
    process.env.AGENT_TERMINAL_ID = '   ';
    expect('AGENT_TERMINAL_ID' in withActorEnv()).toBe(false);
  });

  it('merges the actor UNDER a caller env — the caller value wins, the doctor PATH coexists', () => {
    setActor({ AGENTS_ACTOR: 'muqsit@example.com', AGENTS_ACTOR_KIND: 'human' });
    const env = withActorEnv({
      PATH: '$HOME/.agents/.cache/shims:$PATH',
      AGENTS_ACTOR: 'override@example.com',
    });
    expect(env.AGENTS_ACTOR).toBe('override@example.com'); // caller wins (mirrors exec.ts precedence)
    expect(env.PATH).toBe('$HOME/.agents/.cache/shims:$PATH');
  });

  it('two DIFFERENT origin actors forward two DIFFERENT identities (RUSH-2017 acceptance gap)', () => {
    setActor({
      AGENTS_ACTOR: 'alice@example.com', AGENTS_ACTOR_KIND: 'human',
      AGENTS_ACTOR_NAME: 'Alice', AGENTS_ACTOR_EMAIL: 'alice@example.com',
    });
    const a = buildRemoteAgentsInvocation(['run', 'claude', 'hi', '--quiet'], undefined, undefined, withActorEnv());

    setActor({
      AGENTS_ACTOR: 'bob@example.com', AGENTS_ACTOR_KIND: 'human',
      AGENTS_ACTOR_NAME: 'Bob', AGENTS_ACTOR_EMAIL: 'bob@example.com',
    });
    const b = buildRemoteAgentsInvocation(['run', 'claude', 'hi', '--quiet'], undefined, undefined, withActorEnv());

    expect(a).toContain('export AGENTS_ACTOR=alice@example.com');
    expect(a).toContain('export GIT_AUTHOR_NAME=Alice');
    expect(b).toContain('export AGENTS_ACTOR=bob@example.com');
    expect(b).toContain('export GIT_AUTHOR_NAME=Bob');
    expect(a).not.toBe(b);
    expect(a).not.toContain('bob@example.com');
    expect(b).not.toContain('alice@example.com');
  });

  it('an UNRESOLVED origin stamps its own id — never leaves the remote to re-resolve from SSH_CONNECTION', () => {
    setActor({}); // no inherited actor, no SSH_CONNECTION -> UNRESOLVED@<host>
    const env = withActorEnv();
    expect(env.AGENTS_ACTOR).toMatch(/^UNRESOLVED@/);
    expect(env.GIT_AUTHOR_NAME).toBeUndefined();
    const cmd = buildRemoteAgentsInvocation(['view'], undefined, undefined, env);
    expect(cmd).toContain('export AGENTS_ACTOR=UNRESOLVED@');
  });
});

describe('remoteRunShellPrelude — the run-auto chain-hop guard crosses the SSH boundary (RUSH-2132)', () => {
  it('exports the guard into the remote SHELL env for a `run auto` dispatch — and the remote shell really sees it', () => {
    // Both dispatch paths (runInteractiveOnHost + launchDetached) build their
    // remote command with this prelude, so asserting on it exercises the real
    // boundary. The guard MUST land in the remote CLI's own process.env (read
    // by runAutoDefaultsToAffinity): a forwarded `--env` flag only reaches the
    // spawned agent, which was the review finding this guards.
    const prelude = remoteRunShellPrelude('auto');
    expect(prelude).toContain('export AGENTS_RUN_AUTO_HOST_RESOLVED=1');
    const out = spawnSync('bash', ['-lc', `${prelude}printf %s "$AGENTS_RUN_AUTO_HOST_RESOLVED"`], { encoding: 'utf-8' });
    expect(out.stdout).toBe('1');
  });

  it('does not arm the guard for a named-harness dispatch (its remote never affinity-picks)', () => {
    expect(remoteRunShellPrelude('claude')).not.toContain('AGENTS_RUN_AUTO_HOST_RESOLVED');
    const out = spawnSync('bash', ['-lc', `${remoteRunShellPrelude('claude')}printf %s "$AGENTS_RUN_AUTO_HOST_RESOLVED"`], { encoding: 'utf-8' });
    expect(out.stdout).toBe('');
  });

  it('the guard is NOT forwarded as an --env flag by either argv builder (that channel only reaches the spawned agent)', () => {
    expect(buildRunForwardedArgs({ agent: 'auto', prompt: 'x' }).join(' ')).not.toContain('AGENTS_RUN_AUTO_HOST_RESOLVED');
    expect(buildInteractiveRunForwardedArgs({ agent: 'auto' }).join(' ')).not.toContain('AGENTS_RUN_AUTO_HOST_RESOLVED');
  });

  // RUSH-3125 / PHNX-3316. The interactive dispatch hands the remote agent a
  // TTY that IS an ssh link, so the remote CLI has to know the run arrived
  // over the network — resolveTmuxWrap reads it for the --no-follow pane
  // requirement, and reconnect.ts keys the drop-recovery off it. Like the
  // run-auto guard, this MUST be a shell export: resolveTmuxWrap reads the
  // remote CLI's own process.env, which a forwarded `--env` never reaches.
  it('exports the remote-interactive marker when asked, and the remote shell really sees it', () => {
    const prelude = remoteRunShellPrelude('claude', { AGENTS_REMOTE_INTERACTIVE: '1' });
    expect(prelude).toContain('export AGENTS_REMOTE_INTERACTIVE=1');
    const out = spawnSync('bash', ['-lc', `${prelude}printf %s "$AGENTS_REMOTE_INTERACTIVE"`], { encoding: 'utf-8' });
    expect(out.stdout).toBe('1');
  });

  it('leaves the marker unset by default, so a headless dispatch never claims to be interactive', () => {
    // launchDetached calls the prelude with no extras: its run is already
    // setsid-detached, so forcing the tmux wrap there would be pure overhead.
    expect(remoteRunShellPrelude('claude')).not.toContain('AGENTS_REMOTE_INTERACTIVE');
    const out = spawnSync('bash', ['-lc', `${remoteRunShellPrelude('claude')}printf %s "$AGENTS_REMOTE_INTERACTIVE"`], { encoding: 'utf-8' });
    expect(out.stdout).toBe('');
  });

  it('the marker is NOT forwarded as an --env flag by either argv builder (that channel only reaches the spawned agent)', () => {
    expect(buildRunForwardedArgs({ agent: 'claude', prompt: 'x' }).join(' ')).not.toContain('AGENTS_REMOTE_INTERACTIVE');
    expect(buildInteractiveRunForwardedArgs({ agent: 'claude' }).join(' ')).not.toContain('AGENTS_REMOTE_INTERACTIVE');
  });

  it('carries the marker and the run-auto guard together', () => {
    const prelude = remoteRunShellPrelude('auto', { AGENTS_REMOTE_INTERACTIVE: '1' });
    const out = spawnSync('bash', ['-lc', `${prelude}printf '%s,%s' "$AGENTS_RUN_AUTO_HOST_RESOLVED" "$AGENTS_REMOTE_INTERACTIVE"`], { encoding: 'utf-8' });
    expect(out.stdout).toBe('1,1');
  });

  it('keeps the actor provenance exports alongside the guard', () => {
    const savedActor = process.env.AGENTS_ACTOR;
    const savedKind = process.env.AGENTS_ACTOR_KIND;
    process.env.AGENTS_ACTOR = 'muqsit@example.com';
    process.env.AGENTS_ACTOR_KIND = 'human';
    resetActorCache();
    try {
      const prelude = remoteRunShellPrelude('auto');
      expect(prelude).toContain('export AGENTS_ACTOR=muqsit@example.com');
      expect(prelude).toContain('export AGENTS_RUN_AUTO_HOST_RESOLVED=1');
    } finally {
      if (savedActor === undefined) delete process.env.AGENTS_ACTOR; else process.env.AGENTS_ACTOR = savedActor;
      if (savedKind === undefined) delete process.env.AGENTS_ACTOR_KIND; else process.env.AGENTS_ACTOR_KIND = savedKind;
      resetActorCache();
    }
  });
});
