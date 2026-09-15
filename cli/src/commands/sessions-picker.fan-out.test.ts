import { describe, expect, it } from 'vitest';
import { formatFanOut } from './sessions-picker.js';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';

/**
 * RUSH-3091/3095 regression. A REMOTE or unindexed row renders through
 * `formatMetaOnlyBody`, which has no parsed events — so before this change the
 * sub-agent count silently vanished there and background shells were never shown
 * at all. The counts are persisted columns precisely so this path can render
 * them; these tests pin that, and the zero/undefined distinction that keeps the
 * line from ever asserting "nothing is running".
 */
function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'a'.repeat(36),
    shortId: 'a1b2c3d4',
    agent: 'claude',
    timestamp: '2026-08-23T00:00:00.000Z',
    filePath: '/tmp/does-not-matter.jsonl',
    ...over,
  } as SessionMeta;
}

/** chalk may or may not colour depending on TTY; compare on plain text. */
const plain = (parts: string[]) =>
  parts.join(' · ').replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');

describe('formatFanOut — the remote-row path', () => {
  it('renders BOTH counts from persisted columns, with no events available', () => {
    const out = plain(formatFanOut(meta({ subAgentCount: 53, backgroundShellCount: 3 })));
    expect(out).toBe('53 sub-agents · 3 background shells');
  });

  it('singularises', () => {
    expect(plain(formatFanOut(meta({ subAgentCount: 1, backgroundShellCount: 1 })))).toBe(
      '1 sub-agent · 1 background shell',
    );
  });

  it('renders NOTHING for zero — never "0 background shells"', () => {
    // 0 is "scanned, none found". Printing it would read as a positive claim
    // that nothing is running.
    expect(formatFanOut(meta({ subAgentCount: 0, backgroundShellCount: 0 }))).toEqual([]);
  });

  it('renders nothing when the row predates the columns (undefined)', () => {
    expect(formatFanOut(meta())).toEqual([]);
  });

  it('prefers a FRESH derived count over the persisted column', () => {
    // The persisted column is only as fresh as the last scan; for a live session
    // it lags the transcript within seconds (observed: persisted 5, live 6). When
    // the caller has parsed events, that derived value is the accurate one.
    const out = plain(
      formatFanOut(meta({ subAgentCount: 53, backgroundShellCount: 9 }), {
        subAgentCount: 7,
        backgroundShellCount: 2,
      }),
    );
    expect(out).toBe('7 sub-agents · 2 background shells');
  });

  it('falls back to derived when nothing is persisted yet', () => {
    const out = plain(formatFanOut(meta(), { subAgentCount: 7, backgroundShellCount: 2 }));
    expect(out).toBe('7 sub-agents · 2 background shells');
  });
});
