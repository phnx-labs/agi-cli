import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as os from 'os';

// Mock HOME for normalizeForDedup tests
const ORIG_HOME = process.env.HOME;

import {
  unwrapCommand,
  normalizeForDedup,
  bucketKey,
  relativeToCwd,
  linkPath,
  collapseRetries,
  computeSummaryStats,
  renderSummaryHeader,
  renderSummary,
  filterEvents,
  parseRoleList,
  renderConversationMarkdown,
  renderJson,
} from '@phnx-labs/sessions-cli/reader';
import type { SessionEvent } from '@phnx-labs/sessions-cli/reader';

// ── filterEvents ──────────────────────────────────────────────────────────────

describe('filterEvents', () => {
  const events: SessionEvent[] = [
    { type: 'message', agent: 'claude', timestamp: '2024-01-01T00:00:00Z', role: 'user', content: 'Hello' },
    { type: 'message', agent: 'claude', timestamp: '2024-01-01T00:00:01Z', role: 'assistant', content: 'Hi there' },
    { type: 'thinking', agent: 'claude', timestamp: '2024-01-01T00:00:02Z', content: 'Let me think' },
    { type: 'tool_use', agent: 'claude', timestamp: '2024-01-01T00:00:03Z', tool: 'Read', args: {} },
    { type: 'tool_result', agent: 'claude', timestamp: '2024-01-01T00:00:04Z', content: 'file contents' },
    { type: 'error', agent: 'claude', timestamp: '2024-01-01T00:00:05Z', content: 'fail' },
  ];

  it('include: keeps only whitelisted roles', () => {
    const result = filterEvents(events, { include: ['user'] });
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
  });

  it('include: supports multiple roles', () => {
    const result = filterEvents(events, { include: ['user', 'assistant'] });
    expect(result).toHaveLength(2);
    expect(result.every(e => e.type === 'message')).toBe(true);
  });

  it('include: tools captures both tool_use and tool_result', () => {
    const result = filterEvents(events, { include: ['tools'] });
    expect(result).toHaveLength(2);
    expect(result.every(e => e.type === 'tool_use' || e.type === 'tool_result')).toBe(true);
  });

  it('exclude: drops listed roles, keeps non-role events', () => {
    // error has no role, so it stays.
    const result = filterEvents(events, { exclude: ['thinking', 'tools'] });
    expect(result.some(e => e.type === 'message' && e.role === 'user')).toBe(true);
    expect(result.some(e => e.type === 'message' && e.role === 'assistant')).toBe(true);
    expect(result.some(e => e.type === 'error')).toBe(true);
    expect(result.every(e => e.type !== 'thinking' && e.type !== 'tool_use' && e.type !== 'tool_result')).toBe(true);
  });

  it('throws when include and exclude are both passed', () => {
    expect(() => filterEvents(events, { include: ['user'], exclude: ['tools'] })).toThrow(/mutually exclusive/);
  });

  it('first: keeps events up to the Nth user turn', () => {
    const twoTurns: SessionEvent[] = [
      { type: 'message', agent: 'claude', timestamp: 't0', role: 'user', content: 'q1' },
      { type: 'message', agent: 'claude', timestamp: 't1', role: 'assistant', content: 'a1' },
      { type: 'message', agent: 'claude', timestamp: 't2', role: 'user', content: 'q2' },
      { type: 'message', agent: 'claude', timestamp: 't3', role: 'assistant', content: 'a2' },
    ];
    const result = filterEvents(twoTurns, { first: 1 });
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('q1');
    expect(result[1].content).toBe('a1');
  });

  it('last: keeps events from the start of the (M-N+1)th user turn', () => {
    const twoTurns: SessionEvent[] = [
      { type: 'message', agent: 'claude', timestamp: 't0', role: 'user', content: 'q1' },
      { type: 'message', agent: 'claude', timestamp: 't1', role: 'assistant', content: 'a1' },
      { type: 'message', agent: 'claude', timestamp: 't2', role: 'user', content: 'q2' },
      { type: 'message', agent: 'claude', timestamp: 't3', role: 'assistant', content: 'a2' },
    ];
    const result = filterEvents(twoTurns, { last: 1 });
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('q2');
    expect(result[1].content).toBe('a2');
  });

  it('first with N >= total turns returns all events', () => {
    const result = filterEvents(events, { first: 100 });
    expect(result).toHaveLength(events.length);
  });

  it('throws when first and last are both passed', () => {
    expect(() => filterEvents(events, { first: 1, last: 1 })).toThrow(/mutually exclusive/);
  });

  it('turn slice and role filter compose: last 1 turn, user only', () => {
    const twoTurns: SessionEvent[] = [
      { type: 'message', agent: 'claude', timestamp: 't0', role: 'user', content: 'q1' },
      { type: 'message', agent: 'claude', timestamp: 't1', role: 'assistant', content: 'a1' },
      { type: 'message', agent: 'claude', timestamp: 't2', role: 'user', content: 'q2' },
      { type: 'message', agent: 'claude', timestamp: 't3', role: 'assistant', content: 'a2' },
    ];
    const result = filterEvents(twoTurns, { last: 1, include: ['user'] });
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('q2');
  });

  it('no filters is a passthrough', () => {
    const result = filterEvents(events, {});
    expect(result).toEqual(events);
  });
});

