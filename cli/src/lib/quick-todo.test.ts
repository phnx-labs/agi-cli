import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  addQuickTodo,
  completeTodo,
  DONE_PROOF,
  linearProjectFor,
  listQuickTodos,
  parseQuickTodo,
  QUICK_TODO_MARKER,
  resolveDayWord,
  undoTodo,
} from './quick-todo.js';
import type { ProjectDef } from './projects.js';

// Recorded from real `linear` runs on 2026-10-04 (PHNX-4234 created, marked Done,
// reopened, Done again; PHNX-4235 created and canceled by undo).
// tasks-assigned-open.json keeps the recorded PHNX-4234 list row and two rows
// derived from it (no marker / no due date, and overdue), so no other issue leaks in.
const testdata = (name: string) => fs.readFileSync(path.join(__dirname, 'testdata', 'quick-todo', name), 'utf-8');

/** A linear runner answering from recorded output keyed by argv; records what was asked. */
type Answer = string | Error | { stdout: string; stderr: string };
function recordedLinear(routes: Record<string, Answer | Answer[]>) {
  const asked: string[][] = [];
  const linear = async (args: string[]) => {
    asked.push(args);
    let hit = routes[args.join(' ')];
    if (Array.isArray(hit)) hit = hit.length > 1 ? hit.shift()! : hit[0];
    if (hit === undefined) throw new Error(`unexpected linear ${args.join(' ')}`);
    if (hit instanceof Error) throw hit;
    return typeof hit === 'string' ? { stdout: hit, stderr: '' } : hit;
  };
  return { linear, asked };
}

const linearError = (stderr: string) => Object.assign(new Error('Command failed: linear'), { stderr });

// Sunday 2026-10-04, 17:32 local.
const NOW = new Date(2026, 9, 4, 17, 32);
const agi = { name: 'agi', linear: { projectId: '00000000', name: 'AGI' } } as ProjectDef;

describe('parseQuickTodo', () => {
  it('takes the #project, day word and priority out of the line', () => {
    expect(parseQuickTodo('Renew npm token #AGI tomorrow !!', NOW)).toEqual({
      title: 'Renew npm token', project: 'AGI', due: '2026-10-05', priority: 'urgent',
    });
    expect(parseQuickTodo('Draft the Q4 note fri !', NOW)).toEqual({ title: 'Draft the Q4 note', project: null, due: '2026-10-09', priority: 'high' });
    expect(parseQuickTodo('Call back', NOW)).toEqual({ title: 'Call back', project: null, due: null, priority: null });
  });

  it('takes a day word or ! only from the end of the line, ignoring trailing punctuation', () => {
    expect(parseQuickTodo('Fix the today view bug', NOW)).toEqual({ title: 'Fix the today view bug', project: null, due: null, priority: null });
    expect(parseQuickTodo('Call back tomorrow, !!!', NOW)).toEqual({ title: 'Call back', project: null, due: '2026-10-05', priority: 'urgent' });
    expect(parseQuickTodo('Ship it #AGI.', NOW)).toMatchObject({ title: 'Ship it', project: 'AGI' });
  });

  it('only takes tokens that stand alone, and only the first of each', () => {
    expect(parseQuickTodo("won't fix today's build!", NOW)).toEqual({ title: "won't fix today's build!", project: null, due: null, priority: null });
    expect(parseQuickTodo('ship #AGI #Rush today tomorrow', NOW)).toMatchObject({ title: 'ship #Rush tomorrow', project: 'AGI', due: '2026-10-04' });
  });

  it('reads a weekday as the next such day, today included', () => {
    expect(resolveDayWord('sun', NOW)).toBe('2026-10-04');
    expect(resolveDayWord('Monday', NOW)).toBe('2026-10-05');
    expect(resolveDayWord('sat', NOW)).toBe('2026-10-10');
    expect(resolveDayWord('today', NOW)).toBe('2026-10-04');
  });
});

describe('linearProjectFor', () => {
  it('maps an agents project to its Linear project, and passes anything else through', () => {
    expect(linearProjectFor('AGI', [agi])).toBe('AGI');
    expect(linearProjectFor('agi', [agi])).toBe('AGI');
    expect(linearProjectFor('Atlas', [agi])).toBe('Atlas');
    expect(() => linearProjectFor('solo', [{ name: 'solo' } as ProjectDef])).toThrow(/no Linear project/);
  });
});

