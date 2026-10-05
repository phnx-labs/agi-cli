import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { RUN_OPTION_FORWARDING, RUN_OPTION_REJECT_MESSAGES } from './remote-cmd.js';
import { buildRunForwardedArgs, buildInteractiveRunForwardedArgs } from './dispatch.js';
import { registerRunCommand } from '../../commands/exec.js';

function runCommandOptions(): { attribute: string; flags: string }[] {
  const program = new Command();
  program.exitOverride();
  registerRunCommand(program);
  const run = program.commands.find((c) => c.name() === 'run');
  if (!run) throw new Error('run command not registered');
  return run.options.map((o) => ({ attribute: o.attributeName(), flags: o.flags }));
}

describe('RUN_OPTION_FORWARDING — completeness', () => {
  it('classifies every option the run command actually declares', () => {
    const missing = runCommandOptions().filter((o) => !(o.attribute in RUN_OPTION_FORWARDING));
    expect(
      missing,
      `Unclassified run option(s): ${missing.map((m) => m.flags).join(', ')} — ` +
        `add each to RUN_OPTION_FORWARDING in remote-cmd.ts (forward it in ` +
        `buildRunForwardedArgs, reject it with a message, or mark it local-only). ` +
        `Silent drops at the SSH boundary are the bug this table prevents.`,
    ).toEqual([]);
  });

  it('has no stale entries for options the run command no longer declares', () => {
    const declared = new Set(runCommandOptions().map((o) => o.attribute));
    const stale = Object.keys(RUN_OPTION_FORWARDING).filter((k) => !declared.has(k));
    expect(stale).toEqual([]);
  });

  it('every reject class ships an actionable message', () => {
    const rejects = Object.entries(RUN_OPTION_FORWARDING)
      .filter(([, v]) => v === 'reject')
      .map(([k]) => k);
    for (const attr of rejects) {
      expect(RUN_OPTION_REJECT_MESSAGES[attr], `missing reject message for ${attr}`).toBeTruthy();
    }
  });
});

describe('buildRunForwardedArgs — forwarded options land in the remote argv', () => {
  it('forwards the full option set', () => {
    const args = buildRunForwardedArgs({
      agent: 'claude',
      prompt: 'do the thing',
      mode: 'edit',
      model: 'claude-opus-4-6',
      name: 'nightly',
      effort: 'low',
      env: ['A=1', 'B=2'],
      addDir: ['/data'],
      timeout: '30m',
      strategy: 'balanced',
      account: 'work',
      fallback: 'codex,gemini',
      loop: true,
      maxIterations: '5',
      budget: '200000',
      until: 'signal',
      interval: '30m',
      json: true,
      verbose: true,
      yes: true,
      autoSecrets: false,
      passthroughArgs: ['--native-flag', 'v'],
    });
    expect(args).toEqual([
      'run', 'claude#work', 'do the thing', '--quiet',
      '--mode', 'edit',
      '--model', 'claude-opus-4-6',
      '--effort', 'low',
      '--env', 'A=1', '--env', 'B=2',
      '--add-dir', '/data',
      '--timeout', '30m',
      '--strategy', 'balanced',
      '--account', 'work',
      '--fallback', 'codex,gemini',
      '--loop',
      '--max-iterations', '5',
      '--budget', '200000',
      '--until', 'signal',
      '--interval', '30m',
      '--json',
      '--verbose',
      '--yes',
      '--no-auto-secrets',
      '--name', 'nightly',
      '--', '--native-flag', 'v',
    ]);
  });

  it('omits effort "auto" — the remote default, forwarding it is noise', () => {
    const args = buildRunForwardedArgs({ agent: 'codex', prompt: 'p', effort: 'auto' });
    expect(args).not.toContain('--effort');
  });

  it('keeps the minimal argv minimal (no flag soup when nothing was passed)', () => {
    expect(buildRunForwardedArgs({ agent: 'codex', prompt: 'p' })).toEqual(['run', 'codex', 'p', '--quiet']);
  });

  it('interactive builder forwards effort/env and keeps passthrough last', () => {
    const args = buildInteractiveRunForwardedArgs({
      agent: 'claude',
      effort: 'high',
      account: 'work',
      env: ['X=1'],
      passthroughArgs: ['--flag'],
    });
    expect(args).toEqual(['run', 'claude#work', '--effort', 'high', '--env', 'X=1', '--account', 'work', '--', '--flag']);
  });
});
