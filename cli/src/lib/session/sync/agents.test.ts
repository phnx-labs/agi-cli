import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { SYNC_AGENTS, objectKey, isMergeableFile, mirrorPath } from './agents.js';
import { getHistoryDir } from '../../state.js';

function spec(id: string) {
  const s = SYNC_AGENTS.find(a => a.id === id);
  if (!s) throw new Error(`missing SYNC_AGENTS entry: ${id}`);
  return s;
}

describe('SYNC_AGENTS expanded beyond claude+codex', () => {
  it('includes the four agents from RUSH-1467', () => {
    const ids = SYNC_AGENTS.map(s => s.id);
    expect(ids).toContain('droid');
    expect(ids).toContain('cursor');
    expect(ids).toContain('grok');
    expect(ids).toContain('kimi');
    expect(ids).toContain('opencode');
    expect(ids).not.toContain('gemini');
  });

  it('claude keeps the default .jsonl extension', () => {
    expect(spec('claude').ext).toBeUndefined();
  });

  it('kimi is dir-shaped: walks .json + .jsonl, unions only the .jsonl log (RUSH-1466)', () => {
    const kimi = spec('kimi');
    expect(kimi.dirShaped).toBe(true);
    expect(kimi.exts).toEqual(['.json', '.jsonl']);
    expect(kimi.mergeableExts).toEqual(['.jsonl']);
    expect(kimi.fileFilter!('session_x/agents/main/wire.jsonl')).toBe(true);
    expect(kimi.fileFilter!('session_x/.lock')).toBe(false);
  });
});

describe('sessionIdFromRelKey', () => {
  it('claude: basename without .jsonl', () => {
    expect(spec('claude').sessionIdFromRelKey('my-project/abc123.jsonl')).toBe('abc123');
  });

  it('codex: extracts UUID from rollout filename', () => {
    expect(
      spec('codex').sessionIdFromRelKey('2026-07-15/rollout-1721011200-019f5a97-33ec-7001-8aad-4c42ae1d30d9.jsonl'),
    ).toBe('019f5a97-33ec-7001-8aad-4c42ae1d30d9');
  });

  it('droid: basename without .jsonl', () => {
    expect(
      spec('droid').sessionIdFromRelKey('-home-muqsit/2bd0daa3-8336-464a-bf51-42b1ea22cd30.jsonl'),
    ).toBe('2bd0daa3-8336-464a-bf51-42b1ea22cd30');
  });

  it('cursor: parent directory name (UUID)', () => {
    expect(
      spec('cursor').sessionIdFromRelKey('encoded-cwd/agent-transcripts/019f5a97-33ec-7001-8aad-4c42ae1d30d9/019f5a97-33ec-7001-8aad-4c42ae1d30d9.jsonl'),
    ).toBe('019f5a97-33ec-7001-8aad-4c42ae1d30d9');
  });

  it('grok: parent directory name (UUID)', () => {
    expect(
      spec('grok').sessionIdFromRelKey('%2Fhome%2Fmuqsit/019f5a97-33ec-7001-8aad-4c42ae1d30d9/events.jsonl'),
    ).toBe('019f5a97-33ec-7001-8aad-4c42ae1d30d9');
  });

  it('kimi: extracts session_<uuid> from path', () => {
    expect(
      spec('kimi').sessionIdFromRelKey('wd_agents-cli_24557025c9f4/session_cabd8c14-9169-4aaa-845a-a40e944ab37a/state.json'),
    ).toBe('session_cabd8c14-9169-4aaa-845a-a40e944ab37a');
  });

  it('kimi: falls back to relKey when no session_ segment', () => {
    expect(spec('kimi').sessionIdFromRelKey('odd/path/file.json')).toBe('odd/path/file.json');
  });

  it('opencode: basename (placeholder until SQLite export lands)', () => {
    expect(spec('opencode').sessionIdFromRelKey('sessions/ses_abc123.jsonl')).toBe('ses_abc123.jsonl');
  });
});

describe('objectKey (RUSH-1466 dir-shaped keys)', () => {
  it('file-shaped (no relKey): flat key, unchanged from before', () => {
    expect(objectKey('zion', 'claude', 'abc123')).toBe('sessions/zion/claude/abc123.jsonl');
  });

  it('dir-shaped (relKey): one nested object per constituent file', () => {
    expect(objectKey('zion', 'kimi', 'session_uuid', 'wd/session_uuid/state.json')).toBe(
      'sessions/zion/kimi/session_uuid/wd/session_uuid/state.json',
    );
    expect(objectKey('zion', 'kimi', 'session_uuid', 'wd/session_uuid/agents/main/wire.jsonl')).toBe(
      'sessions/zion/kimi/session_uuid/wd/session_uuid/agents/main/wire.jsonl',
    );
  });
});

describe('isMergeableFile (append-only union vs mutable-blob LWW)', () => {
  const kimi = spec('kimi');
  const claude = spec('claude');

  it('kimi: only .jsonl logs union; .json blobs are last-writer-wins', () => {
    expect(isMergeableFile(kimi, 'wd/session_x/agents/main/wire.jsonl')).toBe(true);
    expect(isMergeableFile(kimi, 'wd/session_x/state.json')).toBe(false);
    expect(isMergeableFile(kimi, 'wd/session_x/agents/main/tasks/bash-1.json')).toBe(false);
  });

  it('file-shaped agents (no mergeableExts): every file unions, as before', () => {
    expect(isMergeableFile(claude, 'proj/abc.jsonl')).toBe(true);
    expect(isMergeableFile(claude, 'proj/whatever.json')).toBe(true);
  });
});

describe('mirrorPath — peer-controlled path containment (C1)', () => {
  const claude = spec('claude');
  const backupsRoot = path.resolve(getHistoryDir(), 'backups', claude.id);

  it('returns a contained path for a benign machine + relKey', () => {
    const p = mirrorPath(claude, 'laptop-a', 'projects/sess-1.jsonl');
    expect(path.resolve(p).startsWith(backupsRoot + path.sep)).toBe(true);
    expect(p.endsWith(path.join('laptop-a', claude.subdir, 'projects', 'sess-1.jsonl'))).toBe(true);
  });

  it('rejects a relKey that traverses out of the mirror root', () => {
    expect(() => mirrorPath(claude, 'evil-peer', '../../../../../../.ssh/authorized_keys')).toThrow();
  });

  it('rejects a relKey with a mid-path parent escape', () => {
    expect(() => mirrorPath(claude, 'evil-peer', 'projects/../../../../etc/cron.d/x')).toThrow();
  });

  it('rejects a machine segment that is itself a traversal', () => {
    expect(() => mirrorPath(claude, '..', 'sess.jsonl')).toThrow();
    expect(() => mirrorPath(claude, '../..', 'sess.jsonl')).toThrow();
  });

  it('rejects a machine segment containing separators', () => {
    expect(() => mirrorPath(claude, 'a/b', 'sess.jsonl')).toThrow();
  });
});
