import { describe, expect, it } from 'vitest';
import {
  buildBashActions,
  buildSessionDetailV2,
  mapBashCategory,
  unwrapShellExec,
} from './schema2-build.js';
import { buildTrajectory } from '@phnx-labs/sessions-cli/reader';
import type { SessionEvent, SessionMeta } from '@phnx-labs/sessions-cli/reader';
import type {
  BashExecution,
  EditExecution,
  GrepExecution,
  HookExecution,
  ReadExecution,
  WriteExecution,
} from './schema2.js';

const T0 = '2026-08-30T00:00:00.000Z';
function ts(sec: number): string {
  return new Date(Date.parse(T0) + sec * 1000).toISOString();
}

const META: SessionMeta = {
  id: 'sess-1',
  shortId: 'sess1',
  agent: 'claude',
  timestamp: T0,
  filePath: '/x/sess.jsonl',
  project: 'agents',
  model: 'opus-4-8',
};

function detail(events: SessionEvent[]) {
  const traj = buildTrajectory(events, META, { redact: false });
  return { traj, v2: buildSessionDetailV2(traj, events, { redact: false }) };
}

describe('unwrapShellExec', () => {
  it('peels /bin/zsh -lc "…" and then applies the existing unwrapper', () => {
    expect(unwrapShellExec(`/bin/zsh -lc 'cd /repo && bun test'`)).toBe('bun test');
    expect(unwrapShellExec(`bash -lc "git status"`)).toBe('git status');
    expect(unwrapShellExec(`sh -c 'ls -la'`)).toBe('ls -la');
  });
  it('leaves a bare command untouched (delegates to unwrapCommand)', () => {
    expect(unwrapShellExec('git status')).toBe('git status');
    expect(unwrapShellExec('VAR=1 git push')).toBe('git push');
  });
});

describe('mapBashCategory', () => {
  it('maps vcs→git, remote/http→network, else→other', () => {
    expect(mapBashCategory('vcs', ['git', 'status'])).toBe('git');
    expect(mapBashCategory('remote', ['ssh', 'host'])).toBe('network');
    expect(mapBashCategory('http', ['curl', 'x'])).toBe('network');
    expect(mapBashCategory('shell', ['rm', 'x'])).toBe('other');
    expect(mapBashCategory('probe', ['ls'])).toBe('other');
  });
  it('splits build-test into test vs build by argv', () => {
    expect(mapBashCategory('build-test', ['bun', 'test'])).toBe('test');
    expect(mapBashCategory('build-test', ['vitest', 'run'])).toBe('test');
    expect(mapBashCategory('build-test', ['bun', 'build'])).toBe('build');
    expect(mapBashCategory('build-test', ['go', 'build'])).toBe('build');
  });
});

describe('buildBashActions', () => {
  it('emits one action per segment with argv, program, categories, danger', () => {
    const actions = buildBashActions('bun test && git status');
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({
      ordinal: 1, source: 'bun test', argv: ['bun', 'test'], program: 'bun',
      categories: ['test'], danger: 'normal', argvComplete: true,
    });
    expect(actions[1]).toMatchObject({
      ordinal: 2, argv: ['git', 'status'], program: 'git', categories: ['git'],
    });
  });

  it('flags a destructive segment with its operation label', () => {
    const actions = buildBashActions('rm -rf dist');
    expect(actions[0].danger).toBe('DESTRUCTIVE');
    expect(actions[0].destructiveOperation).toBe('recursive-force-delete');
  });

  it('marks argvComplete false for a command-substitution segment', () => {
    const actions = buildBashActions('echo $(date)');
    expect(actions[0].argvComplete).toBe(false);
  });

  it('marks argvComplete false for a bare variable expansion', () => {
    const actions = buildBashActions('cat $FILE');
    expect(actions[0].argvComplete).toBe(false);
  });
});

// ── per-tool mappers via buildSessionDetailV2 ────────────────────────────────

function useEvent(partial: Partial<SessionEvent> & { tool: string; callId: string }, sec: number): SessionEvent {
  return { type: 'tool_use', agent: 'claude', timestamp: ts(sec), ...partial } as SessionEvent;
}
function resultEvent(callId: string, sec: number, extra: Partial<SessionEvent> = {}): SessionEvent {
  return { type: 'tool_result', agent: 'claude', timestamp: ts(sec), callId, outcome: 'ok', success: true, ...extra } as SessionEvent;
}

describe('buildSessionDetailV2 — bash mapper', () => {
  it('produces a BashExecution with command, unwrappedCommand, actions, result', () => {
    const events: SessionEvent[] = [
      useEvent({ tool: 'Bash', callId: 'c1', command: `/bin/zsh -lc 'bun test && git status'`, args: { command: `/bin/zsh -lc 'bun test && git status'` } }, 0),
      resultEvent('c1', 5, { exitCode: 0, output: '42 pass 0 fail' }),
    ];
    const { v2 } = detail(events);
    const step = v2.steps[0] as BashExecution;
    expect(step.executionType).toBe('bash');
    expect(step.unwrappedCommand).toBe('bun test && git status');
    expect(step.actions.map((a) => a.program)).toEqual(['bun', 'git']);
    expect(step.result.exitCode).toBe(0);
    expect(step.result.combined?.text).toBe('42 pass 0 fail');
    expect(step.parseStatus).toBe('parsed');
  });
});

