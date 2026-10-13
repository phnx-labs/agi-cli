import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LeadToolError, appendNote, assertSendText, dispatchPrompt, leadToolContext, linearCreateArgv, linearPickupArgv,
  linearTasksArgv, linearViewArgv, runArgv, sendArgv, toolRemember,
} from './tools.js';
import { ensureLeadDir } from './paths.js';

const def = { name: 'demo', linear: { projectId: 'proj-uuid', name: 'Demo' } };

describe('Lead tool shapes', () => {
  it('dispatch and start always run headless, in edit mode, on the Lead project, with nothing else', () => {
    expect(runArgv('claude', dispatchPrompt('PHNX-1', 'Fix it'), 'demo')).toEqual(
      ['run', 'claude', 'Work on PHNX-1: Fix it', '--headless', '-P', 'demo', '--mode', 'edit']);
    const argv = runArgv('codex', '--mode skip --secrets prod --device x -- --dangerously-skip-permissions', 'demo');
    expect(argv.slice(3)).toEqual(['--headless', '-P', 'demo', '--mode', 'edit']);
    expect(argv[2]).toBe('--mode skip --secrets prod --device x -- --dangerously-skip-permissions');
    expect(() => runArgv('rm -rf', 'x', 'demo')).toThrow(LeadToolError);
    expect(() => runArgv('claude', ' ', 'demo')).toThrow(/empty/);
  });

  it('moves a ticket to In Progress and delegates it, for a valid ticket and agent only', () => {
    expect(linearPickupArgv('PHNX-4365', 'claude')).toEqual(['update', 'PHNX-4365', '--pickup', '--delegate', 'claude']);
    expect(() => linearPickupArgv('PHNX-1; rm', 'claude')).toThrow(/not a ticket id/);
    expect(() => linearPickupArgv('PHNX-1', 'nobody')).toThrow(/not a known agent/);
  });

  it('send refuses slash commands and stays on the session channel', () => {
    expect(sendArgv('abcd1234-0000', 'please continue')).toEqual(['send', '--channel', 'session', '--to', 'abcd1234-0000', '--text', 'please continue']);
    expect(() => assertSendText('/exit')).toThrow(/slash command/);
    expect(() => assertSendText('  /clear')).toThrow(/slash command/);
  });

  it('linear reads and creates stay on the project with fixed flags', () => {
    expect(linearTasksArgv(def, 'open', 20)).toEqual(['tasks', '--project', 'proj-uuid', '--status', 'open', '--limit', '20', '--json']);
    expect(() => linearTasksArgv(def, 'all', 20)).toThrow(/--status/);
    expect(() => linearTasksArgv(def, 'open', 500)).toThrow(/--limit/);
    expect(linearViewArgv('PHNX-2')).toEqual(['tasks', 'PHNX-2', '--json']);
    expect(linearCreateArgv(def, 'New bug', 'details')).toEqual(['create', 'New bug', '--project', 'proj-uuid', '--description', 'details']);
    expect(() => linearCreateArgv({ name: 'x' }, 'T')).toThrow(/no Linear project/);
  });

  it('remember caps each note and the file', () => {
    expect(appendNote('', 'one\nline')).toBe('- one line\n');
    expect(() => appendNote('', 'x'.repeat(501))).toThrow(/at most 500/);
    const many = Array.from({ length: 70 }, (_, i) => `- n${i}`).join('\n');
    const out = appendNote(many, 'last').trim().split('\n');
    expect(out).toHaveLength(60);
    expect(out.at(-1)).toBe('- last');
  });

  it('runs only inside a Lead', () => {
    expect(() => leadToolContext({})).toThrow(/only inside a Lead/);
    expect(() => leadToolContext({ AGENTS_LEAD_PROJECT: 'nope-not-a-project' })).toThrow(/Unknown project/);
    const paths = ensureLeadDir('tools-demo');
    toolRemember({ project: 'tools-demo', def, paths }, 'PHNX-1 goes to Claude');
    expect(fs.readFileSync(paths.memory, 'utf-8')).toBe('- PHNX-1 goes to Claude\n');
  });
});
