import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

// Redirect HOME to a throwaway dir BEFORE the module graph loads so tests never touch the real
// session store (state.ts captures HOME at first import; mirrorPath writes under .history).
// The module is loaded dynamically in beforeAll.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-bundle-home-'));
process.env.HOME = TMP_HOME;

type BundleMod = typeof import('./bundle.js');
let B: BundleMod;

beforeAll(async () => {
  B = await import('./bundle.js');
});

/** Write a throwaway transcript file and return its absolute path. */
function writeFixture(dir: string, name: string, content: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

const SRC = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-bundle-src-'));

describe('bundle format', () => {
  it('round-trips a plaintext bundle: serialize → parse preserves records', () => {
    const abs = writeFixture(SRC, 'claude-a.jsonl', '{"type":"user","text":"hello"}\n{"type":"assistant","text":"hi"}\n');
    const rec = B.buildRecord(
      { agent: 'claude', machine: 'boxA', sessionId: 'sess-a', relKey: 'proj/sess-a.jsonl', absPath: abs, label: 'greeting' },
      { redact: false, encryptKey: null },
    );
    const header = B.makeHeader({ origin: 'boxA', exportedAt: '2026-07-15T00:00:00Z', encrypted: false, redacted: false, records: [rec] });
    const wire = B.serializeBundle(header, [rec]);
    const parsed = B.parseBundle(wire);

    expect(parsed.header.kind).toBe(B.BUNDLE_KIND);
    expect(parsed.header.count).toBe(1);
    expect(parsed.header.sessions).toBe(1);
    expect(parsed.records[0].sessionId).toBe('sess-a');
    expect(parsed.records[0].agent).toBe('claude');
    expect(parsed.records[0].machine).toBe('boxA');
    expect(parsed.records[0].label).toBe('greeting');
    expect(parsed.records[0].encrypted).toBe(false);
    expect(parsed.records[0].body).toBe(fs.readFileSync(abs, 'utf-8'));
    // hash is over plaintext body
    expect(parsed.records[0].hash).toBe(crypto.createHash('sha256').update(parsed.records[0].body).digest('hex'));
  });

  it('redaction scrubs secrets from the stored body before hashing', () => {
    const secret = 'AKIA' + 'A'.repeat(16); // AWS key shape
    const abs = writeFixture(SRC, 'claude-secret.jsonl', `{"text":"key ${secret} here"}\n`);
    const rec = B.buildRecord(
      { agent: 'claude', machine: 'boxA', sessionId: 'sess-secret', relKey: 'sess-secret.jsonl', absPath: abs },
      { redact: true, encryptKey: null },
    );
    expect(rec.body).not.toContain(secret);
    expect(rec.body).toContain('[REDACTED_AWS_KEY]');
    // hash matches the redacted body actually stored
    expect(rec.hash).toBe(crypto.createHash('sha256').update(rec.body).digest('hex'));
  });

  it('value-aware redaction masks a known secret value verbatim (any format)', () => {
    // A credential whose shape matches no built-in pattern still leaks unless we
    // mask its exact value (RUSH-1761).
    const secret = 'zZ9-opaque-bundle-value-1761';
    const abs = writeFixture(SRC, 'claude-known.jsonl', `{"text":"used ${secret} in a url"}\n`);
    const rec = B.buildRecord(
      { agent: 'claude', machine: 'boxA', sessionId: 'sess-known', relKey: 'sess-known.jsonl', absPath: abs },
      { redact: true, encryptKey: null, knownSecrets: [secret] },
    );
    expect(rec.body).not.toContain(secret);
    expect(rec.body).toContain('[REDACTED]');
    expect(rec.hash).toBe(crypto.createHash('sha256').update(rec.body).digest('hex'));
  });

  it('writeBundleFile creates the export owner-only (mode 0600)', () => {
    const rec = B.buildRecord(
      { agent: 'claude', machine: 'boxA', sessionId: 'sess-perm', relKey: 'sess-perm.jsonl', absPath: writeFixture(SRC, 'perm.jsonl', '{"x":1}\n') },
      { redact: false, encryptKey: null },
    );
    const wire = B.serializeBundle(
      B.makeHeader({ origin: 'boxA', exportedAt: 'now', encrypted: false, redacted: false, records: [rec] }),
      [rec],
    );
    const out = path.join(SRC, 'out.bundle');
    B.writeBundleFile(out, wire);
    expect(fs.readFileSync(out, 'utf-8')).toBe(wire);
    // POSIX-only: Windows (NTFS) has no 0600 bit; Node reports 0o666 regardless.
    if (process.platform !== 'win32') expect(fs.statSync(out).mode & 0o777).toBe(0o600);

    // Overwriting a pre-existing looser file still clamps to 0600.
    fs.writeFileSync(out, 'stale', { mode: 0o644 });
    fs.chmodSync(out, 0o644);
    B.writeBundleFile(out, wire);
    if (process.platform !== 'win32') expect(fs.statSync(out).mode & 0o777).toBe(0o600);
  });

  it('encrypted bundle round-trips: body is an envelope, planImport decrypts to the original', () => {
    const plaintext = '{"type":"user","text":"secret conversation"}\n';
    const abs = writeFixture(SRC, 'claude-enc.jsonl', plaintext);
    const key = crypto.randomBytes(32);

    const rec = B.buildRecord(
      { agent: 'claude', machine: 'boxEnc', sessionId: 'sess-enc', relKey: 'sess-enc.jsonl', absPath: abs },
      { redact: false, encryptKey: key },
    );
    expect(rec.encrypted).toBe(true);
    expect(rec.body).not.toContain('secret conversation'); // ciphertext, not plaintext
    // hash is still over PLAINTEXT so dedup is encryption-agnostic
    expect(rec.hash).toBe(crypto.createHash('sha256').update(plaintext).digest('hex'));

    const wire = B.serializeBundle(
      B.makeHeader({ origin: 'boxEnc', exportedAt: 'now', encrypted: true, redacted: false, records: [rec] }),
      [rec],
    );
    const parsed = B.parseBundle(wire);
    const plan = B.planImport(parsed, { decryptKey: key });
    expect(plan[0].status).toBe('new');

    const res = B.writeImport(plan, { overwrite: false, decryptKey: key });
    expect(res.placed).toBe(1);
    // the placed file is the decrypted plaintext, byte-exact
    expect(fs.readFileSync(plan[0].targetPath, 'utf-8')).toBe(plaintext);
  });

  it('rejects a non-bundle and an unsupported version', () => {
    expect(() => B.parseBundle('not json at all')).toThrow(/not JSON|Not an agents/);
    expect(() => B.parseBundle('{"kind":"something-else"}\n')).toThrow(/Not an agents session bundle/);
    expect(() => B.parseBundle('{"kind":"agents-session-bundle","version":999}\n')).toThrow(/Unsupported bundle version/);
  });
});

describe('import placement + dedup', () => {
  it('places a foreign session at the mirror path, then re-import is a byte-exact dup', () => {
    const plaintext = '{"type":"user","text":"from peer"}\n';
    const abs = writeFixture(SRC, 'peer.jsonl', plaintext);
    const rec = B.buildRecord(
      { agent: 'claude', machine: 'peerbox', sessionId: 'sess-peer', relKey: 'p/sess-peer.jsonl', absPath: abs },
      { redact: false, encryptKey: null },
    );
    const parsed = B.parseBundle(B.serializeBundle(
      B.makeHeader({ origin: 'peerbox', exportedAt: 'now', encrypted: false, redacted: false, records: [rec] }),
      [rec],
    ));

    // first import: new
    const plan1 = B.planImport(parsed, { decryptKey: null });
    expect(plan1[0].status).toBe('new');
    expect(plan1[0].targetPath).toContain(path.join('backups', 'claude', 'peerbox'));
    const res1 = B.writeImport(plan1, { overwrite: false, decryptKey: null });
    expect(res1.placed).toBe(1);
    expect(fs.existsSync(plan1[0].targetPath)).toBe(true);

    // second import of the identical bundle: dedup, no write
    const plan2 = B.planImport(parsed, { decryptKey: null });
    expect(plan2[0].status).toBe('dup');
    const res2 = B.writeImport(plan2, { overwrite: false, decryptKey: null });
    expect(res2.skipped).toBe(1);
    expect(res2.placed).toBe(0);
  });

  it('a changed body is a conflict; --overwrite replaces, default keeps local', () => {
    const abs = writeFixture(SRC, 'conflict.jsonl', '{"v":1}\n');
    const mk = (body: string) => {
      const p = writeFixture(SRC, 'conflict-src.jsonl', body);
      const rec = B.buildRecord(
        { agent: 'claude', machine: 'confbox', sessionId: 'sess-conf', relKey: 'sess-conf.jsonl', absPath: p },
        { redact: false, encryptKey: null },
      );
      return B.parseBundle(B.serializeBundle(
        B.makeHeader({ origin: 'confbox', exportedAt: 'now', encrypted: false, redacted: false, records: [rec] }),
        [rec],
      ));
    };
    void abs;

    // place v1
    const v1 = mk('{"v":1}\n');
    B.writeImport(B.planImport(v1, { decryptKey: null }), { overwrite: false, decryptKey: null });
    const target = B.planImport(v1, { decryptKey: null })[0].targetPath;
    expect(fs.readFileSync(target, 'utf-8')).toBe('{"v":1}\n');

    // v2 conflicts; default keeps local
    const v2 = mk('{"v":2}\n');
    const planNoOw = B.planImport(v2, { decryptKey: null });
    expect(planNoOw[0].status).toBe('conflict');
    const keep = B.writeImport(planNoOw, { overwrite: false, decryptKey: null });
    expect(keep.conflicts).toBe(1);
    expect(fs.readFileSync(target, 'utf-8')).toBe('{"v":1}\n'); // unchanged

    // v2 with --overwrite replaces
    const ow = B.writeImport(B.planImport(v2, { decryptKey: null }), { overwrite: true, decryptKey: null });
    expect(ow.overwritten).toBe(1);
    expect(fs.readFileSync(target, 'utf-8')).toBe('{"v":2}\n');
  });

  it('a dir-shaped session (kimi) round-trips all its files', () => {
    const stateJson = '{"session":"s"}\n';
    const wireJsonl = '{"role":"user"}\n{"role":"assistant"}\n';
    const p1 = writeFixture(path.join(SRC, 'kimi'), 'state.json', stateJson);
    const p2 = writeFixture(path.join(SRC, 'kimi', 'agents', 'main'), 'wire.jsonl', wireJsonl);
    const files = [
      { agent: 'kimi', machine: 'kbox', sessionId: 'session_abc', relKey: 'wd/session_abc/state.json', absPath: p1 },
      { agent: 'kimi', machine: 'kbox', sessionId: 'session_abc', relKey: 'wd/session_abc/agents/main/wire.jsonl', absPath: p2 },
    ];
    const recs = files.map(f => B.buildRecord(f, { redact: false, encryptKey: null }));
    const parsed = B.parseBundle(B.serializeBundle(
      B.makeHeader({ origin: 'kbox', exportedAt: 'now', encrypted: false, redacted: false, records: recs }),
      recs,
    ));
    expect(parsed.header.count).toBe(2);
    expect(parsed.header.sessions).toBe(1); // both files are one session

    const plan = B.planImport(parsed, { decryptKey: null });
    expect(plan.every(p => p.status === 'new')).toBe(true);
    const res = B.writeImport(plan, { overwrite: false, decryptKey: null });
    expect(res.placed).toBe(2);
    const stateTarget = plan.find(p => p.record.relKey.endsWith('state.json'))!.targetPath;
    const wireTarget = plan.find(p => p.record.relKey.endsWith('wire.jsonl'))!.targetPath;
    expect(fs.readFileSync(stateTarget, 'utf-8')).toBe(stateJson);
    expect(fs.readFileSync(wireTarget, 'utf-8')).toBe(wireJsonl);
  });

  it('mergeRecords dedups by agent + origin machine + session + file (fan-out pull)', () => {
    const rec = (machine: string, sessionId: string, relKey: string): import('./bundle.js').BundleRecord => ({
      agent: 'claude', machine, sessionId, relKey, size: 1, hash: 'h', encrypted: false, body: 'x',
    });
    // hostA and hostB both return session s1 (same origin machineX) + each a unique one.
    const fromA = [rec('machineX', 's1', 's1.jsonl'), rec('machineX', 's2', 's2.jsonl')];
    const fromB = [rec('machineX', 's1', 's1.jsonl'), rec('machineY', 's3', 's3.jsonl')];
    const merged = B.mergeRecords([fromA, fromB]);
    expect(merged.length).toBe(3); // s1 deduped, s2, s3 kept
    const keys = merged.map(r => `${r.machine}:${r.sessionId}`).sort();
    expect(keys).toEqual(['machineX:s1', 'machineX:s2', 'machineY:s3']);
  });

  it('an unknown agent is reported, never placed', () => {
    const abs = writeFixture(SRC, 'unknown.jsonl', '{}\n');
    const rec = B.buildRecord(
      { agent: 'totally-unknown', machine: 'x', sessionId: 's', relKey: 's.jsonl', absPath: abs },
      { redact: false, encryptKey: null },
    );
    const parsed = B.parseBundle(B.serializeBundle(
      B.makeHeader({ origin: 'x', exportedAt: 'now', encrypted: false, redacted: false, records: [rec] }),
      [rec],
    ));
    const plan = B.planImport(parsed, { decryptKey: null });
    expect(plan[0].status).toBe('unknown');
    const res = B.writeImport(plan, { overwrite: false, decryptKey: null });
    expect(res.unknown).toBe(1);
    expect(res.placed).toBe(0);
  });
});
