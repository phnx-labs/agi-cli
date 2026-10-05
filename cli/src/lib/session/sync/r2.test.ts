
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { R2Client, decodeXml } from './r2.js';
import type { R2Config } from './config.js';
import { objectKey } from './agents.js';
import {
  buildRecord,
  makeHeader,
  parseBundle,
  serializeBundle,
  specForAgent,
} from '../bundle.js';
import {
  encryptTranscript,
  decryptTranscriptBody,
  generateSyncEncKey,
  isTranscriptEnvelope,
} from './transcript-crypto.js';

const ENDPOINT = process.env.AGENTS_TEST_R2_ENDPOINT ?? '';
const BUCKET = process.env.AGENTS_TEST_R2_BUCKET ?? '';
const ACCESS = process.env.AGENTS_TEST_R2_ACCESS_KEY_ID ?? '';
const SECRET = process.env.AGENTS_TEST_R2_SECRET_ACCESS_KEY ?? '';
const ACCOUNT = process.env.AGENTS_TEST_R2_ACCOUNT_ID ?? 'test-account';

const CONFIGURED = Boolean((ENDPOINT || ACCOUNT !== 'test-account') && BUCKET && ACCESS && SECRET);
describe('decodeXml', () => {
  it('decodes each entity once, so an escaped ampersand cannot double-decode (CodeQL js/double-escaping)', () => {
    expect(decodeXml('a&amp;b&lt;c&gt;d&quot;e&apos;f')).toBe('a&b<c>d"e\'f');
    expect(decodeXml('sessions/&amp;lt;id&amp;gt;.json')).toBe('sessions/&lt;id&gt;.json');
  });
});

const suite = CONFIGURED ? describe : describe.skip;

function testConfig(): R2Config {
  return {
    accountId: ACCOUNT,
    bucket: BUCKET,
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
    endpoint: ENDPOINT || `https://${ACCOUNT}.r2.cloudflarestorage.com`,
  };
}

const RUN = `r2test-${process.pid}-${Math.floor(Number(process.hrtime.bigint() % 1_000_000n))}`;
const PREFIX = `sessions/${RUN}/`;

suite('R2Client end-to-end (AGENTS_TEST_R2_ENDPOINT)', () => {
  const client = new R2Client(testConfig());
  const written: string[] = [];

  afterAll(async () => {
    for (const key of written) {
      try { await client.delete(key); } catch {  }
    }
  });

  it('put -> get returns the exact body', async () => {
    const key = `${PREFIX}claude/sess-a.jsonl`;
    written.push(key);
    const body = '{"line":1}\n{"line":2}\n';
    await client.put(key, body, 'application/json');
    expect(await client.get(key)).toBe(body);
  });

  it('head reports size, and get on a missing key is null', async () => {
    const key = `${PREFIX}claude/sess-b.jsonl`;
    written.push(key);
    const body = 'hello world';
    await client.put(key, body);
    const head = await client.head(key);
    expect(head).not.toBeNull();
    expect(head!.size).toBe(Buffer.byteLength(body, 'utf-8'));
    expect(await client.get(`${PREFIX}claude/does-not-exist.jsonl`)).toBeNull();
    expect(await client.head(`${PREFIX}claude/does-not-exist.jsonl`)).toBeNull();
  });

  it('list returns every key under the prefix (pagination-safe)', async () => {
    const keys = [
      `${PREFIX}codex/sess-c.jsonl`,
      `${PREFIX}codex/sess-d.jsonl`,
      `${PREFIX}kimi/session_x/state.json`,
    ];
    for (const k of keys) { written.push(k); await client.put(k, `body-${k}`); }
    const listed = await client.list(PREFIX);
    for (const k of keys) expect(listed).toContain(k);
  });

  it('delete removes an object and is idempotent on an absent key', async () => {
    const key = `${PREFIX}claude/sess-del.jsonl`;
    await client.put(key, 'to be deleted');
    expect(await client.get(key)).not.toBeNull();
    await client.delete(key);
    expect(await client.get(key)).toBeNull();
    await client.delete(key);
  });

  it('encrypt -> upload -> download -> decrypt round-trips the transcript body', async () => {
    const key = `${PREFIX}claude/sess-enc.jsonl`;
    written.push(key);
    const plaintext = '{"role":"user","content":"secret token sk-abc123"}\n';
    const encKey = Buffer.from(generateSyncEncKey(), 'base64');

    const envelope = encryptTranscript(plaintext, encKey);
    expect(isTranscriptEnvelope(envelope)).toBe(true);
    expect(envelope).not.toContain('sk-abc123');

    await client.put(key, envelope, 'application/json');
    const fetched = await client.get(key);
    expect(fetched).not.toBeNull();
    expect(fetched).not.toContain('sk-abc123');

    const opened = decryptTranscriptBody(fetched!, encKey);
    expect(opened).toBe(plaintext);
  });

  it('backup wire format: export --to-r2 object round-trips through import --from-r2', async () => {
    const encKey = Buffer.from(generateSyncEncKey(), 'base64');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-backup-'));
    const abs = path.join(tmp, 'transcript.jsonl');
    const plaintext = '{"role":"user","content":"hello from RUSH-2437"}\n';
    fs.writeFileSync(abs, plaintext, 'utf-8');

    const machine = RUN;
    const rec = buildRecord(
      { agent: 'claude', machine, sessionId: 'sess-wire', relKey: 'projects/p/sess-wire.jsonl', absPath: abs },
      { redact: true, encryptKey: encKey },
    );
    expect(rec.encrypted).toBe(true);

    const spec = specForAgent(rec.agent);
    const key = objectKey(rec.machine, rec.agent, rec.sessionId, spec?.dirShaped ? rec.relKey : undefined);
    written.push(key);
    const recHeader = makeHeader({
      origin: machine, exportedAt: new Date().toISOString(),
      encrypted: rec.encrypted, redacted: true, records: [rec],
    });
    await client.put(key, serializeBundle(recHeader, [rec]), 'application/json');

    const listed = await client.list(`sessions/${machine}/`);
    expect(listed).toContain(key);
    const body = await client.get(key);
    expect(body).not.toBeNull();
    const parsed = parseBundle(body!);
    expect(parsed.records).toHaveLength(1);
    const back = parsed.records[0];
    expect(back.relKey).toBe('projects/p/sess-wire.jsonl');
    expect(decryptTranscriptBody(back.body, encKey)).toBe(plaintext);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