// ── parseRoleList ─────────────────────────────────────────────────────────────

describe('parseRoleList', () => {
  it('parses a comma-separated list', () => {
    expect(parseRoleList('user,assistant', '--include')).toEqual(['user', 'assistant']);
  });

  it('trims whitespace', () => {
    expect(parseRoleList(' user , thinking ', '--exclude')).toEqual(['user', 'thinking']);
  });

  it('rejects unknown roles with the flag name', () => {
    expect(() => parseRoleList('user,foo', '--include')).toThrow(/"foo" for --include/);
    expect(() => parseRoleList('user,foo', '--include')).toThrow(/user, assistant, thinking, tools/);
  });

  it('rejects empty input', () => {
    expect(() => parseRoleList('', '--include')).toThrow(/at least one role/);
  });
});

// ── renderConversationMarkdown ────────────────────────────────────────────────

describe('renderConversationMarkdown', () => {
  it('includes user, assistant, requested reasoning, and tool calls in event order', () => {
    const events: SessionEvent[] = [
      { type: 'message', agent: 'claude', timestamp: 't0', role: 'user', content: 'Read foo.ts' },
      { type: 'thinking', agent: 'claude', timestamp: 't1', content: 'I should open the file first.' },
      { type: 'message', agent: 'claude', timestamp: 't2', role: 'assistant', content: 'Reading now.' },
      { type: 'tool_use', agent: 'claude', timestamp: 't3', tool: 'Read', args: { file_path: '/x/foo.ts' }, path: '/x/foo.ts' },
    ];
    const out = renderConversationMarkdown(events, { reasoning: 'include' });
    expect(out).toContain('## User');
    expect(out).toContain('Read foo.ts');
    expect(out).toContain('### Reasoning');
    expect(out).toContain('I should open the file first.');
    expect(out).toContain('## Assistant');
    expect(out).toContain('Reading now.');
    expect(out).toContain('### Tool: Read');
    expect(out).toContain('/x/foo.ts');
    // Order: user before thinking before assistant before tool
    const userIdx = out.indexOf('## User');
    const thinkIdx = out.indexOf('### Reasoning');
    const asstIdx = out.indexOf('## Assistant');
    const toolIdx = out.indexOf('### Tool: Read');
    expect(userIdx).toBeLessThan(thinkIdx);
    expect(thinkIdx).toBeLessThan(asstIdx);
    expect(asstIdx).toBeLessThan(toolIdx);
  });

  it('can omit or fold reasoning explicitly', () => {
    const events: SessionEvent[] = [
      { type: 'thinking', agent: 'claude', timestamp: 't0', content: 'private reasoning' },
    ];
    expect(renderConversationMarkdown(events, { reasoning: 'omit' })).not.toContain('private reasoning');
    expect(renderConversationMarkdown(events, { reasoning: 'fold' })).toContain('<summary>Reasoning</summary>');
  });

  it('shows full tool args and names truncated output explicitly', () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: 't0', tool: 'Read', args: { path: '/tmp/file.ts', limit: 5 } },
      { type: 'tool_result', agent: 'claude', timestamp: 't1', tool: 'Read', output: 'abcdefghij' },
    ];
    const out = renderConversationMarkdown(events, { maxToolOutputChars: 5 });
    expect(out).toContain('"limit": 5');
    expect(out).toContain('Tool Result: Read');
    expect(out).toContain('[Output truncated: 5 characters omitted.]');
  });

  it('renders bash commands inside a code fence', () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: 't0', tool: 'Bash', args: { command: 'ls -la' }, command: 'ls -la' },
    ];
    const out = renderConversationMarkdown(events);
    expect(out).toContain('```bash');
    expect(out).toContain('ls -la');
  });

  it('redacts AWS keys from tool result content by default', () => {
    const events: SessionEvent[] = [
      { type: 'tool_result', agent: 'claude', timestamp: 't0', content: 'key ' + 'AKIA' + '1234567890ABCDEF' },
    ];
    const out = renderConversationMarkdown(events);
    expect(out).toContain('[REDACTED_AWS_KEY]');
    expect(out).not.toContain('AKIA1234567890ABCDEF');
  });

  it('redacts env token assignments in tool commands but leaves the command', () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: 't0', tool: 'Bash', args: {}, command: 'TOKEN=abc123 deploy' },
    ];
    const out = renderConversationMarkdown(events);
    expect(out).toContain('TOKEN=[REDACTED] deploy');
    expect(out).not.toContain('TOKEN=abc123');
  });

  it('redacts secrets echoed in user, assistant, thinking, and error blocks by default', () => {
    const token = 'sk-' + 'a'.repeat(40);
    const events: SessionEvent[] = [
      { type: 'message', agent: 'claude', timestamp: 't0', role: 'user', content: `here is my key ${token}` },
      { type: 'message', agent: 'claude', timestamp: 't1', role: 'assistant', content: `your key ${token} is noted` },
      { type: 'thinking', agent: 'claude', timestamp: 't2', content: `mulling over ${token}` },
      { type: 'error', agent: 'claude', timestamp: 't3', content: `failed with ${token}` },
    ];
    const out = renderConversationMarkdown(events);
    expect(out).not.toContain(token);
    expect(out).toContain('[REDACTED_API_KEY]');
  });

  it('can render markdown without redaction when explicitly requested', () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: 't0', tool: 'Bash', args: {}, command: 'TOKEN=abc123 deploy' },
    ];
    const out = renderConversationMarkdown(events, { redact: false });
    expect(out).toContain('TOKEN=abc123 deploy');
  });
});

