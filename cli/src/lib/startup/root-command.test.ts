import { describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { normalizeResumeDeviceArgs } from './root-command.js';
import { buildFullCommandTree } from '../../cli/command-registry.js';
import { peerArgs } from '../../commands/sessions-backfill.js';

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

describe('PHNX-4227 — the backfill peer argv parses on the real command tree', () => {
  it('every filter peerArgs forwards is an option of daemon index backfill tools', async () => {
    const program = await buildFullCommandTree();
    program.exitOverride();
    const tools = find(program, 'daemon', 'index', 'backfill', 'tools');
    let captured: Record<string, unknown> | undefined;
    tools.action((_opts: unknown, command: Command) => { captured = command.optsWithGlobals(); });
    const args = peerArgs({ agent: 'codex', project: 'cli', since: '7d', until: '1d', unmanaged: true, teams: true });
    await program.parseAsync(['node', 'agents', ...args], { from: 'node' });
    expect(captured).toMatchObject({
      json: true, local: true, agent: 'codex', project: 'cli', since: '7d', until: '1d', unmanaged: true, teams: true,
    });
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
