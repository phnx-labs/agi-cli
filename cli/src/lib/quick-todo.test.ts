import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeLinear, type FakeLinear } from './__tests__/fake-linear.js';
import {
  addQuickTodo,
  completeTodo,
  DONE_PROOF,
  linearTargetFor,
  listQuickTodos,
  parseQuickTodo,
  QUICK_TODO_MARKER,
  resolveDayWord,
  undoTodo,
} from './quick-todo.js';
import type { ProjectDef } from './projects.js';

const testdata = (name: string) => fs.readFileSync(path.join(__dirname, 'testdata', 'quick-todo', name), 'utf-8');

type Answer = string | Error | { stdout: string; stderr: string };
function recordedLinear(routes: Record<string, Answer | Answer[]>) {
  const asked: string[][] = [];
  const profiles: Array<string | undefined> = [];
  const linear = async (args: string[], profile?: string) => {
    asked.push(args);
    profiles.push(profile);
    let hit = routes[args.join(' ')];
    if (Array.isArray(hit)) hit = hit.length > 1 ? hit.shift()! : hit[0];
    if (hit === undefined) throw new Error(`unexpected linear ${args.join(' ')}`);
    if (hit instanceof Error) throw hit;
    return typeof hit === 'string' ? { stdout: hit, stderr: '' } : hit;
  };
  return { linear, asked, profiles };
}

const linearError = (stderr: string) => Object.assign(new Error('Command failed: linear'), { stderr });

const NOW = new Date(2026, 9, 4, 17, 32);
const agi = { name: 'agi', linear: { projectId: '00000000', name: 'AGI' } } as ProjectDef;
const talora = { name: 'talora', linear: { projectId: '11111111', name: 'Talora', profile: 'personal' } } as ProjectDef;

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

describe('linearTargetFor', () => {
  it('maps an agents project to its Linear project, and passes anything else through', () => {
    expect(linearTargetFor('AGI', [agi])).toEqual({ project: 'AGI' });
    expect(linearTargetFor('agi', [agi])).toEqual({ project: 'AGI' });
    expect(linearTargetFor('Atlas', [agi])).toEqual({ project: 'Atlas' });
    expect(() => linearTargetFor('solo', [{ name: 'solo' } as ProjectDef])).toThrow(/no Linear project/);
  });

  it('carries the linear-cli profile of a project that lives in another workspace', () => {
    expect(linearTargetFor('talora', [talora])).toEqual({ project: 'Talora', profile: 'personal' });
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

  it('runs the create and the read-back in the profile of a project in another workspace', async () => {
    const args = 'create --description Created from AGI Menu --status Todo --cycle active --skip-milestone --priority none --project Talora -- Call back';
    const { linear, asked, profiles } = recordedLinear({
      [args]: testdata('create.stdout'),
      'tasks PHNX-4235 --json': testdata('tasks-PHNX-4235-created.json'),
    });
    expect(await addQuickTodo('Call back #talora', { defs: [agi, talora], now: NOW }, linear)).toMatchObject({ ok: true });
    expect(asked.map((a) => a[0])).toEqual(['create', 'tasks']);
    expect(profiles).toEqual(['personal', 'personal']);
    const plain = recordedLinear({});
    await addQuickTodo('Call back #agi', { defs: [agi, talora], now: NOW }, plain.linear);
    expect(plain.profiles).toEqual([undefined]);
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
    const listed = await listQuickTodos(NOW, {}, linear);
    expect(asked).toHaveLength(1);
    expect(listed.total).toBe(2);
    expect(listed.todos.map((t) => [t.identifier, t.due, t.quick])).toEqual([
      ['PHNX-9002', '2026-10-03', false],
      ['PHNX-4234', '2026-10-04', true],
    ]);
  });

  it('with a project, lists that Linear project\'s open issues: due first (earliest), then newest, capped (PHNX-4344)', async () => {
    const rush = { name: 'rush', linear: { projectId: '00000000', name: 'Rush' } } as ProjectDef;
    const { linear, asked } = recordedLinear({
      'tasks --project Rush --status open --all --json': testdata('tasks-project-open.json'),
    });
    const listed = await listQuickTodos(NOW, { project: 'rush', defs: [rush] }, linear);
    expect(asked).toEqual([['tasks', '--project', 'Rush', '--status', 'open', '--all', '--json']]);
    expect(listed.total).toBe(8);
    expect(listed.todos.map((t) => [t.identifier, t.due])).toEqual([
      ['PHNX-9103', '2026-10-02'],
      ['PHNX-9105', '2026-10-04'],
      ['PHNX-9102', '2026-10-11'],
      ['PHNX-9101', null],
      ['PHNX-9108', null],
      ['PHNX-9106', null],
    ]);
  });

  it('lists a project in another workspace through its profile', async () => {
    const { linear, profiles } = recordedLinear({
      'tasks --project Talora --status open --all --json': testdata('tasks-project-open.json'),
    });
    await listQuickTodos(NOW, { project: 'talora', defs: [talora] }, linear);
    expect(profiles).toEqual(['personal']);
  });

  it('refuses an agents project with no Linear binding before calling linear', async () => {
    const { linear, asked } = recordedLinear({});
    await expect(listQuickTodos(NOW, { project: 'loose', defs: [{ name: 'loose' } as ProjectDef] }, linear))
      .rejects.toThrow(/has no Linear project/);
    expect(asked).toEqual([]);
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

describe.skipIf(process.platform === 'win32')('linearExec spawns linear in the right workspace', () => {
  const profileDir = path.join(os.homedir(), '.linear-cli', 'profiles', 'personal');
  let linear: FakeLinear;
  beforeEach(() => {
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'config.json'), JSON.stringify({ teamKey: 'TAL' }));
    linear = installFakeLinear({
      'tasks --project Talora --status open --all --json': '{"issues":[]}',
      'tasks --project AGI --status open --all --json': '{"issues":[]}',
      [`update TAL-7 --done --proof ${DONE_PROOF}`]: 'Updated TAL-7\n',
      'tasks TAL-7 --json': '{"identifier":"TAL-7","title":"Ship","state":{"name":"Done"}}',
      'states --json': '[{"name":"Done","type":"completed"}]',
    });
  });
  afterEach(() => {
    linear.restore();
    fs.rmSync(path.join(os.homedir(), '.linear-cli'), { recursive: true, force: true });
  });

  it('pins the project profile, pins default for an unprofiled project, and finds an issue\'s profile from its team key', async () => {
    await listQuickTodos(NOW, { project: 'talora', defs: [talora] });
    await listQuickTodos(NOW, { project: 'agi', defs: [agi] });
    expect(await completeTodo('TAL-7')).toMatchObject({ ok: true, message: 'TAL-7 marked Done' });
    expect(linear.calls().map((c) => `${c.profile} ${c.argv.split(' ').slice(0, 2).join(' ')}`)).toEqual([
      'personal tasks --project',
      'default tasks --project',
      'personal update TAL-7',
      'personal tasks TAL-7',
      'personal states --json',
    ]);
  });
});
