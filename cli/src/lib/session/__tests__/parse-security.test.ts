/**
 * Security regressions for the session parser:
 *   1. Terminal escape sequences embedded in untrusted session content must not
 *      survive parseSession() — otherwise `agents sessions` becomes a clipboard
 *      hijack / scrollback wipe / alt-screen takeover gadget for any malicious
 *      assistant message or tool output.
 *   2. Multi-hundred-MB session blobs must trip the size cap with a clean
 *      error rather than OOMing the CLI or exceeding V8's
 *      ERR_STRING_TOO_LONG ceiling.
 */

import { describe, expect, test, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseSession,
  sanitizeForTerminal,
  safeReadSessionFile,
  SESSION_FILE_MAX_BYTES,
} from '@phnx-labs/sessions-cli/reader';

const tmpFiles: string[] = [];

function writeTmp(name: string, content: string): string {
  const p = path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random()}.jsonl`);
  fs.writeFileSync(p, content);
  tmpFiles.push(p);
  return p;
}

afterAll(() => {
  for (const p of tmpFiles) {
    try { fs.unlinkSync(p); } catch { /* noop */ }
  }
});

const ESC = '\x1b';
const BEL = '\x07';
const CSI = '\x9b'; // 0x9b — should be stripped (C1 control)

const PAYLOADS = [
  `${ESC}]52;c;UEhJU0hJTkc=${BEL}`,             // OSC 52 clipboard hijack
  `${ESC}[2J${ESC}[3J${ESC}[H`,                 // wipe scrollback + home cursor
  `${ESC}[?1049h`,                              // alt-screen takeover
  `${ESC}[31mRED${ESC}[0m`,                     // color hijack
  `\x07\x08`,                                   // bell + backspace
  `${CSI}1;31m`,                                // raw C1 CSI byte
];

function containsTerminalEscape(s: string): boolean {
  return /[\x1b\x07\x9b]/.test(s);
}

describe('sanitizeForTerminal', () => {
  test('strips OSC, CSI, single-char escapes, and C1 controls', () => {
    for (const payload of PAYLOADS) {
      const cleaned = sanitizeForTerminal(payload);
      expect(containsTerminalEscape(cleaned)).toBe(false);
    }
  });

  test('preserves newlines, tabs, and carriage returns', () => {
    expect(sanitizeForTerminal('line1\nline2\tcol\rmore')).toBe('line1\nline2\tcol\rmore');
  });

  test('removes other C0 controls', () => {
    expect(sanitizeForTerminal('a\x01b\x05c')).toBe('abc');
    expect(sanitizeForTerminal('a\x7fb')).toBe('ab');
  });
});

describe('parseSession sanitization chokepoint', () => {
  test('Claude JSONL: escape bytes in assistant text and tool output do not survive', () => {
    const evil = PAYLOADS.join('');
    const lines = [
      {
        type: 'assistant',
        timestamp: '2026-04-22T10:00:00Z',
        message: {
          model: `claude-sonnet${ESC}[31m-poison`,
          content: [
            { type: 'text', text: `hello ${evil} world` },
            {
              type: 'tool_use',
              id: 'tu1',
              name: `Bash${ESC}]52;c;BAD${BEL}`,
              input: { command: `ls ${evil}; echo ${BEL}done`, file_path: `/tmp/${ESC}[2Ja.txt` },
            },
            { type: 'thinking', thinking: `reasoning ${evil}` },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-04-22T10:00:01Z',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu1',
              content: `output line\n${evil}\nmore`,
            },
          ],
        },
      },
    ];
    const jsonl = lines.map((l) => JSON.stringify(l)).join('\n');
    // Path must include /.claude/ for detectAgent to route to parseClaude.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-claude-'));
    const claudeDir = path.join(dir, '.claude', 'projects', 'p');
    fs.mkdirSync(claudeDir, { recursive: true });
    const p = path.join(claudeDir, 'session.jsonl');
    fs.writeFileSync(p, jsonl);
    tmpFiles.push(p);

    const events = parseSession(p);
    expect(events.length).toBeGreaterThan(0);

    for (const e of events) {
      const fields: Array<string | undefined> = [
        e.content,
        e.command,
        e.path,
        e.output,
        e.tool,
        e.model,
      ];
      for (const f of fields) {
        if (f) expect(containsTerminalEscape(f)).toBe(false);
      }
      // Also walk args deeply.
      if (e.args) {
        const flat = JSON.stringify(e.args);
        expect(containsTerminalEscape(flat)).toBe(false);
      }
    }
  });

  test('Rush JSONL: escape bytes in message text do not survive', () => {
    const evil = `${ESC}]52;c;PAY${BEL}${ESC}[?1049h`;
    const jsonl = [
      {
        id: 'm1',
        session_id: 's1',
        role: 'user',
        type: 'message',
        content: { text: `<user_input>hi ${evil}</user_input>` },
        created_at: '2026-04-22T10:00:00Z',
      },
      {
        id: 'tc1',
        session_id: 's1',
        role: 'assistant',
        type: 'tool_call',
        name: `Bash${ESC}[31m`,
        content: { input: { command: `ls ${evil}`, file_path: `/x/${ESC}[2Jy` } },
        created_at: '2026-04-22T10:00:01Z',
        tool_call_id: 'c1',
      },
    ].map((o) => JSON.stringify(o)).join('\n');
    // Path must include /.rush/ for detectAgent to route to parseRush.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-rush-'));
    const rushDir = path.join(dir, '.rush', 'sessions');
    fs.mkdirSync(rushDir, { recursive: true });
    const p = path.join(rushDir, 'messages.jsonl');
    fs.writeFileSync(p, jsonl);
    tmpFiles.push(p);

    const events = parseSession(p);
    for (const e of events) {
      for (const f of [e.content, e.command, e.path, e.tool]) {
        if (f) expect(containsTerminalEscape(f)).toBe(false);
      }
      if (e.args) {
        const flat = JSON.stringify(e.args);
        expect(containsTerminalEscape(flat)).toBe(false);
      }
    }
  });
});

describe('safeReadSessionFile size cap', () => {
  test('throws a clean error above the cap without loading the file', () => {
    // Sparse file: 250MB on-disk size, near-zero physical bytes. Avoids
    // actually allocating 250MB just to verify the cap check.
    const p = path.join(os.tmpdir(), `sec-large-${Date.now()}.jsonl`);
    const fd = fs.openSync(p, 'w');
    try {
      const size = 250 * 1024 * 1024; // 250MB
      // Truncate to size — produces a sparse file on darwin/linux.
      fs.ftruncateSync(fd, size);
    } finally {
      fs.closeSync(fd);
    }
    tmpFiles.push(p);

    expect(fs.statSync(p).size).toBeGreaterThan(SESSION_FILE_MAX_BYTES);
    expect(() => safeReadSessionFile(p)).toThrow(/too large/i);
  });

  test('reads files at or below the cap', () => {
    const p = writeTmp('sec-small', 'hello world\n');
    const out = safeReadSessionFile(p);
    expect(out).toBe('hello world\n');
  });

  test('parseSession surfaces the cap error for oversize Claude session files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-claude-big-'));
    const claudeDir = path.join(dir, '.claude', 'projects', 'p');
    fs.mkdirSync(claudeDir, { recursive: true });
    const p = path.join(claudeDir, 'session.jsonl');
    const fd = fs.openSync(p, 'w');
    try {
      fs.ftruncateSync(fd, 250 * 1024 * 1024);
    } finally {
      fs.closeSync(fd);
    }
    tmpFiles.push(p);

    expect(() => parseSession(p)).toThrow(/too large/i);
  });
});
