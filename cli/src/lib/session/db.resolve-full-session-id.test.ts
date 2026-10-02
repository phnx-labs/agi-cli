import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate the sessions DB under a temp HOME before db.js/state.js capture the
// path at import time (mirrors db.names.test.ts).
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-resolvefsid-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { upsertSession, resolveFullSessionId } = await import('./db.js');
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;

const FULL = '6fc1db18-1111-4222-8333-444455556666';

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    shortId: id.slice(0, 8),
    agent: 'claude',
    timestamp: new Date().toISOString(),
    filePath: '',
    ...extra,
  };
}

describe('resolveFullSessionId — upgrade an 8-char footer crumb to the full id (PHNX-3698)', () => {
  it('resolves an indexed 8-char crumb to the full session id', () => {
    upsertSession(meta(FULL), '');
    expect(resolveFullSessionId('6fc1db18')).toBe(FULL);
  });

  it('returns a full id unchanged (nothing to resolve)', () => {
    upsertSession(meta(FULL), '');
    expect(resolveFullSessionId(FULL)).toBe(FULL);
  });

  it('returns a native non-hex id unchanged without touching the index', () => {
    expect(resolveFullSessionId('ses_fields0000000000000000')).toBe('ses_fields0000000000000000');
  });

  it('returns an unresolvable crumb unchanged (no fabricated id)', () => {
    // A crumb the index has never seen stays a crumb — the caller then emits no
    // console URL rather than a link that would 404.
    expect(resolveFullSessionId('deadbeef')).toBe('deadbeef');
  });

  it('is undefined for empty / undefined input', () => {
    expect(resolveFullSessionId(undefined)).toBeUndefined();
    expect(resolveFullSessionId('   ')).toBeUndefined();
  });
});