describe('addQuickTodo', () => {
  const createArgs = 'create --description Created from AGI Menu --status Todo --cycle active --skip-milestone --priority high --project AGI --due-date 2026-10-09 -- Scratch to-do for the undo check';

  it('creates the issue with the parsed fields and reads it back', async () => {
    const { linear, asked } = recordedLinear({
      [createArgs]: testdata('create.stdout'),
      'tasks PHNX-4235 --json': testdata('tasks-PHNX-4235-created.json'),
    });
    const result = await addQuickTodo('Scratch to-do for the undo check #agi fri !', { defs: [agi], now: NOW }, linear);
    expect(asked[0].join(' ')).toBe(createArgs);
    expect(result).toEqual({
      ok: true,
      message: 'Created PHNX-4235',
      todo: {
        identifier: 'PHNX-4235',
        url: 'https://linear.app/example-team/issue/PHNX-4235/scratch-to-do-for-the-undo-check',
        title: 'Scratch to-do for the undo check',
        project: 'AGI', due: '2026-10-09', priority: 2, state: 'Todo',
        createdAt: '2026-10-05T00:33:53.809Z', quick: true,
      },
    });
  });

  it('uses --project when the text names none, and passes priority none when no ! is typed', async () => {
    const { linear, asked } = recordedLinear({});
    await addQuickTodo('Call back', { project: 'agi', defs: [agi], now: NOW }, linear);
    expect(asked[0]).toEqual(['create', '--description', QUICK_TODO_MARKER, '--status', 'Todo', '--cycle', 'active',
      '--skip-milestone', '--priority', 'none', '--project', 'AGI', '--', 'Call back']);
  });

  it('refuses a line with nothing but tokens, and passes linear\'s refusal through', async () => {
    expect(await addQuickTodo('#AGI today !!', { defs: [agi], now: NOW }, recordedLinear({}).linear))
      .toMatchObject({ ok: false, todo: null });
    const args = 'create --description Created from AGI Menu --status Todo --cycle active --skip-milestone --priority none --project Nope -- Call back';
    const refused = recordedLinear({ [args]: linearError('Error: Project not found: Nope\n') });
    expect(await addQuickTodo('Call back #Nope', { defs: [agi], now: NOW }, refused.linear))
      .toEqual({ ok: false, todo: null, message: 'Project not found: Nope' });
    // linear create prints some refusals as "Error:" on stderr and still exits 0.
    const quiet = recordedLinear({ [args]: { stdout: '', stderr: 'Similar existing tickets (consider enriching one instead of creating):\nError: Issue create failed\n' } });
    expect(await addQuickTodo('Call back #Nope', { defs: [agi], now: NOW }, quiet.linear))
      .toEqual({ ok: false, todo: null, message: 'Issue create failed' });
  });

  it('sends the form fields, each beating the same field typed in the line', async () => {
    const { linear, asked } = recordedLinear({});
    await addQuickTodo('Rotate the share token #Rush tomorrow !!', {
      project: 'agi', description: '  Expires Oct 20.\nMint a new one.  ', assignee: 'bisma', due: '2026-10-09', priority: 'low', defs: [agi], now: NOW,
    }, linear);
    expect(asked[0]).toEqual(['create', '--description', `Expires Oct 20.\nMint a new one.\n\n${QUICK_TODO_MARKER}`, '--status', 'Todo',
      '--cycle', 'active', '--skip-milestone', '--priority', 'low', '--project', 'AGI', '--due-date', '2026-10-09',
      '--assign', 'bisma', '--', 'Rotate the share token']);
    await addQuickTodo('Call back', { assignee: 'me', defs: [agi], now: NOW }, linear);
    expect(asked[1]).not.toContain('--assign');
  });

  it('refuses a short or long title, a past or malformed due date and a huge description, before calling linear', async () => {
    const { linear, asked } = recordedLinear({});
    const refuse = (text: string, extra: Partial<Parameters<typeof addQuickTodo>[1]> = {}) =>
      addQuickTodo(text, { defs: [agi], now: NOW, ...extra }, linear).then((r) => (expect(r.ok).toBe(false), r.message));
    expect(await refuse('ok')).toBe('The title needs at least 3 characters.');
    expect(await refuse('x'.repeat(121))).toBe('The title is 121 characters; the limit is 120. Put the rest in the description.');
    expect(await refuse('Call back', { due: '2026-10-03' })).toBe('The due date 2026-10-03 is in the past.');
    expect(await refuse('Call back', { due: '2026-02-30' })).toBe('Expected a due date like 2026-10-09, got "2026-02-30".');
    expect(await refuse('Call back', { description: 'x'.repeat(10_001) })).toBe('The description is over 10,000 characters.');
    expect(asked).toHaveLength(0);
    await addQuickTodo('Call back', { due: '2026-10-04', defs: [agi], now: NOW }, linear);
    expect(asked[0]).toContain('2026-10-04');
  });

  it('reports a created issue as created even when reading it back fails, so a retry does not duplicate it', async () => {
    const { linear } = recordedLinear({ [createArgs]: testdata('create.stdout'), 'tasks PHNX-4235 --json': linearError('Error: timed out\n') });
    const result = await addQuickTodo('Scratch to-do for the undo check #agi fri !', { defs: [agi], now: NOW }, linear);
    expect(result).toMatchObject({ ok: true, message: 'Created PHNX-4235; reading it back failed: timed out', todo: { identifier: 'PHNX-4235', due: '2026-10-09', priority: 2 } });
  });
});

