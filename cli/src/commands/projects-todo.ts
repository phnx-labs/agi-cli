/**
 * `agents projects todo add|list|done|undo` — quick to-dos in Linear, the verbs
 * behind AGI Menu's Home to-do line. The logic lives in `lib/quick-todo.ts`.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { setHelpSections } from '../lib/help.js';
import { listProjectDefs } from '../lib/projects.js';
import {
  addQuickTodo,
  completeTodo,
  linearFailure,
  listQuickTodos,
  undoTodo,
  QUICK_TODO_MARKER,
  TODO_LIST_LIMIT,
  type QuickTodo,
  type TodoResult,
} from '../lib/quick-todo.js';

const PRIORITY_WORD = ['', 'urgent', 'high', 'medium', 'low'];

function todoLine(t: QuickTodo): string {
  const facts = [t.project, t.due && `due ${t.due}`, PRIORITY_WORD[t.priority], t.state].filter(Boolean).join(' · ');
  return `${chalk.bold(t.identifier)}  ${t.title}  ${chalk.gray(facts)}`;
}

/** A Linear identifier, or exit 1 with the same `ok: false` shape every verb prints. */
function issueIdOrExit(raw: string, json: boolean | undefined): string {
  const id = raw.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(id)) report({ ok: false, todo: null, message: `Expected a Linear issue identifier like PHNX-123, got "${raw}".` }, json);
  return id;
}

/** Print one verb's result and exit 1 when it did not happen. */
function report(result: TodoResult, json: boolean | undefined): void | never {
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (result.ok) console.log(`${chalk.green(result.message)}${result.todo ? `\n  ${todoLine(result.todo)}` : ''}`);
  else console.error(chalk.red(result.message));
  if (!result.ok) process.exit(1);
}

export function registerProjectTodoCommands(projects: Command): void {
  const todo = projects
    .command('todo')
    .description('Quick to-dos in Linear: add one from a line of text, list yours, mark one done, undo.');

  const addCmd = todo
    .command('add <text...>')
    .description('Create a to-do in Linear from one line: #project, today/tomorrow/mon..sun, ! (high) or !! (urgent).')
    .option('--project <name>', 'Project when the text names none: an agents project or a Linear project name')
    .option('--json', 'Machine-readable result')
    .action(async (words: string[], opts: { project?: string; json?: boolean }) => {
      report(await addQuickTodo(words.join(' '), { project: opts.project, defs: listProjectDefs(), now: new Date() }), opts.json);
    });

  setHelpSections(addCmd, {
    examples: `
      agents projects todo add "Renew npm token #AGI tomorrow !!"
      agents projects todo add "Draft the Q4 note fri" --project atlas --json
      agents projects todo add --json -- "-v flag is ignored by run"    # text starting with "-"
    `,
    notes: `
      Runs linear create: assigned to the Linear API key's owner, in the active
      cycle, status Todo, no milestone, priority none unless ! or !! is typed.
      #name is an agents project (its Linear project) or a Linear project name.
      A day word or ! / !! counts only at the end of the line (so "Fix the today
      view" keeps its words); #name counts anywhere. A day word is the next such
      day, today included. The description carries
      "${QUICK_TODO_MARKER}", which is how todo list finds it.
    `,
  });

  const listCmd = todo
    .command('list')
    .description(`Your open quick to-dos and anything assigned to you due today or overdue (at most ${TODO_LIST_LIMIT}).`)
    .option('--json', 'Machine-readable result')
    .action(async (opts: { json?: boolean }) => {
      let listed: { todos: QuickTodo[]; total: number };
      try {
        listed = await listQuickTodos(new Date());
      } catch (err) {
        const error = linearFailure(err);
        if (opts.json) console.log(JSON.stringify({ todos: [], total: 0, error }, null, 2));
        else console.error(chalk.red(`Could not read your Linear issues: ${error}`));
        process.exit(1);
      }
      if (opts.json) {
        console.log(JSON.stringify({ ...listed, error: null }, null, 2));
        return;
      }
      if (listed.todos.length === 0) console.log('Nothing to do: no open quick to-dos, nothing due.');
      for (const t of listed.todos) console.log(todoLine(t));
      if (listed.total > listed.todos.length) console.log(chalk.gray(`+${listed.total - listed.todos.length} more in Linear`));
    });

  setHelpSections(listCmd, {
    examples: `
      agents projects todo list
      agents projects todo list --json
    `,
    notes: `
      One linear tasks read of your open issues. Due ones come first (earliest due),
      then the newest quick to-dos. --json: { todos: [{ identifier, url, title,
      project, due, priority, state, createdAt, quick }], total, error }.
    `,
  });

  todo
    .command('done <id>')
    .description('Mark one issue Done in Linear.')
    .option('--json', 'Machine-readable result')
    .action(async (raw: string, opts: { json?: boolean }) => report(await completeTodo(issueIdOrExit(raw, opts.json)), opts.json));

  const undoCmd = todo
    .command('undo <id>')
    .description('Undo the last to-do action: reopen a Done issue, or cancel a quick to-do created moments ago.')
    .option('--json', 'Machine-readable result')
    .action(async (raw: string, opts: { json?: boolean }) => report(await undoTodo(issueIdOrExit(raw, opts.json), new Date()), opts.json));

  setHelpSections(undoCmd, {
    examples: `
      agents projects todo done PHNX-4230
      agents projects todo undo PHNX-4230     # back to Todo
    `,
    notes: `
      A Done issue goes back to Todo. A quick to-do still open and created in the
      last 30 seconds is moved to the team's canceled state (linear has no issue
      archive verb). Anything else is refused rather than silently ignored.
    `,
  });

  setHelpSections(todo, {
    examples: `
      agents projects todo add "Renew npm token #AGI tomorrow !!" --json
      agents projects todo list --json
      agents projects todo done PHNX-4230 --json
      agents projects todo undo PHNX-4230 --json
    `,
  });
}