describe('buildSessionDetailV2 — read mapper', () => {
  it('captures file/offset/limit and returnedLines exact', () => {
    const events: SessionEvent[] = [
      useEvent({ tool: 'Read', callId: 'r1', args: { file_path: '/repo/a.ts', offset: 10, limit: 200 } }, 0),
      resultEvent('r1', 1, { output: 'line1\nline2\nline3' }),
    ];
    const step = detail(events).v2.steps[0] as ReadExecution;
    expect(step.executionType).toBe('read');
    expect(step.file).toBe('/repo/a.ts');
    expect(step.offset).toBe(10);
    expect(step.limit).toBe(200);
    expect(step.returnedLines).toEqual({ value: 3, relation: 'exact' });
  });
});

describe('buildSessionDetailV2 — grep mapper', () => {
  it('captures query/path/glob/outputMode/hits', () => {
    const events: SessionEvent[] = [
      useEvent({ tool: 'Grep', callId: 'g1', args: { pattern: 'foo', path: 'src', glob: '*.ts', output_mode: 'files' } }, 0),
      resultEvent('g1', 1, { output: 'a.ts\nb.ts' }),
    ];
    const step = detail(events).v2.steps[0] as GrepExecution;
    expect(step.executionType).toBe('grep');
    expect(step.query).toBe('foo');
    expect(step.path).toBe('src');
    expect(step.glob).toBe('*.ts');
    expect(step.outputMode).toBe('files');
    expect(step.hits).toEqual({ value: 2, relation: 'exact' });
  });
});

describe('buildSessionDetailV2 — generic mapper', () => {
  it('maps any other tool to GenericToolExecution with an input preview', () => {
    const events: SessionEvent[] = [
      useEvent({ tool: 'WebFetch', callId: 'w1', args: { url: 'https://example.com/docs' } }, 0),
      resultEvent('w1', 1, { output: 'ok' }),
    ];
    const step = detail(events).v2.steps[0] as any;
    expect(step.executionType).toBe('generic');
    expect(step.input.text).toBe('https://example.com/docs');
  });
});

describe('buildSessionDetailV2 — edit/write mappers + file hunks', () => {
  it('builds a FileMutation with added/removed line counts and hashes', () => {
    const events: SessionEvent[] = [
      useEvent({ tool: 'Edit', callId: 'e1', args: { file_path: '/repo/f.ts', old_string: 'a\nb\nc', new_string: 'a' } }, 0),
      resultEvent('e1', 1),
    ];
    const step = detail(events).v2.steps[0] as EditExecution;
    expect(step.executionType).toBe('edit');
    expect(step.files[0].path).toBe('/repo/f.ts');
    expect(step.files[0].hunks[0].removedLines).toBe(3);
    expect(step.files[0].hunks[0].addedLines).toBe(1);
    expect(step.files[0].hunks[0].beforeHash).toBeDefined();
    expect(step.files[0].hunks[0].afterHash).toBeDefined();
  });

  it('builds a Write overwrite mutation', () => {
    const events: SessionEvent[] = [
      useEvent({ tool: 'Write', callId: 'wr1', args: { file_path: '/repo/n.ts', content: 'x\ny' } }, 0),
      resultEvent('wr1', 1),
    ];
    const step = detail(events).v2.steps[0] as WriteExecution;
    expect(step.executionType).toBe('write');
    expect(step.files[0].operation).toBe('overwrite');
    expect(step.files[0].hunks[0].addedLines).toBe(2);
    expect(step.files[0].hunks[0].removedLines).toBe(0);
  });
});

describe('buildSessionDetailV2 — cross-step revert ledger', () => {
  it('links a later edit that exactly reverts an earlier one on the same path', () => {
    const events: SessionEvent[] = [
      useEvent({ tool: 'Edit', callId: 'e1', args: { file_path: '/repo/f.ts', old_string: 'OLD', new_string: 'NEW' } }, 0),
      resultEvent('e1', 1),
      useEvent({ tool: 'Edit', callId: 'e2', args: { file_path: '/repo/f.ts', old_string: 'NEW', new_string: 'OLD' } }, 2),
      resultEvent('e2', 3),
    ];
    const { v2 } = detail(events);
    const first = v2.steps[0] as EditExecution;
    const second = v2.steps[1] as EditExecution;
    expect(first.files[0].hunks[0].revertedByStep).toBe(second.ordinal);
    expect(first.files[0].revertedByStep).toBe(second.ordinal);
    expect(second.reverts).toEqual([
      { revertedStep: first.ordinal, path: '/repo/f.ts', revertedHunkIds: ['h1'] },
    ]);
  });

  it('does NOT link a non-exact partial change (no faked reverts)', () => {
    const events: SessionEvent[] = [
      useEvent({ tool: 'Edit', callId: 'e1', args: { file_path: '/repo/f.ts', old_string: 'OLD', new_string: 'NEW' } }, 0),
      resultEvent('e1', 1),
      useEvent({ tool: 'Edit', callId: 'e2', args: { file_path: '/repo/f.ts', old_string: 'NEW', new_string: 'DIFFERENT' } }, 2),
      resultEvent('e2', 3),
    ];
    const { v2 } = detail(events);
    const first = v2.steps[0] as EditExecution;
    const second = v2.steps[1] as EditExecution;
    expect(first.files[0].hunks[0].revertedByStep).toBeUndefined();
    expect(second.reverts).toEqual([]);
  });
});

