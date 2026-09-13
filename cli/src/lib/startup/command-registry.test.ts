/**
 * RUSH-2022 — `KNOWN_TOP_LEVEL_COMMANDS` is the "does this command exist?"
 * predicate the `--device`/`--device` router consults before it can claim a
 * command has no remote semantics. A name that drifts out of it turns a real
 * command into a phantom `unknown command`, so this pins the set against the
 * command tree the CLI actually registers — the real modules, no mocks.
 */
import { describe, it, expect } from 'vitest';
import {
  KNOWN_TOP_LEVEL_COMMANDS,
  isKnownTopLevelCommand,
} from './command-registry.js';
import {
  LAZY_COMMAND_NAMES,
  buildFullCommandTree,
  registerAllCommands,
} from '../../cli/command-registry.js';
import { configureRootCommand } from './root-command.js';
import { Command } from 'commander';

describe('KNOWN_TOP_LEVEL_COMMANDS', () => {
  it('covers every top-level name and alias the real command modules register', async () => {
    const program = await buildFullCommandTree();
    const registered = program.commands.flatMap((c) => [c.name(), ...c.aliases()]);
    expect(registered.length).toBeGreaterThan(50); // the tree really did load
    const missing = registered.filter((name) => !KNOWN_TOP_LEVEL_COMMANDS.has(name));
    expect(missing).toEqual([]);
  });

  it('includes the lazily-registered groups (sessions/teams/cloud/…)', () => {
    for (const name of LAZY_COMMAND_NAMES) {
      expect(isKnownTopLevelCommand(name)).toBe(true);
    }
  });

  it('includes the aliases and tombstones src/index.ts registers inline', () => {
    // Not in COMMAND_LOADERS — they are closures over entry-point state — but
    // they are real commands, so the router must not treat them as unknown.
    for (const name of ['perms', 'exec', 'jobs', 'cron', 'check', 'resources', 'hq', 'upgrade', '_internal']) {
      expect(isKnownTopLevelCommand(name)).toBe(true);
    }
  });

  it('rejects a name the CLI does not register', () => {
    expect(isKnownTopLevelCommand('session')).toBe(false); // the RUSH-2022 typo
    expect(isKnownTopLevelCommand('profile')).toBe(false);
    expect(isKnownTopLevelCommand('publish')).toBe(false);
    expect(isKnownTopLevelCommand('webhook')).toBe(false);
    expect(isKnownTopLevelCommand('wallet')).toBe(false);
    expect(isKnownTopLevelCommand('hosts')).toBe(false);
    expect(isKnownTopLevelCommand('lock')).toBe(false);
    expect(isKnownTopLevelCommand('helper')).toBe(false);
    expect(isKnownTopLevelCommand('whoami')).toBe(false);
    expect(isKnownTopLevelCommand('zzzznotacommand')).toBe(false);
    expect(isKnownTopLevelCommand('')).toBe(false);
  });

  it('keeps harness (provider profiles) and does not revive the old profiles tree', async () => {
    const program = await buildFullCommandTree();
    expect(program.commands.some((command) => command.name() === 'profile')).toBe(false);
    expect(program.commands.some((command) => command.name() === 'profiles')).toBe(false);

    const harness = program.commands.find((command) => command.name() === 'harness');
    expect(harness).toBeDefined();
    expect(harness!.commands.map((command) => command.name())).toContain('list');
  });

  it('does not recognize the removed defaults and export commands', () => {
    expect(isKnownTopLevelCommand('defaults')).toBe(false);
    expect(isKnownTopLevelCommand('export')).toBe(false);
  });

  it('does not recognize removed surface-prune top-level names', () => {
    for (const name of ['login', 'logout', 'budget', 'bench', 'mine', 'cost', 'output', 'profiles', 'snapshot', 'cp', 'resume', 'roster', 'status', 'tickets', 'alias', 'inbox', 'unshare', 'audit', 'trends', 'apply', 'beta', 'usage']) {
      expect(isKnownTopLevelCommand(name)).toBe(false);
    }
  });

  it('keeps pruned names in RETIRED so distance-1 typos do not auto-correct into live commands', async () => {
    const { RETIRED_TOP_LEVEL_COMMANDS } = await import('./command-registry.js');
    const { closestTopLevelCommand } = await import('./spellcheck.js');
    // Smoking gun for removing `cp`: levenshtein('cp','mcp') === 1 would otherwise
    // silently run `agents mcp`.
    expect(RETIRED_TOP_LEVEL_COMMANDS.has('cp')).toBe(true);
    expect(closestTopLevelCommand('cp', KNOWN_TOP_LEVEL_COMMANDS)).toEqual({ closest: 'mcp', minDist: 1 });
    for (const name of ['login', 'logout', 'budget', 'bench', 'mine', 'cost', 'output', 'profiles', 'snapshot', 'cp', 'webhook', 'resume', 'roster', 'status', 'tickets', 'alias', 'inbox', 'unshare', 'audit', 'trends', 'apply', 'beta', 'usage']) {
      expect(RETIRED_TOP_LEVEL_COMMANDS.has(name)).toBe(true);
    }
  });

  it('registers the plural webhooks command without a singular alias', async () => {
    const program = await buildFullCommandTree();
    const names = program.commands.flatMap((command) => [command.name(), ...command.aliases()]);

    expect(names).toContain('webhooks');
    expect(names).not.toContain('webhook');
  });

  it('registerAllCommands loads the same visible tree onto an existing program', async () => {
    const program = configureRootCommand(new Command(), 'agents', '0.0.0');
    await registerAllCommands(program);
    const names = program.commands.map((command) => command.name());
    expect(names.length).toBeGreaterThan(50);
    expect(names).toContain('ssh');
    expect(names).toContain('repos');
    expect(names).toContain('computer');
    expect(names).toContain('send');
  });
});
