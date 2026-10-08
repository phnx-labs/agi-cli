import { describe, expect, it } from 'vitest';
import { buildArtifactsRecordingArgs } from './pipeline.js';
import type { RecordingCandidate } from './model.js';

describe('recording artifacts contract', () => {
  it('builds the organization-only publish with capture metadata and one session', () => {
    const candidate: RecordingCandidate = {
      path: '/recordings/source.mp4',
      stem: 'CleanShot 2026-10-08 at 4.51.47 AM',
      slug: 'cleanshot-2026-10-08-at-4-51-47-am',
      size: 100,
      mtimeMs: 200,
      recordedAt: '2026-10-08T11:51:47.000Z',
      sessionId: 'session-123',
    };
    expect(buildArtifactsRecordingArgs(candidate, '/tmp/transcoded.mp4', 'device-one')).toEqual([
      'share', '/tmp/transcoded.mp4',
      '--visibility', 'org',
      '--expire', 'never',
      '--slug', 'cleanshot-2026-10-08-at-4-51-47-am',
      '--meta', 'source=cleanshot',
      '--meta', 'host=device-one',
      '--meta', 'recorded_at=2026-10-08T11:51:47.000Z',
      '--meta', 'stem=CleanShot 2026-10-08 at 4.51.47 AM',
      '--meta', 'session=session-123',
      '--json',
    ]);
  });
});