// ── renderJson redaction ──────────────────────────────────────────────────────
// The JSON path is the one an agent scripts against, so it must not be the
// output format that leaks credentials. It redacts by default.

describe('renderJson redaction', () => {
  const token = 'sk-' + 'a'.repeat(40);
  const awsKey = 'AKIA' + '1234567890ABCDEF';

  it('redacts secrets in content, command, and output by default', () => {
    const events: SessionEvent[] = [
      { type: 'message', agent: 'claude', timestamp: 't0', role: 'user', content: `my key ${token}` },
      { type: 'tool_use', agent: 'claude', timestamp: 't1', tool: 'Bash', args: {}, command: 'TOKEN=abc123 deploy' },
      { type: 'tool_result', agent: 'claude', timestamp: 't2', content: `leaked ${awsKey}`, output: `also ${token}` },
    ];
    const out = renderJson(events);
    expect(out).not.toContain(token);
    expect(out).not.toContain('AKIA1234567890ABCDEF');
    expect(out).not.toContain('TOKEN=abc123');
    expect(out).toContain('[REDACTED_API_KEY]');
    expect(out).toContain('[REDACTED_AWS_KEY]');
  });

  it('redacts secrets nested inside tool_use args — the JSON-only leak vector', () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: 't0', tool: 'Http', args: { headers: { authorization: `Bearer ${token}` }, tries: [{ key: token }] } },
    ];
    const out = renderJson(events);
    expect(out).not.toContain(token);
    expect(out).toContain('[REDACTED_API_KEY]');
    // structure is preserved, only the secret substring is masked
    const parsed = JSON.parse(out);
    expect(parsed[0].args.headers.authorization).toContain('Bearer');
    expect(Array.isArray(parsed[0].args.tries)).toBe(true);
  });

  it('leaves secrets intact when redaction is explicitly disabled', () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: 't0', tool: 'Bash', args: { token }, command: 'TOKEN=abc123 deploy' },
    ];
    const out = renderJson(events, undefined, { redact: false });
    expect(out).toContain('TOKEN=abc123 deploy');
    expect(out).toContain(token);
  });

  it('wraps events under output.session/events when meta is provided', () => {
    const events: SessionEvent[] = [
      { type: 'message', agent: 'claude', timestamp: 't0', role: 'user', content: `key ${token}` },
    ];
    const out = renderJson(events, { agent: 'claude', timestamp: 't0' } as any);
    const parsed = JSON.parse(out);
    expect(parsed.session.agent).toBe('claude');
    expect(parsed.events[0].content).not.toContain(token);
  });

  it('redacts free-text meta fields (topic/plan) — a first-message excerpt leaks otherwise', () => {
    const events: SessionEvent[] = [
      { type: 'message', agent: 'claude', timestamp: 't0', role: 'user', content: `use ${awsKey}` },
    ];
    const meta = { agent: 'claude', timestamp: 't0', topic: `use ${awsKey} now`, plan: `step: token ${token}` } as any;
    const out = renderJson(events, meta);
    expect(out).not.toContain(awsKey);
    expect(out).not.toContain(token);
    const parsed = JSON.parse(out);
    expect(parsed.session.topic).toContain('[REDACTED_AWS_KEY]');
    expect(parsed.session.plan).toContain('[REDACTED_API_KEY]');
  });
});

// ── unwrapCommand ─────────────────────────────────────────────────────────────

