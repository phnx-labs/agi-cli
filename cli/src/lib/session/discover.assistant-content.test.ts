
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-assistant-content-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

type Discover = typeof import('./discover.js');
type DB = typeof import('./db.js');

let discover: Discover;
let db: DB;

const LIVE_PROJECTS = path.join(tmpHome, '.claude', 'projects');
const PROJECT_DIR = path.join(LIVE_PROJECTS, '-home-u-repo');

function line(obj: object): string {
  return JSON.stringify(obj);
}

function sessionFile(id: string): string {
  return path.join(PROJECT_DIR, `${id}.jsonl`);
}

function writeTranscript(id: string, events: object[]): string {
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
  const fp = sessionFile(id);
  fs.writeFileSync(fp, events.map(line).join('\n') + '\n', 'utf-8');
  return fp;
}

function agePriorScans(): void {
  db.getDB().prepare('UPDATE scan_ledger SET scanned_at = ?').run(Date.now() - 60_000);
}

async function runScan(): Promise<void> {
  agePriorScans();
  await discover.discoverSessions({ agent: 'claude', all: true });
}

beforeAll(async () => {
  db = await import('./db.js');
  discover = await import('./discover.js');
  db.getDB();
});

afterAll(() => {
  db.closeDB();
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  if (REAL_USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_USERPROFILE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const ASSISTANT_ONLY_PHRASE = 'grombulator flux capacitor overheated';

function transcriptWithAssistantOnlyAnswer(id: string): object[] {
  return [
    {
      type: 'user',
      timestamp: '2026-08-20T00:00:00.000Z',
      cwd: '/home/u/repo',
      version: '2.1.0',
      entrypoint: 'cli',
      message: { role: 'user', content: 'why did the deploy fail last night' },
    },
    {
      type: 'assistant',
      timestamp: '2026-08-20T00:01:00.000Z',
      uuid: `${id}-a1`,
      message: {
        id: `${id}-msg1`,
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: `Root cause: the ${ASSISTANT_ONLY_PHRASE} during the canary rollout.` }],
        usage: { input_tokens: 40, output_tokens: 12 },
      },
    },
  ];
}

describe('assistant-answer text is indexed for search (PHNX content-search)', () => {
  it('finds a session by a phrase that appears ONLY in the assistant reply', async () => {
    const id = 'assistant-only-session';
    writeTranscript(id, transcriptWithAssistantOnlyAnswer(id));
    await runScan();

    const row = db.getSessionById(id);
    expect(row, 'session indexed').not.toBeNull();

    const hits = db.ftsSearch(ASSISTANT_ONLY_PHRASE);
    expect(hits.some(h => h.sessionId === id)).toBe(true);
  });

  it('still finds a session by ordinary user-prompt text (no regression)', async () => {
    const id = 'user-text-session';
    writeTranscript(id, [
      {
        type: 'user',
        timestamp: '2026-08-20T01:00:00.000Z',
        cwd: '/home/u/repo',
        version: '2.1.0',
        entrypoint: 'cli',
        message: { role: 'user', content: 'investigate the wombat-migration-9182 ticket' },
      },
    ]);
    await runScan();

    const hits = db.ftsSearch('wombat-migration-9182');
    expect(hits.some(h => h.sessionId === id)).toBe(true);
  });

  it('ranks a user-content match above an assistant-only match for the same term (lower assistant BM25 weight)', async () => {
    const sharedTerm = 'perihelion-outage-4471';
    const userSideId = 'shared-term-user-side';
    const assistantSideId = 'shared-term-assistant-side';

    writeTranscript(userSideId, [
      {
        type: 'user',
        timestamp: '2026-08-20T02:00:00.000Z',
        cwd: '/home/u/repo',
        version: '2.1.0',
        entrypoint: 'cli',
        message: { role: 'user', content: `can you look into ${sharedTerm}` },
      },
    ]);
    writeTranscript(assistantSideId, [
      {
        type: 'user',
        timestamp: '2026-08-20T02:05:00.000Z',
        cwd: '/home/u/repo',
        version: '2.1.0',
        entrypoint: 'cli',
        message: { role: 'user', content: 'why did things break' },
      },
      {
        type: 'assistant',
        timestamp: '2026-08-20T02:06:00.000Z',
        uuid: `${assistantSideId}-a1`,
        message: {
          id: `${assistantSideId}-msg1`,
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: `Found it: ${sharedTerm}.` }],
          usage: { input_tokens: 10, output_tokens: 8 },
        },
      },
    ]);
    await runScan();

    const hits = db.ftsSearch(sharedTerm);
    const userHit = hits.find(h => h.sessionId === userSideId);
    const assistantHit = hits.find(h => h.sessionId === assistantSideId);
    expect(userHit, 'user-content hit present').toBeDefined();
    expect(assistantHit, 'assistant-content hit present').toBeDefined();
    expect(userHit!.score).toBeGreaterThan(assistantHit!.score);
  });
});

describe('CONTENT_INDEX_VERSION forces re-extraction of an unchanged file (mtime/size identical)', () => {
  it('backfills assistant text into a session whose ledger row predates the current extractor', async () => {
    const id = 'stale-extractor-session';
    const phrase = 'quixotic-nebula-regression-check';
    writeTranscript(id, [
      {
        type: 'user',
        timestamp: '2026-08-20T03:00:00.000Z',
        cwd: '/home/u/repo',
        version: '2.1.0',
        entrypoint: 'cli',
        message: { role: 'user', content: 'ping' },
      },
      {
        type: 'assistant',
        timestamp: '2026-08-20T03:01:00.000Z',
        uuid: `${id}-a1`,
        message: {
          id: `${id}-msg1`,
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: `pong — ${phrase}` }],
          usage: { input_tokens: 5, output_tokens: 5 },
        },
      },
    ]);
    await runScan();

    expect(db.ftsSearch(phrase).some(h => h.sessionId === id)).toBe(true);

    const fp = sessionFile(id);
    const before = fs.statSync(fp);
    const canonical = fs.realpathSync(fp);
    db.getDB().prepare(`UPDATE scan_ledger SET extractor_version = 0 WHERE file_path = ?`).run(canonical);
    db.getDB().prepare(`UPDATE session_text SET assistant = '' WHERE session_id = ?`).run(id);
    expect(db.ftsSearch(phrase).some(h => h.sessionId === id)).toBe(false);

    await runScan();

    const after = fs.statSync(fp);
    expect(after.mtimeMs, 'file mtime unchanged').toBe(before.mtimeMs);
    expect(after.size, 'file size unchanged').toBe(before.size);

    expect(db.ftsSearch(phrase).some(h => h.sessionId === id)).toBe(true);

    const ledgerRow = db.getDB()
      .prepare(`SELECT extractor_version FROM scan_ledger WHERE file_path = ?`)
      .get(canonical) as { extractor_version: number };
    expect(ledgerRow.extractor_version).toBe(db.CONTENT_INDEX_VERSION);
  });
});
