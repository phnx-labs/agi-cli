import { describe, expect, it } from 'vitest';
import { cleanShotStem, isRecordingFile, slugifyRecordingStem } from './model.js';

describe('CleanShot recording identity', () => {
  it('folds numbered re-exports onto the original CleanShot stem and slug', () => {
    const original = 'CleanShot 2026-10-08 at 4.51.47 AM.mp4';
    const reexport = 'CleanShot 2026-10-08 at 4.51.47 AM 3.mp4';
    expect(cleanShotStem(original)).toBe('CleanShot 2026-10-08 at 4.51.47 AM');
    expect(cleanShotStem(reexport)).toBe(cleanShotStem(original));
    expect(slugifyRecordingStem(cleanShotStem(reexport))).toBe('cleanshot-2026-10-08-at-4-51-47-am');
  });

  it('does not strip a legitimate numeric suffix from a non-CleanShot filename', () => {
    expect(cleanShotStem('customer-demo 3.mov')).toBe('customer-demo 3');
  });

  it('accepts only mp4 and mov files, case-insensitively', () => {
    expect(isRecordingFile('clip.MP4')).toBe(true);
    expect(isRecordingFile('clip.mov')).toBe(true);
    expect(isRecordingFile('clip.webm')).toBe(false);
  });
});
