import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveRoutineExecutionContext,
  evaluateRoutineReadiness,
  type ContextFsProbe,
  type ExecutionContextInput,
} from './routine-context.js';

/** Real filesystem probe against a target home — no mocks. */
function realProbe(): ContextFsProbe {
  return {
    exists: (p) => fs.existsSync(p),
    isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    isWritable: (p) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } },
  };
}

describe('resolveRoutineExecutionContext', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-ctx-home-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const inputs = (over: Partial<ExecutionContextInput>): ExecutionContextInput => ({
    name: 'test-routine',
    kind: 'agent',
    mode: 'local',
    targetHome: home,
    probe: realProbe(),
    ...over,
  });

  it('project with a usable base and no cwd resolves the base', () => {
    const projDir = path.join(home, 'src', 'app');
    fs.mkdirSync(projDir, { recursive: true });
    const res = resolveRoutineExecutionContext(inputs({
      project: 'app',
      projectResolution: { defined: true, base: '~/src/app' },
    }));
    expect(res.ready).toBe(true);
    expect(res.resolvedCwd).toBe('~/src/app');
    expect(res.absoluteCwd).toBe(projDir);
  });

  it('project base + relative cwd joins inside the base', () => {
    const sub = path.join(home, 'mono', 'apps', 'api');
    fs.mkdirSync(sub, { recursive: true });
    const res = resolveRoutineExecutionContext(inputs({
      project: 'mono',
      cwd: 'apps/api',
      projectResolution: { defined: true, base: '~/mono' },
    }));
    expect(res.ready).toBe(true);
    expect(res.resolvedCwd).toBe('~/mono/apps/api');
    expect(res.absoluteCwd).toBe(sub);
  });

  it('rejects a project-relative cwd that escapes the base (traversal)', () => {
    const res = resolveRoutineExecutionContext(inputs({
      project: 'mono',
      cwd: '../../etc',
      projectResolution: { defined: true, base: '~/mono' },
    }));
    expect(res.ready).toBe(false);
    expect(res.readiness?.code).toBe('cwd_not_portable');
  });

  it('rootless Linear project + relative cwd anchors at the target home', () => {
    const dir = path.join(home, 'src', 'github.com', 'acme', 'app');
    fs.mkdirSync(dir, { recursive: true });
    const res = resolveRoutineExecutionContext(inputs({
      project: 'acme-app',
      cwd: 'src/github.com/acme/app',
      projectResolution: { defined: true, base: undefined },
    }));
    expect(res.ready).toBe(true);
    expect(res.resolvedCwd).toBe('~/src/github.com/acme/app');
    expect(res.absoluteCwd).toBe(dir);
  });

  it('rootless project with no cwd pauses with project_path_missing', () => {
    const res = resolveRoutineExecutionContext(inputs({
      project: 'acme-app',
      projectResolution: { defined: true, base: undefined },
    }));
    expect(res.ready).toBe(false);
    expect(res.readiness?.code).toBe('project_path_missing');
  });

  it('named-but-undefined project pauses with project_not_found', () => {
    const res = resolveRoutineExecutionContext(inputs({
      project: 'ghost',
      projectResolution: { defined: false },
    }));
    expect(res.ready).toBe(false);
    expect(res.readiness?.code).toBe('project_not_found');
  });

  it('no project + relative cwd anchors at the target home', () => {
    const dir = path.join(home, 'work', 'thing');
    fs.mkdirSync(dir, { recursive: true });
    const res = resolveRoutineExecutionContext(inputs({ cwd: 'work/thing' }));
    expect(res.ready).toBe(true);
    expect(res.resolvedCwd).toBe('~/work/thing');
    expect(res.absoluteCwd).toBe(dir);
  });

  it('~/ cwd resolves against the target home', () => {
    const dir = path.join(home, 'notes');
    fs.mkdirSync(dir, { recursive: true });
    const res = resolveRoutineExecutionContext(inputs({ cwd: '~/notes' }));
    expect(res.ready).toBe(true);
    expect(res.resolvedCwd).toBe('~/notes');
  });

  it('absolute cwd under the target home is normalized to portable ~/ form', () => {
    const dir = path.join(home, 'abs', 'here');
    fs.mkdirSync(dir, { recursive: true });
    const res = resolveRoutineExecutionContext(inputs({ cwd: dir }));
    expect(res.ready).toBe(true);
    expect(res.resolvedCwd).toBe('~/abs/here');
  });

  it('absolute cwd outside home is allowed for a local routine', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-ctx-out-'));
    try {
      const res = resolveRoutineExecutionContext(inputs({ cwd: outside, mode: 'local' }));
      expect(res.ready).toBe(true);
      expect(res.resolvedCwd).toBe(outside);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('absolute cwd outside home is not portable to host/fleet/cloud placement', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-ctx-out-'));
    try {
      const res = resolveRoutineExecutionContext(inputs({ cwd: outside, mode: 'host', probe: undefined }));
      expect(res.ready).toBe(false);
      expect(res.readiness?.code).toBe('cwd_not_portable');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('missing directory pauses with cwd_missing', () => {
    const res = resolveRoutineExecutionContext(inputs({ cwd: 'does/not/exist' }));
    expect(res.ready).toBe(false);
    expect(res.readiness?.code).toBe('cwd_missing');
  });

  it('a file (not directory) pauses with cwd_not_directory', () => {
    fs.writeFileSync(path.join(home, 'afile'), 'x');
    const res = resolveRoutineExecutionContext(inputs({ cwd: 'afile' }));
    expect(res.ready).toBe(false);
    expect(res.readiness?.code).toBe('cwd_not_directory');
  });

  it('an agent routine with neither field pauses with execution_context_missing', () => {
    const res = resolveRoutineExecutionContext(inputs({}));
    expect(res.ready).toBe(false);
    expect(res.readiness?.code).toBe('execution_context_missing');
  });

  it('a command routine with neither field falls back to the target home', () => {
    const res = resolveRoutineExecutionContext(inputs({ kind: 'command' }));
    expect(res.ready).toBe(true);
    expect(res.resolvedCwd).toBe('~');
    expect(res.absoluteCwd).toBe(home);
  });

  it('resolves against a DISTINCT remote target home (deferred existence, no probe)', () => {
    // A remote target whose home differs — resolution roots at the remote home
    // and existence is deferred (no probe reaches the remote filesystem).
    const remoteHome = '/home/remoteuser';
    const res = resolveRoutineExecutionContext({
      name: 'r',
      kind: 'agent',
      mode: 'host',
      targetHome: remoteHome,
      cwd: 'projects/svc',
      probe: undefined,
    });
    expect(res.ready).toBe(true);
    expect(res.resolvedCwd).toBe('~/projects/svc');
    expect(res.absoluteCwd).toBe('/home/remoteuser/projects/svc');
  });

  it('builds the target path with the TARGET machine separator, not this host\'s', () => {
    // The target home belongs to whichever box runs the routine. Joining with the local separator
    // built `\home\remoteuser\...` for a POSIX target when the scheduler ran on Windows, so the
    // separator is inferred from the home itself. Both directions are asserted.
    const posixTarget = resolveRoutineExecutionContext({
      name: 'r', kind: 'agent', mode: 'host',
      targetHome: '/home/remoteuser', cwd: 'projects/svc', probe: undefined,
    });
    expect(posixTarget.absoluteCwd).toBe('/home/remoteuser/projects/svc');

    const windowsTarget = resolveRoutineExecutionContext({
      name: 'r', kind: 'agent', mode: 'host',
      targetHome: 'C:\\Users\\remoteuser', cwd: 'projects/svc', probe: undefined,
    });
    expect(windowsTarget.absoluteCwd).toBe('C:\\Users\\remoteuser\\projects\\svc');
    // The portable form stays POSIX-shaped whatever the target — it is the wire
    // format, not a filesystem path.
    expect(windowsTarget.resolvedCwd).toBe('~/projects/svc');
  });

  it('cloud placement with a bare cwd (no project binding) pauses with cloud_context_unsupported', () => {
    const res = resolveRoutineExecutionContext(inputs({ cwd: 'work', mode: 'cloud', probe: undefined }));
    expect(res.ready).toBe(false);
    expect(res.readiness?.code).toBe('cloud_context_unsupported');
  });

  it('cloud placement with a project binding is allowed', () => {
    const res = resolveRoutineExecutionContext({
      name: 'r',
      kind: 'agent',
      mode: 'cloud',
      targetHome: home,
      project: 'app',
      projectResolution: { defined: true, base: '~/app' },
      probe: undefined,
    });
    expect(res.ready).toBe(true);
  });

  it('an absolute Windows-shaped cwd overrides a project base instead of being misread as project-relative (RUSH-2393)', () => {
    // isBareRelative used `path.isAbsolute` of the HOST: a POSIX daemon dispatching to a Windows
    // target saw `C:\Users\...` as relative, so it was misclassified as project-relative and paused
    // with cwd_not_portable though it is a legitimate absolute override.
    const res = resolveRoutineExecutionContext({
      name: 'r',
      kind: 'agent',
      mode: 'host',
      targetHome: 'C:\\Users\\remoteuser',
      project: 'mono',
      cwd: 'C:\\Users\\remoteuser\\override',
      projectResolution: { defined: true, base: '~/mono' },
      probe: undefined,
    });
    expect(res.readiness?.code).not.toBe('cwd_not_portable');
    expect(res.ready).toBe(true);
    expect(res.resolvedCwd).toBe('~/override');
  });

  it('an absolute POSIX cwd overrides a project base the same way (regression guard, other direction)', () => {
    // Mirrors the Windows-target case above with a POSIX target home, so a fix
    // that swapped the posix/win32 selection (or hardcoded one flavour) would
    // fail this the same way it would have failed the Windows case.
    const res = resolveRoutineExecutionContext({
      name: 'r',
      kind: 'agent',
      mode: 'host',
      targetHome: '/home/remoteuser',
      project: 'mono',
      cwd: '/home/remoteuser/override',
      projectResolution: { defined: true, base: '~/mono' },
      probe: undefined,
    });
    expect(res.readiness?.code).not.toBe('cwd_not_portable');
    expect(res.ready).toBe(true);
    expect(res.resolvedCwd).toBe('~/override');
  });

  it('an unwritable directory pauses with workspace_not_writable', () => {
    if (process.getuid && process.getuid() === 0) return; // root bypasses W_OK
    // Windows ignores the mode bits chmod sets, so W_OK still succeeds and there
    // is no unwritable directory to detect. Same reason as the root guard above:
    // the platform cannot produce the precondition, not that the check is wrong.
    if (process.platform === 'win32') return;
    const dir = path.join(home, 'ro');
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o500);
    try {
      const res = resolveRoutineExecutionContext(inputs({ cwd: 'ro' }));
      expect(res.ready).toBe(false);
      expect(res.readiness?.code).toBe('workspace_not_writable');
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });
});

describe('evaluateRoutineReadiness', () => {
  const ready = { targetHome: '/home/u', resolvedCwd: '~/x', absoluteCwd: '/home/u/x', ready: true } as const;

  it('short-circuits on a context blocker', () => {
    const blocked = { targetHome: '/home/u', ready: false as const, readiness: { code: 'cwd_missing' as const, message: 'x' } };
    const r = evaluateRoutineReadiness(blocked);
    expect(r.ready).toBe(false);
    expect(r.readiness?.code).toBe('cwd_missing');
  });

  it('flags an uninstalled agent', () => {
    const r = evaluateRoutineReadiness(ready, { agentInstalled: () => false }, { agent: 'claude' });
    expect(r.ready).toBe(false);
    expect(r.readiness?.code).toBe('agent_unavailable');
  });

  it('flags an untrusted Codex workspace', () => {
    const r = evaluateRoutineReadiness(ready, { codexTrusted: () => false }, { agent: 'codex' });
    expect(r.ready).toBe(false);
    expect(r.readiness?.code).toBe('codex_workspace_untrusted');
  });

  it('flags a failed live auth check', () => {
    const r = evaluateRoutineReadiness(ready, { authOk: () => ({ ok: false, reason: 'revoked' }) }, { agent: 'claude' });
    expect(r.ready).toBe(false);
    expect(r.readiness?.code).toBe('agent_auth_failed');
  });

  it('flags an unreachable target before harness checks', () => {
    const r = evaluateRoutineReadiness(ready, {
      targetReachable: () => false,
      agentInstalled: () => false,
    });
    expect(r.readiness?.code).toBe('target_unreachable');
  });

  it('passes when every wired probe passes', () => {
    const r = evaluateRoutineReadiness(ready, {
      agentInstalled: () => true,
      codexTrusted: () => true,
      authOk: () => ({ ok: true }),
      targetReachable: () => true,
    });
    expect(r.ready).toBe(true);
  });
});