describe('listQuickTodos', () => {
  it('lists open quick to-dos and anything due today or overdue, due ones first', async () => {
    const { linear, asked } = recordedLinear({
      'tasks --assignee me --status open --cycle all --all --json': testdata('tasks-assigned-open.json'),
    });
    const listed = await listQuickTodos(NOW, linear);
    expect(asked).toHaveLength(1);
    expect(listed.total).toBe(2);
    expect(listed.todos.map((t) => [t.identifier, t.due, t.quick])).toEqual([
      ['PHNX-9002', '2026-10-03', false],
      ['PHNX-4234', '2026-10-04', true],
    ]);
  });
});

describe('completeTodo', () => {
  it('marks Done with the proof linear requires', async () => {
    const { linear, asked } = recordedLinear({
      [`update PHNX-4234 --done --proof ${DONE_PROOF}`]: testdata('update-done.stdout'),
      'tasks PHNX-4234 --json': testdata('tasks-PHNX-4234-done.json'),
      'states --json': testdata('states.json'),
    });
    expect(await completeTodo('PHNX-4234', linear)).toMatchObject({ ok: true, message: 'PHNX-4234 marked Done', todo: { state: 'Done' } });
    expect(asked[0]).toEqual(['update', 'PHNX-4234', '--done', '--proof', DONE_PROOF]);
  });

  it('does not call a close linear only queued (rate limited) done', async () => {
    const { linear } = recordedLinear({
      // linear's own line for a close it queued, and the issue still Todo.
      [`update PHNX-4234 --done --proof ${DONE_PROOF}`]: 'PHNX-4234 -> queued for retry (rate limited / transient)\n',
      'tasks PHNX-4234 --json': testdata('tasks-PHNX-4234-todo.json'),
      'states --json': testdata('states.json'),
    });
    expect(await completeTodo('PHNX-4234', linear)).toMatchObject({
      ok: false, message: 'Not closed yet: PHNX-4234 -> queued for retry (rate limited / transient)', todo: { state: 'Todo' },
    });
  });

  it('reports linear\'s reason, not its usage hint, when it refuses', async () => {
    const { linear } = recordedLinear({
      [`update PHNX-4234 --done --proof ${DONE_PROOF}`]: linearError(testdata('update-done-without-proof.stderr')),
    });
    expect(await completeTodo('PHNX-4234', linear)).toEqual({
      ok: false, todo: null, message: 'Cannot mark done without proof. Provide at least one --proof:',
    });
  });
});

describe('undoTodo', () => {
  it('reopens a Done issue', async () => {
    const { linear, asked } = recordedLinear({
      'tasks PHNX-4234 --json': [testdata('tasks-PHNX-4234-done.json'), testdata('tasks-PHNX-4234-todo.json')],
      'states --json': testdata('states.json'),
      'update PHNX-4234 --todo': testdata('update-todo.stdout'),
    });
    expect(await undoTodo('PHNX-4234', NOW, linear)).toMatchObject({ ok: true, message: 'PHNX-4234 back to Todo', todo: { state: 'Todo' } });
    expect(asked.map((a) => a.join(' '))).toContain('update PHNX-4234 --todo');
  });

  it('cancels a quick to-do created moments ago, and refuses once the moment has passed', async () => {
    const routes = () => ({
      'tasks PHNX-4235 --json': [testdata('tasks-PHNX-4235-created.json'), testdata('tasks-PHNX-4235-canceled.json')],
      'states --json': testdata('states.json'),
      'update PHNX-4235 --status Canceled': testdata('update-canceled.stdout'),
    });
    const created = Date.parse('2026-10-05T00:33:53.809Z');
    const fresh = recordedLinear(routes());
    expect(await undoTodo('PHNX-4235', new Date(created + 5_000), fresh.linear))
      .toMatchObject({ ok: true, message: 'PHNX-4235 canceled', todo: { state: 'Canceled' } });

    const late = recordedLinear(routes());
    expect(await undoTodo('PHNX-4235', new Date(created + 60_000), late.linear))
      .toMatchObject({ ok: false, message: 'PHNX-4235 is Todo and was not just created here; change it in Linear' });
    expect(late.asked.some((a) => a[0] === 'update')).toBe(false);
  });
});
