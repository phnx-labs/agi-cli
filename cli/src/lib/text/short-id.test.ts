import { describe, it, expect } from 'vitest';
import { deriveShortId } from './short-id';

describe('deriveShortId', () => {
  it('slices a plain UUID to 8 chars', () => {
    expect(deriveShortId('05479a92-cbf0-4395-adb2-8e1437e0c206')).toBe('05479a92');
  });

  it('strips a known prefix before slicing', () => {
    expect(deriveShortId('session_77e466b2-d222-4fc1-900d', /^session_/)).toBe('77e466b2');
    expect(deriveShortId('api-abcdef012345', /^api-/)).toBe('abcdef01');
    expect(deriveShortId('ses_zyxwvu987654', /^ses_/)).toBe('zyxwvu98');
  });

  it('never returns empty when the strip empties the id', () => {
    expect(deriveShortId('session_', /^session_/)).toBe('session_');
    expect(deriveShortId('api-', /^api-/)).toBe('api-');
    expect(deriveShortId('ses_', /^ses_/)).toBe('ses_');
  });

  it('falls back to the raw id when it is shorter than 8 chars after strip', () => {
    expect(deriveShortId('session_ab', /^session_/)).toBe('ab');
  });

  it('is non-empty for every non-empty id', () => {
    for (const id of ['x', 'session_', 'api-', 'ses_', 'wd_muqsit', 'a-b-c']) {
      expect(deriveShortId(id, /^(session_|api-|ses_)/)).not.toBe('');
    }
  });
});
