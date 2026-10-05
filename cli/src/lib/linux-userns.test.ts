import { describe, it, expect } from 'vitest';
import {
  interpretUsernsInputs,
  probeUnshare,
  readApparmorRestrict,
  probeUnprivilegedUserns,
  APPARMOR_USERNS_SYSCTL_PATH,
} from './linux-userns.js';

describe('interpretUsernsInputs', () => {
  it('non-Linux is always ok (no bwrap/userns sandbox there)', () => {
    for (const platform of ['darwin', 'win32'] as NodeJS.Platform[]) {
      expect(
        interpretUsernsInputs({ platform, apparmorRestrict: '1', unshareProbe: 'denied' }),
      ).toEqual({ state: 'ok' });
    }
  });

  it('a successful probe wins over a restrictive sysctl (a profile may grant userns)', () => {
    expect(
      interpretUsernsInputs({ platform: 'linux', apparmorRestrict: '1', unshareProbe: 'ok' }),
    ).toEqual({ state: 'ok' });
  });

  it('a denied probe is hard-blocked, and names the AppArmor knob when it is set', () => {
    const blocked = interpretUsernsInputs({
      platform: 'linux',
      apparmorRestrict: '1',
      unshareProbe: 'denied',
    });
    expect(blocked.state).toBe('blocked');
    expect(blocked.reason).toContain('apparmor_restrict_unprivileged_userns=1');
  });

  it('a denied probe with the knob off is still blocked (no false "ok")', () => {
    expect(
      interpretUsernsInputs({ platform: 'linux', apparmorRestrict: '0', unshareProbe: 'denied' })
        .state,
    ).toBe('blocked');
  });

  it('probe tool missing + knob set => blocked (lean on the sysctl)', () => {
    expect(
      interpretUsernsInputs({ platform: 'linux', apparmorRestrict: '1', unshareProbe: 'no-tool' })
        .state,
    ).toBe('blocked');
  });

  it('probe tool missing + knob absent => unknown, never a fabricated ok', () => {
    expect(
      interpretUsernsInputs({ platform: 'linux', apparmorRestrict: null, unshareProbe: 'no-tool' })
        .state,
    ).toBe('unknown');
  });
});

describe('real host probes (no mocks)', () => {
  it('readApparmorRestrict returns the raw sysctl value or null', () => {
    const value = readApparmorRestrict();
    expect(value === null || /^\d+$/.test(value)).toBe(true);
  });

  it.runIf(process.platform === 'linux')(
    'probeUnshare observes what THIS kernel actually permits, and agrees with the sysctl',
    () => {
      const probe = probeUnshare();
      expect(['ok', 'denied', 'no-tool']).toContain(probe);

      const restrict = readApparmorRestrict();
      if (restrict === '1' && probe !== 'no-tool') {
        expect(probe).toBe('denied');
      }
    },
  );

  it('probeUnprivilegedUserns yields a coherent, cached status', () => {
    const first = probeUnprivilegedUserns();
    expect(['ok', 'blocked', 'unknown']).toContain(first.state);
    if (process.platform === 'linux') {
      expect(probeUnprivilegedUserns()).toBe(first);
    } else {
      expect(first).toEqual({ state: 'ok' });
    }
  });
});

describe('constants', () => {
  it('points at the Ubuntu AppArmor userns knob', () => {
    expect(APPARMOR_USERNS_SYSCTL_PATH).toBe(
      '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
    );
  });
});