describe('buildSessionDetailV2 — thinking + hook + shape', () => {
  it('maps a thinking event to a ThinkingStep', () => {
    const events: SessionEvent[] = [
      { type: 'thinking', agent: 'claude', timestamp: ts(0), content: 'plan it' } as SessionEvent,
      useEvent({ tool: 'Bash', callId: 'c1', command: 'ls', args: { command: 'ls' } }, 1),
      resultEvent('c1', 2),
    ];
    const { v2 } = detail(events);
    expect(v2.steps[0].kind).toBe('thinking');
    expect(v2.steps[0].lane).toBe('think');
  });

  it('stamps schema:2 and preserves meta/gaps/whereItWentWrong shape', () => {
    const events: SessionEvent[] = [
      useEvent({ tool: 'Bash', callId: 'c1', command: 'ls', args: { command: 'ls' } }, 0),
      resultEvent('c1', 1),
    ];
    const { v2 } = detail(events);
    expect(v2.schema).toBe(2);
    expect(v2.id).toBe('sess-1');
    expect(v2.meta.repo).toBe('agents');
    expect(v2.meta.agent).toBe('claude');
    expect(Array.isArray(v2.steps)).toBe(true);
    expect(Array.isArray(v2.gaps)).toBe(true);
    // Omits category/risk/categoryMetrics — the consumer backfills them.
    expect((v2 as any).category).toBeUndefined();
    expect((v2 as any).risk).toBeUndefined();
  });

  it('surfaces a failed tool step in surfacedToolFailures', () => {
    const events: SessionEvent[] = [
      useEvent({ tool: 'Bash', callId: 'c1', command: 'false', args: { command: 'false' } }, 0),
      { type: 'error', agent: 'claude', timestamp: ts(1), callId: 'c1', tool: 'Bash', outcome: 'error', exitCode: 1, content: 'boom' } as SessionEvent,
    ];
    const { v2 } = detail(events);
    const bash = v2.steps[0] as BashExecution;
    expect(bash.outcome).toBe('error');
    expect(bash.result.exitCode).toBe(1);
    expect(v2.surfacedToolFailures).toHaveLength(1);
    expect(v2.surfacedToolFailures[0].tool).toBe('Bash');
  });
});

describe('buildSessionDetailV2 — hook step', () => {
  it('maps a hook event to a HookExecution merged by startMs (conservative decision)', () => {
    const events: SessionEvent[] = [
      useEvent({ tool: 'Bash', callId: 'c1', command: 'git push --force', args: { command: 'git push --force' } }, 0),
      { type: 'hook', agent: 'claude', timestamp: ts(1), hookName: 'main-branch-guard', hookEvent: 'PreToolUse', success: false } as SessionEvent,
      resultEvent('c1', 2),
    ];
    const { v2 } = detail(events);
    // Bash step (startMs 0) then the hook step (startMs ~1000).
    expect(v2.steps).toHaveLength(2);
    const hook = v2.steps.find((s) => (s as any).executionType === 'hook') as HookExecution;
    expect(hook).toBeDefined();
    expect(hook.lane).toBe('hook');
    expect(hook.phase).toBe('pre');
    // success:false → conservative 'unknown' (parse.ts loses blocked-vs-error).
    expect(hook.decision).toBe('unknown');
    expect(hook.hookName).toBe('main-branch-guard');
    // ordinals renumbered across the merge.
    expect(v2.steps.map((s) => s.ordinal)).toEqual([1, 2]);
  });

  it('maps a successful hook to allowed', () => {
    const events: SessionEvent[] = [
      { type: 'hook', agent: 'claude', timestamp: ts(0), hookName: 'SessionStart', hookEvent: 'SessionStart', success: true } as SessionEvent,
      useEvent({ tool: 'Bash', callId: 'c1', command: 'ls', args: { command: 'ls' } }, 1),
      resultEvent('c1', 2),
    ];
    const hook = detail(events).v2.steps.find((s) => (s as any).executionType === 'hook') as HookExecution;
    expect(hook.decision).toBe('allowed');
    expect(hook.phase).toBe('session');
  });
});
