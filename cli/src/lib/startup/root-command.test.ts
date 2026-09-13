/**
 * RUSH-2687 — commander's `Command#_parseCommand` runs `parseOptions` on the
 * FULL remaining argv, so an ancestor can silently consume a token that
 * matches one of ITS OWN registered options even when the token was meant for
 * a descendant command declaring the same long name (`agents artifacts share
 * list --json` fell through to the human table because the `share` command
 * also owns `--json`).
 *
 * `enablePositionalOptions()` fixes that class of bug, but ONLY when set on
 * EVERY ancestor in the chain, root program included — and setting it on the
 * root is NOT scoped to the root's own scan: commander's
 * `copyInheritedSettings()` copies `_enablePositionalOptions` onto every
 * command created via `.command()` from that point on, so it cascades to all
 * ~552 registered commands. That was evaluated for this ticket and reverted —
 * it broke a real, load-bearing pattern used elsewhere in the tree: a parent
 * command (`sessions`, which owns `--since`/`--json`/`--local`) whose LEAF
 * subcommands declare none of their own options and read them back via
 * `command.optsWithGlobals()` (`sessions backfill tools --since 7d --json
 * --local`) — positional options makes the parent stop scanning at the first
 * subcommand-shaped token, so it never sees flags typed after it.
 *
 * RUSH-2687 was fixed per-surface instead (see commands/share.ts): the
 * colliding options on `list`/`update`/`delete`/`unshare` were renamed
 * (`--for-user`, `--list-json`, `--update-json`, `--delete-json`), matching
 * the precedent `revisions` already set (`--for-user`/`--revisions-json`).
 * root-command.ts, artifacts.ts carry NO functional change for this ticket.
 *
 * This suite pins both halves: the exact repro from the ticket now works, and
 * the pattern that broke when the global flag was tried is unaffected because
 * that approach was never shipped.
 */
import { describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { normalizeResumeDeviceArgs } from './root-command.js';
import { buildFullCommandTree } from '../../cli/command-registry.js';

/** Find a (possibly nested) subcommand by name path, e.g. `find(program, 'artifacts', 'share', 'list')`. */
function find(program: Command, ...path: string[]): Command {
  let cmd = program;
  for (const name of path) {
    const next = cmd.commands.find((c) => c.name() === name);
    if (!next) throw new Error(`Command not found: ${path.join(' ')} (missing '${name}')`);
    cmd = next;
  }
  return cmd;
}

/** Replace a command's real action with a capture spy, so parsing it doesn't
 * run real side effects (network calls, spawning agents) — only the parsed
 * `opts` object is observed. */
function captureAction(cmd: Command): { get: () => unknown[] } {
  let captured: unknown[] = [];
  cmd.action((...args: unknown[]) => { captured = args; });
  return { get: () => captured };
}

describe('RUSH-2687 — per-surface fix on the real command tree, no global regression', () => {
  it('agents artifacts share list --list-json (the ticket repro, renamed) reaches the action', async () => {
    const program = await buildFullCommandTree();
    program.exitOverride();
    const list = find(program, 'artifacts', 'share', 'list');
    const spy = captureAction(list);
    await program.parseAsync(['node', 'agents', 'artifacts', 'share', 'list', '--list-json'], { from: 'node' });
    const [opts] = spy.get() as [{ listJson?: boolean }];
    expect(opts.listJson).toBe(true);
  });

  it('agents artifacts share delete --for-user/--delete-json both reach the action', async () => {
    const program = await buildFullCommandTree();
    program.exitOverride();
    const del = find(program, 'artifacts', 'share', 'delete');
    const spy = captureAction(del);
    await program.parseAsync(
      ['node', 'agents', 'artifacts', 'share', 'delete', 'x', '--for-user', 'octocat', '--delete-json'],
      { from: 'node' },
    );
    const [targets, opts] = spy.get() as [string[], { forUser?: string; deleteJson?: boolean }];
    expect(targets).toEqual(['x']);
    expect(opts.forUser).toBe('octocat');
    expect(opts.deleteJson).toBe(true);
  });

  it('agents artifacts share update --update-json reaches the action', async () => {
    const program = await buildFullCommandTree();
    program.exitOverride();
    const update = find(program, 'artifacts', 'share', 'update');
    const spy = captureAction(update);
    await program.parseAsync(['node', 'agents', 'artifacts', 'share', 'update', '--update-json'], { from: 'node' });
    const [opts] = spy.get() as [{ updateJson?: boolean }];
    expect(opts.updateJson).toBe(true);
  });

  it('the parent `share` command still owns the unrenamed --json/--github-user for publish', async () => {
    const program = await buildFullCommandTree();
    program.exitOverride();
    const share = find(program, 'artifacts', 'share');
    expect(share.options.map((o) => o.long)).toEqual(expect.arrayContaining(['--json', '--github-user']));
  });

  it('a nested command whose own flags require ancestor optsWithGlobals still works — the pattern that broke under the global-flag approach', async () => {
    // `sessions backfill tools`/`resources` declare NO options of their own;
    // they read --since/--json/--local back off the `sessions` ancestor via
    // command.optsWithGlobals(). This is exactly what enablePositionalOptions()
    // on the root broke (see the module docblock) — pinned here as a permanent
    // guard against re-attempting that approach.
    const program = await buildFullCommandTree();
    program.exitOverride();
    const tools = find(program, 'sessions', 'backfill', 'tools');
    let captured: Record<string, unknown> | undefined;
    tools.action((_opts: unknown, command: Command) => { captured = command.optsWithGlobals(); });
    await program.parseAsync(
      ['node', 'agents', 'sessions', 'backfill', 'tools', '--since', '7d', '--json', '--local'],
      { from: 'node' },
    );
    expect(captured?.since).toBe('7d');
    expect(captured?.json).toBe(true);
    expect(captured?.local).toBe(true);
  });
});

describe('resume device argument normalization', () => {
  it.each(['--device', '--devices', '-D'])('normalizes %s without consuming its value or the selector', (flag) => {
    expect(normalizeResumeDeviceArgs(['sessions', 'resume', flag, 'zion', 'query']))
      .toEqual(['sessions', 'resume', '--resume-device', 'zion', 'query']);
  });
  it.each(['--device=zion', '--devices=zion', '-Dzion', '-D=zion'])('normalizes attached %s', (flag) => {
    expect(normalizeResumeDeviceArgs(['sessions', 'resume', flag, 'query']))
      .toEqual(['sessions', 'resume', '--resume-device=zion', 'query']);
  });
  it('preserves literal arguments after -- and sibling command arguments', () => {
    for (const args of [
      ['sessions', 'resume', '--', '--device', 'zion'],
      ['sessions', 'backfill', 'tools', '--device', 'zion', 'yosemite-m5'],
      ['sessions', '--device', 'zion', 'yosemite-m5'],
      ['run', 'claude', '--device', 'zion'],
    ]) expect(normalizeResumeDeviceArgs(args)).toEqual(args);
  });
});
