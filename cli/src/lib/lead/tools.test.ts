import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LeadToolError, answerArgv, appendNote, assertHeldArgv, assertSendText, dispatchPrompt, editorContextLines, leadToolContext,
  linearCreateArgv, linearPickupArgv, linearTasksArgv, linearViewArgv, parseEditorContext, prArgv, runArgv, sendArgv, toolRemember,
} from './tools.js';
import { ensureLeadDir } from './paths.js';

const def = { name: 'demo', linear: { projectId: 'proj-uuid', name: 'Demo' } };

describe('Lead tool shapes', () => {
  it('dispatch and start always run headless, in edit mode, on the Lead project, with nothing else', () => {
    expect(runArgv('claude', dispatchPrompt('PHNX-1', 'Fix it'), 'demo')).toEqual(
      ['run', 'claude', 'Work on PHNX-1: Fix it', '--headless', '-P', 'demo', '--mode', 'edit']);
    const argv = runArgv('codex', 'fix it --mode skip --secrets prod -- --dangerously-skip-permissions', 'demo');
    expect(argv.slice(3)).toEqual(['--headless', '-P', 'demo', '--mode', 'edit']);
    expect(argv[2]).toBe('fix it --mode skip --secrets prod -- --dangerously-skip-permissions');
    expect(() => runArgv('codex', '--mode skip --secrets prod', 'demo')).toThrow(/starts with -/);
    expect(() => runArgv('rm -rf', 'x', 'demo')).toThrow(LeadToolError);
    expect(() => runArgv('claude', ' ', 'demo')).toThrow(/empty/);
    expect(() => runArgv('claude', '--secrets=prod fix it', 'demo')).toThrow(/starts with -/);
    expect(() => runArgv('claude', ' -x', 'demo')).toThrow(/starts with -/);
  });

  it('moves a ticket to In Progress and delegates it, for a valid ticket and agent only', () => {
    expect(linearPickupArgv('PHNX-4365', 'claude')).toEqual(['update', 'PHNX-4365', '--pickup', '--delegate', 'claude']);
    expect(() => linearPickupArgv('PHNX-1; rm', 'claude')).toThrow(/not a ticket id/);
    expect(() => linearPickupArgv('PHNX-1', 'nobody')).toThrow(/not a known agent/);
  });

  it('send types one labelled line and can never start with /, ! or #', () => {
    expect(sendArgv('abcd1234-0000', 'please continue')).toEqual(['send', '--channel', 'session', '--to', 'abcd1234-0000', '--text', '[Lead] please continue']);
    for (const bad of ['/exit', '  /clear', '!touch /tmp/pwned', ' \t!rm -rf ~', '#remember this', '\u0007!touch x']) {
      expect(() => assertSendText(bad), bad).toThrow(/starts with \/, ! or #/);
    }
    for (const bad of ['continue\n/exit', 'continue\r!touch x', 'a\u2028/exit', 'a\u0085b']) {
      expect(() => assertSendText(bad), JSON.stringify(bad)).toThrow(/one line/);
    }
    expect(assertSendText('fix it \u001b[31mnow\u0000!')).toBe('[Lead] fix it [31mnow!');
    expect(assertSendText('run the tests, then report !important')).toBe('[Lead] run the tests, then report !important');
    expect(sendArgv('abcd1234-0000', 'go')[6].startsWith('[Lead] ')).toBe(true);
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

  it('answer holds one feed answer argv, by choice id or one line of text', () => {
    expect(answerArgv('box-a/abcd1234/7', { choice: '2' })).toEqual(['feed', 'answer', 'box-a/abcd1234/7', '--choice', '2', '--json']);
    expect(answerArgv('box-a/abcd1234/7', { text: 'use the staging db' })).toEqual(['feed', 'answer', 'box-a/abcd1234/7', '--text', 'use the staging db', '--json']);
    expect(() => answerArgv('--help', { choice: '1' })).toThrow(/not an attention key/);
    expect(() => answerArgv('box-a/abcd1234', { choice: '1' })).toThrow(/not an attention key/);
    expect(() => answerArgv('box-a/abcd1234/7', { choice: '1 --as root' })).toThrow(/not a choice id/);
    expect(() => answerArgv('box-a/abcd1234/7', { text: '/exit' })).toThrow(/starts with/);
    expect(() => answerArgv('box-a/abcd1234/7', { text: 'a\nb' })).toThrow(/one line/);
  });

  it('PR actions are fixed agents projects prs argvs on the Lead project; merge is pinned and never --admin', () => {
    expect(prArgv('demo', 'merge', { repo: 'acme/demo', number: 7, sha: 'abc1234' }))
      .toEqual(['projects', 'prs', 'merge', 'demo', '--repo', 'acme/demo', '--number', '7', '--sha', 'abc1234', '--json']);
    expect(prArgv('demo', 'close', { repo: 'acme/demo', number: 7 })).toEqual(['projects', 'prs', 'close', 'demo', '--repo', 'acme/demo', '--number', '7', '--json']);
    expect(prArgv('demo', 'rerun', { repo: 'acme/demo', number: 7, runId: 99 })).toEqual(['projects', 'prs', 'rerun', 'demo', '--repo', 'acme/demo', '--run-id', '99', '--json']);
    expect(() => prArgv('demo', 'merge', { repo: 'acme/demo', number: 7 })).toThrow(/SHA/);
    expect(() => prArgv('demo', 'comment', { repo: 'acme/demo', number: 7 })).toThrow(/--body/);
    expect(() => prArgv('demo', 'close', { repo: 'acme demo', number: 7 })).toThrow(/owner\/repo/);
  });

  it('confirm re-checks the stored argv against its fixed shape and refuses anything else', () => {
    const ok = (action: Parameters<typeof assertHeldArgv>[0]['action'], argv: string[], linearArgv?: string[]) =>
      assertHeldArgv({ action, project: 'demo', argv, linearArgv });
    ok('stop', ['ps', 'stop', 'abcd1234']);
    ok('send', sendArgv('abcd1234', 'go on'));
    ok('answer', answerArgv('box-a/abcd1234/7', { choice: '1' }));
    ok('start', runArgv('claude', 'fix it', 'demo'));
    ok('dispatch', runArgv('claude', 'Work on PHNX-1: x', 'demo'), linearPickupArgv('PHNX-1', 'claude'));
    ok('pr', prArgv('demo', 'merge', { repo: 'acme/demo', number: 7, sha: 'abc1234' }));
    expect(() => ok('stop', ['ps', 'stop', '--all'])).toThrow(LeadToolError);
    expect(() => ok('send', ['send', '--channel', 'session', '--to', 'abcd1234', '--text', '/exit'])).toThrow(/label/);
    expect(() => ok('start', [...runArgv('claude', 'x', 'demo').slice(0, -1), 'skip'])).toThrow(/fixed shapes/);
    expect(() => ok('start', runArgv('claude', 'x', 'other'))).toThrow(/fixed shapes/);
    expect(() => ok('pr', [...prArgv('demo', 'merge', { repo: 'acme/demo', number: 7, sha: 'abc1234' }), '--admin'])).toThrow(/fixed shapes/);
    expect(() => ok('pr', ['projects', 'prs', 'review', 'demo', '--repo', 'acme/demo', '--number', '7', '--json'])).toThrow(/not a PR action/);
    expect(() => ok('dispatch', runArgv('claude', 'x', 'demo'))).toThrow(/pickup/);
    expect(() => ok('send', sendArgv('abcd1234', 'go'), linearPickupArgv('PHNX-1', 'claude'))).toThrow(/pickup/);
  });

  it('editor context is a validated JSON object rendered as a short block', () => {
    const ctx = parseEditorContext('{"front":{"sessionId":"abcd1234-0000-4000-8000-000000000001","title":"Fix\\nlogin","tab":10},"tabs":[{"sessionId":"ffff0000-1","title":"Docs","tab":1},{"tab":2}]}');
    expect(editorContextLines(ctx)).toEqual([
      'Front tab (what "this one" means): tab 10 “Fix login” (session abcd1234)',
      'Open tabs: tab 1 “Docs” (session ffff0000); tab 2',
    ]);
    expect(() => parseEditorContext('front=3')).toThrow(/JSON object/);
    expect(() => parseEditorContext('[1]')).toThrow(/JSON object/);
    expect(() => parseEditorContext('{"front":{"tab":-1}}')).toThrow(/positive integer/);
    expect(() => parseEditorContext('{"front":{"sessionId":"a b"}}')).toThrow(/session id/);
    expect(() => parseEditorContext('{"cmd":"rm"}')).toThrow(/unknown field 'cmd'/);
    expect(() => parseEditorContext('{"tabs":{}}')).toThrow(/array/);
  });
});
