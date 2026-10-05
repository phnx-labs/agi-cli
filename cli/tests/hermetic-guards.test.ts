import { describe, it, expect } from 'vitest';
import { shouldArmHermeticGuards, shouldEnableCiTestProfile } from './hermetic-guards';

describe('shouldEnableCiTestProfile', () => {
  it('is true on a genuine CI runner (CI=true)', () => {
    expect(shouldEnableCiTestProfile({ CI: 'true' })).toBe(true);
  });

  it('is true for the attestation producer even with no CI var at all', () => {
    expect(shouldEnableCiTestProfile({ AGENTS_ATTEST_PRODUCER: '1' })).toBe(true);
  });

  it('is true when both are set (a CI runner that also sets the producer flag)', () => {
    expect(shouldEnableCiTestProfile({ CI: 'true', AGENTS_ATTEST_PRODUCER: '1' })).toBe(true);
  });

  it('is false with neither set (a plain local dev run)', () => {
    expect(shouldEnableCiTestProfile({})).toBe(false);
  });
});

describe('shouldArmHermeticGuards', () => {
  it('arms on a genuine CI runner (CI=true, no producer flag)', () => {
    expect(shouldArmHermeticGuards({ CI: 'true' })).toBe(true);
  });

  it('arms for any truthy CI value, not just the literal string "true"', () => {
    expect(shouldArmHermeticGuards({ CI: '1' })).toBe(true);
  });

  it('does NOT arm for the attestation producer, even if CI=true leaked into its env — the RUSH-3007 incident', () => {
    expect(shouldArmHermeticGuards({ CI: 'true', AGENTS_ATTEST_PRODUCER: '1' })).toBe(false);
  });

  it('does not arm with neither var set', () => {
    expect(shouldArmHermeticGuards({})).toBe(false);
  });

  it('does not arm when CI is set but empty (CI= from a shell that cleared it)', () => {
    expect(shouldArmHermeticGuards({ CI: '' })).toBe(false);
  });

  it('does not arm for the producer flag alone, with no CI var at all', () => {
    expect(shouldArmHermeticGuards({ AGENTS_ATTEST_PRODUCER: '1' })).toBe(false);
  });
});
