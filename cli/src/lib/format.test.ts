import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  truncate,
  formatBytes,
  isPromptCancelled,
  isInteractiveTerminal,
  parseCommaSeparatedList,
  relTime,
  humanDuration,
  visibleWidth,
  padRight,
  padVisible,
  isJsonMode,
  termLink,
  formatDie,
  dieFriction,
  runOrDie,
} from './format.js';
import { _resetForTest } from './feed/events.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {  }
  }
  tempDirs.length = 0;
  _resetForTest();
  vi.restoreAllMocks();
});

describe('truncate', () => {
  it('returns the string unchanged when within max', () => {
    expect(truncate('hello', 5)).toBe('hello');
    expect(truncate('hi', 10)).toBe('hi');
  });
  it('shortens with a single-char ellipsis when over max', () => {
    expect(truncate('hello world', 5)).toBe('hell…');
    expect(truncate('hello world', 5)).toHaveLength(5);
  });
});

describe('relTime', () => {
  const iso = (secsAgo: number) => new Date(Date.now() - secsAgo * 1000).toISOString();
  it('uses the short canonical form', () => {
    expect(relTime(iso(3))).toBe('just now');
    expect(relTime(iso(30))).toBe('30s ago');
    expect(relTime(iso(300))).toBe('5m ago');
    expect(relTime(iso(3 * 3600))).toBe('3h ago');
    expect(relTime(iso(2 * 86400))).toBe('2d ago');
  });
});

describe('humanDuration', () => {
  it('formats sub-minute, minute, hour, and day spans', () => {
    expect(humanDuration(45_000)).toBe('45s');
    expect(humanDuration(3 * 60_000)).toBe('3m');
    expect(humanDuration(2 * 3_600_000)).toBe('2h');
    expect(humanDuration(2 * 3_600_000 + 5 * 60_000)).toBe('2h 5m');
    expect(humanDuration(86_400_000)).toBe('1d');
    expect(humanDuration(86_400_000 + 3 * 3_600_000)).toBe('1d 3h');
  });
});

describe('visibleWidth', () => {
  it('ignores ANSI SGR sequences including the escape byte', () => {
    const colored = '\x1b[31mred\x1b[0m';
    expect(visibleWidth(colored)).toBe(3);
    expect(visibleWidth('plain')).toBe(5);
  });
});

describe('padRight / padVisible', () => {
  it('padRight pads by raw length', () => {
    expect(padRight('ab', 5)).toBe('ab   ');
    expect(padRight('abcdef', 3)).toBe('abcdef');
  });
  it('padVisible pads by visible width, ignoring color codes', () => {
    const colored = '\x1b[31mab\x1b[0m';
    expect(visibleWidth(padVisible(colored, 5))).toBe(5);
    expect(padVisible(colored, 5)).toBe(colored + '   ');
  });
});

describe('isJsonMode', () => {
  it('is true when json flag is set', () => {
    expect(isJsonMode({ json: true })).toBe(true);
  });

  it('is false without --json even when stdout is not a TTY', () => {
    expect(process.stdout.isTTY).not.toBe(true);
    expect(isJsonMode({})).toBe(false);
  });
});

describe('termLink', () => {
  it('returns plain text when not a TTY', () => {
    expect(termLink('label', '/tmp/x')).toBe('label');
  });
  it('returns plain text when filePath is empty', () => {
    expect(termLink('label', '')).toBe('label');
  });
});

describe('formatDie (RUSH-1830 — machine-readable failures for --json callers)', () => {
  it('emits a parseable {"error"} on stdout in json mode', () => {
    const out = formatDie('Prompt is required.', { json: true });
    expect(out.stream).toBe('stdout');
    expect(JSON.parse(out.text)).toEqual({ error: 'Prompt is required.' });
  });

  it('includes the hint in the json payload when provided', () => {
    const out = formatDie('Prompt is required.', { json: true, hint: 'agents cloud run "<task>"' });
    expect(out.stream).toBe('stdout');
    expect(JSON.parse(out.text)).toEqual({ error: 'Prompt is required.', hint: 'agents cloud run "<task>"' });
  });

  it('writes red text to stderr for humans (default, no json)', () => {
    const out = formatDie('Boom');
    expect(out.stream).toBe('stderr');
    expect(out.text).toContain('Boom');
  });

  it('appends the hint as a second stderr line for humans', () => {
    const out = formatDie('Boom', { hint: 'try --help' });
    expect(out.stream).toBe('stderr');
    expect(out.text).toContain('Boom');
    expect(out.text).toContain('try --help');
    expect(out.text.split('\n')).toHaveLength(2);
  });

  it('omits an absent hint from the json payload (no null/undefined key)', () => {
    const out = formatDie('nope', { json: true });
    expect(out.text).not.toContain('hint');
  });
});

describe('runOrDie', () => {
  it('turns a thrown Error into a clean die(message), not a rethrow (the auth/org stack-dump bug)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`exit:${code}`);
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      runOrDie(() => { throw new Error("Not signed in. Run 'agents auth login' first."); }),
    ).rejects.toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain("Not signed in. Run 'agents auth login' first.");
  });

  it('keeps the structured {"error"} payload for a --json caller', async () => {
    vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`exit:${code}`);
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      runOrDie(async () => { throw new Error('Signed-in token is no longer valid.'); }, { json: true }),
    ).rejects.toThrow('exit:1');
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({ error: 'Signed-in token is no longer valid.' });
  });

  it('passes a successful action through untouched', async () => {
    let ran = false;
    await runOrDie(async () => { ran = true; });
    expect(ran).toBe(true);
  });
});

describe('dieFriction', () => {
  it('emits a friction event before exiting', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-format-'));
    tempDirs.push(dir);
    const eventsPath = path.join(dir, 'events.jsonl');
    _resetForTest(eventsPath);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`exit:${code}`);
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => dieFriction('teams', 'remote-cwd-on-add', 'cannot use --remote-cwd')).toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalled();

    const content = fs.readFileSync(eventsPath, 'utf-8');
    const record = JSON.parse(content.trim().split('\n').pop()!);
    expect(record.event).toBe('friction');
    expect(record.surface).toBe('teams');
    expect(record.failureId).toBe('remote-cwd-on-add');
    expect(record.error).toBe('cannot use --remote-cwd');
  });
});

describe('formatBytes', () => {
  it('renders human-readable sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(86 * 1024)).toBe('86 KB');
    expect(formatBytes(3.1 * 1024 * 1024)).toBe('3.1 MB');
  });
});

describe('relocated CLI helpers', () => {
  it('parses a comma-separated list, trimming and dropping empties', () => {
    expect(parseCommaSeparatedList('a, b ,,c')).toEqual(['a', 'b', 'c']);
    expect(parseCommaSeparatedList(undefined)).toEqual([]);
  });

  it('recognizes a cancelled prompt by name and by message', () => {
    const named = new Error('nope');
    named.name = 'ExitPromptError';
    expect(isPromptCancelled(named)).toBe(true);
    expect(isPromptCancelled(new Error('User force closed the prompt'))).toBe(true);
    expect(isPromptCancelled(new Error('unrelated'))).toBe(false);
    expect(isPromptCancelled('not an error')).toBe(false);
  });

  it('reports an interactive terminal only when both streams are TTYs', () => {
    expect(typeof isInteractiveTerminal()).toBe('boolean');
  });
});
