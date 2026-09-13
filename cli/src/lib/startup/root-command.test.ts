/**
 * RUSH-2687 — commander's `Command#_parseCommand` runs `parseOptions` on the
 * FULL remaining argv, so an ancestor can silently consume a token that
 * matches one of ITS OWN registered options even when the token was meant for
 * a descendant command declaring the same long name. The original repro was
 * `agents artifacts share list --json` falling through to the human table
 * because the `share` command also owned `--json`; that whole command group
 * moved out to the standalone `artifacts` CLI (PHNX-3992), so the share-specific
 * half of this suite is gone with it.
 *
 * What remains is the general no-regression guard. `enablePositionalOptions()`
 * fixes that class of bug, but ONLY when set on EVERY ancestor in the chain,
 * root program included — and setting it on the root is NOT scoped to the root's
 * own scan: commander's `copyInheritedSettings()` copies
 * `_enablePositionalOptions` onto every command created via `.command()` from
 * that point on, so it cascades to all registered commands. That approach was
 * evaluated and reverted — it broke a real, load-bearing pattern: a parent
 * command (`sessions`, which owns `--since`/`--json`/`--local`) whose LEAF
 * subcommands declare none of their own options and read them back via
 * `command.optsWithGlobals()` (`sessions backfill tools --since 7d --json
 * --local`) — positional options makes the parent stop scanning at the first
 * subcommand-shaped token, so it never sees flags typed after it. This suite
 * pins that the pattern still works, so the global-flag approach is never
 * re-attempted.
 */
import { describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { normalizeResumeDeviceArgs } from './root-command.js';
import { buildFullCommandTree } from '../../cli/command-registry.js';

/** Find a (possibly nested) subcommand by name path, e.g. `find(program, 'sessions', 'backfill', 'tools')`. */
function find(program: Command, ...path: string[]): Command {
  let cmd = program;
  for (const name of path) {
    const next = cmd.commands.find((c) => c.name() === name);
    if (!next) throw new Error(`Command not found: ${path.join(' ')} (missing '${name}')`);
    cmd = next;
  }
  return cmd;
}

describe('RUSH-2687 — no global positional-options regression on the real command tree', () => {
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
