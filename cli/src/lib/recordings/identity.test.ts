import { describe, expect, it } from 'vitest';
import { isPublicInboxEmail } from './identity.js';

describe('recording organization identity guard', () => {
  it('rejects common public inbox domains', () => {
    for (const email of ['person@gmail.com', 'person@icloud.com', 'person@outlook.com', 'person@yahoo.com', 'person@proton.me']) {
      expect(isPublicInboxEmail(email), email).toBe(true);
    }
  });

  it('allows an organization-owned domain', () => {
    expect(isPublicInboxEmail('recorder@example.com')).toBe(false);
  });
});
