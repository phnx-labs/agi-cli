import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  decodeJwtEmail,
  readCodexMeta,
  scanAgentsBounded,
  getSessionRoots,
  DOTFILE_SCAN_CONCURRENCY,
  __codexAccountResolveCountForTest,
  __resetCodexAccountCacheForTest,
} from './discover.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'testdata', 'codex-fixture.jsonl');
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function jwtWith(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

describe('decodeJwtEmail (mitigation 4 — the JWT decode, isolated)', () => {
  it('extracts the email claim from a JWT payload', () => {
    expect(decodeJwtEmail(jwtWith({ email: 'codex-user@example.com', sub: 'x' }))).toBe(
      'codex-user@example.com',
    );
  });

  it('returns undefined for a malformed token instead of throwing', () => {
    expect(decodeJwtEmail('not-a-jwt')).toBeUndefined();
    expect(decodeJwtEmail('only.two')).toBeUndefined();
  });
});

describe('readCodexMeta (mitigation 4 — lazy account resolution)', () => {
  it('resolves the account thunk only while building meta, and threads its value through', async () => {
    let calls = 0;
    const resolveAccount = () => { calls++; return 'lazy@example.com'; };

    expect(calls).toBe(0);

    const result = await readCodexMeta(FIXTURE, resolveAccount);

    expect(result).not.toBeNull();
    expect(result!.meta.id).toBe('codex-fixture-0001');
    expect(calls).toBe(1);
    expect(result!.meta.account).toBe('lazy@example.com');
  });

  it('does not require an account thunk (account stays undefined)', async () => {
    const result = await readCodexMeta(FIXTURE);
    expect(result!.meta.account).toBeUndefined();
  });

  it('projects the full first actual user turn, after developer and plugin scaffolding', async () => {
    const dir = fs.mkdtempSync(path.join('/tmp', 'agents-codex-first-user-'));
    const file = path.join(dir, 'rollout.jsonl');
    const request = `# Mission\n\n${'Preserve this detailed acceptance criterion. '.repeat(80)}`;
    const rows = [
      { type: 'session_meta', timestamp: '2026-08-30T10:00:00.000Z', payload: { id: 'codex-first-user-0001', timestamp: '2026-08-30T10:00:00.000Z', cwd: '/tmp/proj' } },
      { type: 'response_item', timestamp: '2026-08-30T10:00:01.000Z', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Internal developer policy.' }] } },
      { type: 'response_item', timestamp: '2026-08-30T10:00:02.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins>catalog</recommended_plugins>' }] } },
      { type: 'response_item', timestamp: '2026-08-30T10:00:03.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: request }] } },
    ];
    fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n'));
    try {
      const result = await readCodexMeta(file);
      expect(result?.meta.firstUserMessage).toBe(request.trim());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('getCodexAccount memoization (mitigation 4 — decode is deferred + cached)', () => {
  beforeEach(() => __resetCodexAccountCacheForTest());

  it('does not decode until the account is actually accessed', () => {
    expect(__codexAccountResolveCountForTest()).toBe(0);
  });

  it('decodes at most once across repeated reads', async () => {
    await readCodexMeta(FIXTURE);
    await readCodexMeta(FIXTURE);
    expect(__codexAccountResolveCountForTest()).toBe(0);
  });
});

describe('scanAgentsBounded (mitigation 3 — no simultaneous multi-dotfile burst)', () => {
  it('bounds concurrent dotfile scans to DOTFILE_SCAN_CONCURRENCY', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const agents = ['claude', 'codex', 'gemini', 'antigravity', 'opencode', 'kimi', 'droid'];

    await scanAgentsBounded(agents, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(5);
      inFlight--;
    });

    expect(DOTFILE_SCAN_CONCURRENCY).toBeGreaterThanOrEqual(1);
    expect(DOTFILE_SCAN_CONCURRENCY).toBeLessThan(agents.length);
    expect(maxInFlight).toBeLessThanOrEqual(DOTFILE_SCAN_CONCURRENCY);
  });
});

describe('getSessionRoots (the `agents sessions --roots --json` payload, issue #741)', () => {
  const KNOWN_AGENTS = new Set(['claude', 'codex', 'gemini', 'antigravity', 'droid', 'kimi', 'grok', 'cursor']);
  const EXPECTED_SUBDIR: Record<string, string> = {
    claude: 'projects', codex: 'sessions', gemini: 'tmp',
    antigravity: 'conversations', droid: 'sessions', kimi: 'sessions', grok: 'sessions', cursor: 'projects',
  };

  it('never throws and returns a well-formed SessionRoots[]', () => {
    const roots = getSessionRoots();
    expect(Array.isArray(roots)).toBe(true);
    for (const entry of roots) {
      expect(KNOWN_AGENTS.has(entry.agent)).toBe(true);
      expect(Array.isArray(entry.dirs)).toBe(true);
      for (const dir of entry.dirs) {
        expect(path.isAbsolute(dir)).toBe(true);
        expect(fs.existsSync(dir)).toBe(true);
        expect(dir.split(path.sep)).toContain(EXPECTED_SUBDIR[entry.agent]);
      }
    }
  });

  it('emits at most one entry per agent, and never an empty dir list', () => {
    const roots = getSessionRoots();
    const agents = roots.map(r => r.agent);
    expect(new Set(agents).size).toBe(agents.length);
    for (const entry of roots) expect(entry.dirs.length).toBeGreaterThan(0);
  });
});