describe('unwrapCommand', () => {
  it('returns bare command unchanged', () => {
    expect(unwrapCommand('ls -la')).toBe('ls -la');
  });

  it('unwraps ssh with double-quoted payload', () => {
    expect(unwrapCommand('ssh host "ls -la"')).toBe('ls -la');
  });

  it('unwraps ssh with quoted payload plus pipe (pipe is stripped)', () => {
    // ls is not a wrapper so recursion stops there; pipe after closing quote is stripped
    expect(unwrapCommand('ssh host "ls -la" | cat')).toBe('ls -la');
  });

  it('unwraps sudo prefix', () => {
    expect(unwrapCommand('sudo bun install')).toBe('bun install');
  });

  it('unwraps cd && prefix', () => {
    expect(unwrapCommand('cd /tmp && ls')).toBe('ls');
  });

  it('keeps bun run intact (two-level bucketKey handles it)', () => {
    expect(unwrapCommand('bun run build')).toBe('bun run build');
  });

  it('unwraps npx prefix', () => {
    expect(unwrapCommand('npx tsc --noEmit')).toBe('tsc --noEmit');
  });

  it('unwraps shell env prefix', () => {
    expect(unwrapCommand('BENCH_MODE=full npx tsx bench/x.ts')).toBe('tsx bench/x.ts');
    expect(unwrapCommand('FOO=bar BAR=baz cargo build')).toBe('cargo build');
  });

  it('unwraps ssh with env-prefixed inner command', () => {
    expect(unwrapCommand('ssh host "PATH=/opt/bin:$PATH openclaw browser profiles"')).toBe('openclaw browser profiles');
  });

  it('unwraps nested: ssh + sudo', () => {
    expect(unwrapCommand('ssh host "sudo tsc --noEmit"')).toBe('tsc --noEmit');
  });

  it('unwraps time prefix', () => {
    expect(unwrapCommand('time cargo build')).toBe('cargo build');
  });
});

// ── normalizeForDedup ─────────────────────────────────────────────────────────

describe('normalizeForDedup', () => {
  beforeEach(() => {
    process.env.HOME = '/home/user';
  });
  afterEach(() => {
    process.env.HOME = ORIG_HOME;
  });

  it('strips short flags', () => {
    expect(normalizeForDedup('ls -lh /tmp')).toBe('ls /tmp');
  });

  it('strips long flags', () => {
    expect(normalizeForDedup('git --no-pager log')).toBe('git log');
  });

  it('strips long flags with value', () => {
    expect(normalizeForDedup('git log --format=oneline')).toBe('git log');
  });

  it('strips trailing pipe to head', () => {
    expect(normalizeForDedup('ls /tmp | head -20')).toBe('ls /tmp');
  });

  it('strips trailing pipe to wc', () => {
    expect(normalizeForDedup('ls /tmp | wc -l')).toBe('ls /tmp');
  });

  it('strips 2>&1', () => {
    expect(normalizeForDedup('ls /tmp 2>&1')).toBe('ls /tmp');
  });

  it('strips ; echo done suffix', () => {
    expect(normalizeForDedup('bun test; echo done')).toBe('bun test');
  });

  it('replaces leading $HOME with ~ when command starts with home path', () => {
    // The ^ anchor replaces only when the string begins with $HOME
    expect(normalizeForDedup('/home/user/.agents/run.sh')).toBe('~/.agents/run.sh');
  });

  it('collapses ls -lh + ls -la + ls 2>&1 to same key', () => {
    const a = normalizeForDedup('ls -lh /home/user/sessions/ | head');
    const b = normalizeForDedup('ls -la /home/user/sessions/');
    const c = normalizeForDedup('ls /home/user/sessions/ 2>&1');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

// ── bucketKey ─────────────────────────────────────────────────────────────────

describe('bucketKey', () => {
  it('returns two-level key for git', () => {
    expect(bucketKey('git status')).toBe('git status');
    expect(bucketKey('git diff HEAD')).toBe('git diff');
  });

  it('returns two-level key for gh', () => {
    expect(bucketKey('gh pr view 123')).toBe('gh pr');
  });

  it('returns two-level key for bun', () => {
    expect(bucketKey('bun test --watch')).toBe('bun test');
  });

  it('returns two-level key for cargo', () => {
    expect(bucketKey('cargo build --release')).toBe('cargo build');
  });

  it('returns single-token key for ls', () => {
    expect(bucketKey('ls -la')).toBe('ls');
  });

  it('returns single-token key for grep', () => {
    expect(bucketKey('grep -r pattern .')).toBe('grep');
  });

  it('returns ssh→CMD prefix for ssh-wrapped commands', () => {
    expect(bucketKey('ssh host "ls -la"')).toBe('ssh\u2192ls');
  });

  it('returns ssh→two-level for ssh-wrapped openclaw', () => {
    expect(bucketKey('ssh host "openclaw browser profiles"')).toBe('ssh\u2192openclaw browser');
  });

  it('returns ssh→git status for ssh-wrapped git', () => {
    expect(bucketKey('ssh host "git status"')).toBe('ssh\u2192git status');
  });

  it('canonicalizes an aliased executable to its registry name', () => {
    // `python3` is an alias of `python`; bucketing groups them under `python`.
    expect(bucketKey('python3 bench.py')).toBe('python');
  });

  it('returns the raw token for genuinely unknown commands', () => {
    expect(bucketKey('./something-weird')).toBe('something-weird');
  });
});

// ── Category routing ──────────────────────────────────────────────────────────

describe('category routing (via renderSummary commands section)', () => {
  function buildBashEvents(cmds: string[]): SessionEvent[] {
    return cmds.map((cmd, i) => ({
      type: 'tool_use' as const,
      agent: 'claude' as const,
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
      tool: 'Bash',
      args: { command: cmd },
      command: cmd,
    }));
  }

  it('includes Build/test bucket for bun commands', () => {
    const events = buildBashEvents(['bun run build', 'bun test']);
    const out = renderSummary(events);
    expect(out).toContain('Build/test');
  });

  it('includes VCS bucket for git commands', () => {
    const events = buildBashEvents(['git status', 'git diff']);
    const out = renderSummary(events);
    expect(out).toContain('VCS');
  });

  it('includes Remote bucket for ssh commands', () => {
    const events = buildBashEvents(['ssh host "ls"']);
    const out = renderSummary(events);
    expect(out).toContain('Remote');
  });

  it('Probes bucket uses low signal (inline list, not expanded)', () => {
    const events = buildBashEvents(['ls /tmp', 'cat file.txt', 'head -n 5 file.txt']);
    const out = renderSummary(events);
    expect(out).toContain('Probes');
    // Low signal: should show inline dash-separated list, not individual lines
    expect(out).toMatch(/Probes.*—/);
  });

  it('Other bucket catches uncategorized tokens', () => {
    const events = buildBashEvents(['python3 bench.py', 'ruby script.rb']);
    const out = renderSummary(events);
    expect(out).toContain('Other');
  });

  it('Wait bucket for sleep commands', () => {
    const events = buildBashEvents(['sleep 30', 'sleep 10']);
    const out = renderSummary(events);
    expect(out).toContain('Wait');
    // Low signal — inline
    expect(out).toMatch(/Wait.*—/);
  });
});

// ── collapseRetries ───────────────────────────────────────────────────────────

describe('collapseRetries', () => {
  const base = Date.now();

  it('collapses 3 identical commands within 60s to one entry', () => {
    const cmds = [
      { cmd: 'bun test', ts: base },
      { cmd: 'bun test', ts: base + 10_000 },
      { cmd: 'bun test', ts: base + 20_000 },
    ];
    const result = collapseRetries(cmds);
    expect(result).toHaveLength(1);
    expect(result[0].count).toBe(3);
  });

  it('keeps 2 identical commands within 60s as separate entries', () => {
    const cmds = [
      { cmd: 'bun test', ts: base },
      { cmd: 'bun test', ts: base + 10_000 },
    ];
    const result = collapseRetries(cmds);
    expect(result).toHaveLength(2);
    expect(result[0].count).toBe(1);
    expect(result[1].count).toBe(1);
  });

  it('keeps invocations >60s apart as separate entries', () => {
    const cmds = [
      { cmd: 'bun test', ts: base },
      { cmd: 'bun test', ts: base + 10_000 },
      { cmd: 'bun test', ts: base + 90_000 }, // >60s gap
    ];
    const result = collapseRetries(cmds);
    // First two: within 60s but count=2, expanded back to 2
    // Third: new group
    expect(result.some(r => r.count === 1)).toBe(true);
  });

  it('collapses flag-variant commands that normalize to same key', () => {
    const cmds = [
      { cmd: 'ls -la /tmp', ts: base },
      { cmd: 'ls -lh /tmp', ts: base + 5_000 },
      { cmd: 'ls /tmp 2>&1', ts: base + 10_000 },
    ];
    const result = collapseRetries(cmds);
    expect(result).toHaveLength(1);
    expect(result[0].count).toBe(3);
  });
});

// ── relativeToCwd ─────────────────────────────────────────────────────────────

describe('relativeToCwd', () => {
  beforeEach(() => { process.env.HOME = '/home/user'; });
  afterEach(() => { process.env.HOME = ORIG_HOME; });

  it('returns cwd-relative path when inside cwd', () => {
    expect(relativeToCwd('/home/user/project/src/index.ts', '/home/user/project')).toBe('src/index.ts');
  });

  it('returns . when path equals cwd', () => {
    expect(relativeToCwd('/home/user/project', '/home/user/project')).toBe('.');
  });

  it('returns home-relative path when outside cwd', () => {
    expect(relativeToCwd('/home/user/.claude/settings.json', '/home/user/project')).toBe('~/.claude/settings.json');
  });

  it('returns absolute path when outside both cwd and home', () => {
    expect(relativeToCwd('/etc/hosts', '/home/user/project')).toBe('/etc/hosts');
  });

  it('works without cwd (falls back to home-relative)', () => {
    expect(relativeToCwd('/home/user/foo.ts')).toBe('~/foo.ts');
  });
});

// ── linkPath ──────────────────────────────────────────────────────────────────

describe('linkPath', () => {
  it('returns plain label when stdout is not TTY', () => {
    const origIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const result = linkPath('/some/path', 'label');
    expect(result).toBe('label');
    Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
  });

  it('emits OSC 8 sequence when TTY env is set', () => {
    const origIsTTY = process.stdout.isTTY;
    const origTermProgram = process.env.TERM_PROGRAM;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    process.env.TERM_PROGRAM = 'iTerm.app';

    const result = linkPath('/some/path', 'label');
    expect(result).toContain('\x1b]8;;file:///some/path\x1b\\');
    expect(result).toContain('label');
    expect(result).toContain('\x1b]8;;\x1b\\');

    Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
    if (origTermProgram === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = origTermProgram;
  });
});

// ── computeSummaryStats ───────────────────────────────────────────────────────

describe('computeSummaryStats', () => {
  it('counts user/assistant turns, tools, errors', () => {
    const events: SessionEvent[] = [
      { type: 'message', agent: 'claude', timestamp: '2024-01-01T00:00:00Z', role: 'user', content: 'hi' },
      { type: 'tool_use', agent: 'claude', timestamp: '2024-01-01T00:00:01Z', tool: 'Read', args: {} },
      { type: 'message', agent: 'claude', timestamp: '2024-01-01T00:00:02Z', role: 'assistant', content: 'done' },
      { type: 'error', agent: 'claude', timestamp: '2024-01-01T00:00:03Z', content: 'fail' },
    ];
    const stats = computeSummaryStats(events);
    expect(stats.userTurns).toBe(1);
    expect(stats.assistantTurns).toBe(1);
    expect(stats.toolCount).toBe(1);
    expect(stats.errorCount).toBe(1);
  });

  it('sums token counts from usage events', () => {
    const events: SessionEvent[] = [
      {
        type: 'usage', agent: 'claude', timestamp: '2024-01-01T00:00:00Z',
        model: 'claude-opus-4-7-20251001',
        outputTokens: 1000, cacheReadTokens: 50000,
      },
      {
        type: 'usage', agent: 'claude', timestamp: '2024-01-01T00:00:01Z',
        model: 'claude-opus-4-7-20251001',
        outputTokens: 500, cacheReadTokens: 10000,
      },
    ];
    const stats = computeSummaryStats(events);
    expect(stats.outputTokens).toBe(1500);
    expect(stats.cacheReadTokens).toBe(60000);
    expect(stats.models).toEqual(['opus-4-7']);
  });

  it('skips local tool_use events in tool count', () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: '2024-01-01T00:00:00Z', tool: 'Bash', args: {}, _local: true },
    ];
    const stats = computeSummaryStats(events);
    expect(stats.toolCount).toBe(0);
  });
});

// ── renderSummaryHeader ───────────────────────────────────────────────────────

describe('renderSummaryHeader', () => {
  it('formats turn/tool/token/duration stats', () => {
    const stats = {
      models: ['opus-4-7'],
      userTurns: 10,
      assistantTurns: 10,
      toolCount: 50,
      toolCounts: { Edit: 30, Bash: 20 },
      errorCount: 2,
      outputTokens: 361_000,
      cacheReadTokens: 67_500_000,
      firstTs: 0,
      lastTs: 12 * 60_000,
    };
    const out = renderSummaryHeader(stats);
    expect(out).toContain('20 turns');
    expect(out).toContain('50 tools');
    expect(out).toContain('2 errors');
    expect(out).toContain('67.5M cached');
    expect(out).toContain('361K out');
    expect(out).toContain('12 min');
  });

  it('omits token section when no tokens recorded', () => {
    const stats = {
      models: [],
      userTurns: 5,
      assistantTurns: 5,
      toolCount: 0,
      toolCounts: {},
      errorCount: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      firstTs: 0,
      lastTs: 0,
    };
    const out = renderSummaryHeader(stats);
    expect(out).not.toContain('cached');
    expect(out).not.toContain('out');
  });
});

// ── renderSummary integration ─────────────────────────────────────────────────

describe('renderSummary', () => {
  function makeEvent(overrides: Partial<SessionEvent>): SessionEvent {
    return {
      type: 'message',
      agent: 'claude',
      timestamp: '2024-01-01T00:00:00Z',
      ...overrides,
    };
  }

  it('dedupes Read vs Modified: modified file not in read count', () => {
    const events: SessionEvent[] = [
      makeEvent({ type: 'tool_use', tool: 'Read', args: { file_path: '/project/src/a.ts' }, path: '/project/src/a.ts' }),
      makeEvent({ type: 'tool_use', tool: 'Edit', args: { file_path: '/project/src/a.ts' }, path: '/project/src/a.ts' }),
    ];
    const out = renderSummary(events, '/project');
    // a.ts should appear in Changes (modified), not in Read
    expect(out).toContain('Changes');
    // The Read section should not appear since the only read file was also modified
    // (and would be deduped out, leaving 0 read-only files)
    const readMatch = out.match(/Read\s+\((\d+)\)/);
    if (readMatch) {
      expect(parseInt(readMatch[1])).toBe(0);
    }
  });

  it('renders final message up to 3000 chars', () => {
    const longMsg = 'x'.repeat(4000);
    const events: SessionEvent[] = [
      makeEvent({ role: 'assistant', content: longMsg }),
    ];
    const out = renderSummary(events);
    expect(out).toContain('x'.repeat(100));
    // Should truncate at 3000
    expect(out.indexOf('...')).toBeGreaterThan(0);
    expect(out.indexOf('x'.repeat(3001))).toBe(-1);
  });

  it('renders prompt without 300-char cap', () => {
    const longPrompt = 'Implement a feature that '.repeat(20); // >300 chars
    const events: SessionEvent[] = [
      makeEvent({ role: 'user', content: longPrompt }),
    ];
    const out = renderSummary(events);
    // Should not be truncated at 300 chars
    expect(out.length).toBeGreaterThan(300);
    // Should not contain '...' from truncation
    const promptSection = out.split('\n').find(l => l.includes('Prompt:'));
    expect(promptSection).toBeTruthy();
    expect(promptSection?.endsWith('...')).toBe(false);
  });

  it('shows attachment count line for image blocks', () => {
    const events: SessionEvent[] = [
      makeEvent({ type: 'attachment', mediaType: 'image/png', sizeBytes: 1024 }),
      makeEvent({ type: 'attachment', mediaType: 'image/jpeg', sizeBytes: 2048 }),
    ];
    const out = renderSummary(events);
    expect(out).toContain('2 screenshot');
    expect(out).toContain('image/png');
    expect(out).toContain('image/jpeg');
  });

  it('shows TodoWrite items in Plan section', () => {
    const events: SessionEvent[] = [
      makeEvent({
        type: 'tool_use',
        tool: 'TodoWrite',
        args: {
          todos: [
            { content: 'Write tests', status: 'pending' },
            { content: 'Build project', status: 'pending' },
          ],
        },
      }),
    ];
    const out = renderSummary(events);
    expect(out).toContain('Plan');
    expect(out).toContain('Write tests');
    expect(out).toContain('Build project');
  });

  it('shows subagent spawns in Subagents section', () => {
    const events: SessionEvent[] = [
      makeEvent({
        type: 'tool_use',
        tool: 'Agent',
        args: {
          description: 'Explore the codebase',
          subagent_type: 'Explore',
        },
      }),
    ];
    const out = renderSummary(events);
    expect(out).toContain('Subagents');
    expect(out).toContain('Explore the codebase');
    expect(out).toContain('Explore');
  });

  it('shows error count and first failing tool', () => {
    const events: SessionEvent[] = [
      makeEvent({ type: 'error', tool: 'Bash', args: { command: 'bun test' }, content: 'exit 1' }),
      makeEvent({ type: 'error', tool: 'Bash', args: { command: 'bun build' }, content: 'exit 1' }),
    ];
    const out = renderSummary(events);
    expect(out).toContain('2 failure');
    expect(out).toContain('Bash');
  });

  it('separates external edits (outside cwd) from in-project Changes', () => {
    const events: SessionEvent[] = [
      makeEvent({ type: 'tool_use', tool: 'Edit', args: { file_path: '/project/src/a.ts' }, path: '/project/src/a.ts' }),
      makeEvent({ type: 'tool_use', tool: 'Edit', args: { file_path: '/tmp/scratch.md' }, path: '/tmp/scratch.md' }),
    ];
    const out = renderSummary(events, '/project');
    expect(out).toContain('Changes');
    expect(out).toContain('src/a.ts');
    expect(out).toContain('External edits');
    expect(out).toContain('/tmp/scratch.md');
  });

  it('surfaces TaskCreate descriptions in Plan section', () => {
    const events: SessionEvent[] = [
      makeEvent({ type: 'tool_use', tool: 'TaskCreate', args: { description: 'Build benchmark harness', prompt: '...' } }),
      makeEvent({ type: 'tool_use', tool: 'TaskCreate', args: { description: 'Migrate to FTS5 index' } }),
    ];
    const out = renderSummary(events);
    expect(out).toContain('Plan');
    expect(out).toContain('Build benchmark harness');
    expect(out).toContain('Migrate to FTS5 index');
  });

  it('uses cwd-relative paths in Changes section', () => {
    const events: SessionEvent[] = [
      makeEvent({ type: 'tool_use', tool: 'Edit', args: { file_path: '/project/src/lib/render.ts' }, path: '/project/src/lib/render.ts' }),
    ];
    const out = renderSummary(events, '/project');
    expect(out).toContain('src/lib/render.ts');
    expect(out).not.toContain('/project/src/lib/render.ts');
  });

  // ── Recent Activity & section ordering ──────────────────────────────────────
  // These cover the lineage fix: temporally-near events appear in a chronological
  // tail at the top, and Errors live above Modified/Read/Commands rather than at
  // the bottom (where they used to look misleadingly recent).

  it('renders Recent Activity as the first content section', () => {
    const events: SessionEvent[] = [
      makeEvent({ role: 'user', content: 'do the thing' }),
      makeEvent({ type: 'tool_use', tool: 'Edit', args: { file_path: '/p/src/a.ts' }, path: '/p/src/a.ts' }),
      makeEvent({ type: 'tool_use', tool: 'Bash', command: 'bun test' }),
    ];
    const out = renderSummary(events, '/p');
    const promptIdx = out.indexOf('Prompt:');
    const recentIdx = out.indexOf('Recent Activity');
    const modifiedIdx = out.indexOf('Changes');
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    expect(recentIdx).toBeGreaterThan(promptIdx);
    expect(modifiedIdx).toBeGreaterThan(recentIdx);
  });

  it('Recent Activity shows only the last 7 items in chronological order', () => {
    const events: SessionEvent[] = [];
    for (let i = 0; i < 10; i++) {
      events.push(makeEvent({ type: 'tool_use', tool: 'Bash', command: `cmd-${i}`, timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}Z` }));
    }
    const out = renderSummary(events);
    expect(out).toContain('Recent Activity');
    expect(out).toContain('last 7 of 10');
    const recentBlock = out.slice(out.indexOf('Recent Activity'), out.indexOf('Commands'));
    // First 3 commands shouldn't appear in the chronological tail
    expect(recentBlock).not.toContain('cmd-0');
    expect(recentBlock).not.toContain('cmd-1');
    expect(recentBlock).not.toContain('cmd-2');
    // Last 7 should appear, in order: cmd-3 before cmd-9
    const idx3 = recentBlock.indexOf('cmd-3');
    const idx9 = recentBlock.indexOf('cmd-9');
    expect(idx3).toBeGreaterThan(-1);
    expect(idx9).toBeGreaterThan(idx3);
  });

  it('Recent Activity mixes edits, commands, agents, errors, and messages', () => {
    const events: SessionEvent[] = [
      makeEvent({ type: 'tool_use', tool: 'Edit', args: { file_path: '/p/a.ts' }, path: '/p/a.ts', timestamp: '2024-01-01T00:00:01Z' }),
      makeEvent({ type: 'tool_use', tool: 'Bash', command: 'echo hi', timestamp: '2024-01-01T00:00:02Z' }),
      makeEvent({ type: 'tool_use', tool: 'Agent', args: { description: 'Explore the repo', subagent_type: 'Explore' }, timestamp: '2024-01-01T00:00:03Z' }),
      makeEvent({ type: 'error', tool: 'Bash', args: { command: 'broken' }, content: 'exit 1', timestamp: '2024-01-01T00:00:04Z' }),
      makeEvent({ role: 'assistant', content: 'all done now', timestamp: '2024-01-01T00:00:05Z' }),
    ];
    const out = renderSummary(events, '/p');
    const recentBlock = out.slice(out.indexOf('Recent Activity'), out.indexOf('Changes'));
    expect(recentBlock).toContain('Edit');
    expect(recentBlock).toContain('a.ts');
    expect(recentBlock).toContain('Bash');
    expect(recentBlock).toContain('echo hi');
    expect(recentBlock).toContain('Agent');
    expect(recentBlock).toContain('Explore the repo');
    expect(recentBlock).toContain('Error');
    expect(recentBlock).toContain('Msg');
    expect(recentBlock).toContain('all done now');
  });

  it('Errors section sits above Modified/Read/Commands, not at the bottom', () => {
    const events: SessionEvent[] = [
      makeEvent({ type: 'error', tool: 'Bash', args: { command: 'bun test' }, content: 'exit 1' }),
      makeEvent({ type: 'tool_use', tool: 'Edit', args: { file_path: '/p/src/a.ts' }, path: '/p/src/a.ts' }),
      makeEvent({ type: 'tool_use', tool: 'Bash', command: 'git status' }),
    ];
    const out = renderSummary(events, '/p');
    const errorsIdx = out.indexOf('Errors');
    const modifiedIdx = out.indexOf('Changes');
    const commandsIdx = out.indexOf('Commands');
    expect(errorsIdx).toBeGreaterThan(-1);
    expect(errorsIdx).toBeLessThan(modifiedIdx);
    expect(errorsIdx).toBeLessThan(commandsIdx);
  });

  it('keeps Final message at the bottom for full markdown rendering', () => {
    const events: SessionEvent[] = [
      makeEvent({ type: 'tool_use', tool: 'Bash', command: 'git status' }),
      makeEvent({ role: 'assistant', content: 'The work is complete.' }),
    ];
    const out = renderSummary(events);
    // Final message text should appear AFTER the Commands section
    const commandsIdx = out.indexOf('Commands');
    const finalIdx = out.lastIndexOf('The work is complete.');
    expect(commandsIdx).toBeGreaterThan(-1);
    expect(finalIdx).toBeGreaterThan(commandsIdx);
  });
});
