import { describe, expect, it } from 'vitest';
import { planDuplicatePrune, pruneGroupKey, type PruneCandidate } from './duplicate-prune.js';

describe('pruneGroupKey — duplicate detection identity', () => {
  it('keeps same-email installs in different orgs in separate prune groups', () => {
    const max = pruneGroupKey({
      accountKey: 'claude:account:acc-1:org:org-personal',
      email: 'taylor@example.com',
    });
    const team = pruneGroupKey({
      accountKey: 'claude:account:acc-1:org:org-team',
      email: 'taylor@example.com',
    });
    expect(max).not.toBeNull();
    expect(max).not.toBe(team);
  });

  it('groups installs with the same accountKey together', () => {
    const a = pruneGroupKey({ accountKey: 'claude:account:acc-1:org:org-1', email: 'a@x.com' });
    const b = pruneGroupKey({ accountKey: 'claude:account:acc-1:org:org-1', email: 'A@X.COM' });
    expect(a).toBe(b);
  });

  it('falls back to the lowercased email when no accountKey exists', () => {
    expect(pruneGroupKey({ accountKey: null, email: 'Taylor@Example.com' }))
      .toBe('taylor@example.com');
  });

  it('returns null when there is no identity at all', () => {
    expect(pruneGroupKey({ accountKey: null, email: null })).toBeNull();
  });
});

describe('planDuplicatePrune — collapse to one home per account', () => {
  const home = (o: Partial<PruneCandidate> & { version: string }): PruneCandidate => ({
    release: o.version,
    email: null,
    accountKey: null,
    signedIn: true,
    hasBinary: true,
    ...o,
  });


  it('keeps the identity-captured home and retires the higher-numbered NO-ID re-login duplicate', () => {
    const out = planDuplicatePrune([
      home({ version: '2.1.222', release: '2.1.263', email: 'a@x.com', accountKey: 'claude:account=acc-1:org=org-1' }),
      home({ version: '2.1.257', release: '2.1.263', email: 'a@x.com', accountKey: null }),
    ]);
    expect(out).toEqual([{ version: '2.1.257', email: 'a@x.com', keeper: '2.1.222' }]);
  });

  it('never merges two DIFFERENT org accounts that share an email', () => {
    const out = planDuplicatePrune([
      home({ version: '2.1.200', email: 'a@x.com', accountKey: 'claude:account=acc-1:org=personal' }),
      home({ version: '2.1.201', email: 'a@x.com', accountKey: 'claude:account=acc-2:org=team' }),
    ]);
    expect(out).toEqual([]);
  });

  it('collapses same-accountKey duplicates, keeping the newest running release', () => {
    const out = planDuplicatePrune([
      home({ version: '2.1.100', release: '2.1.263', email: 'a@x.com', accountKey: 'k1' }),
      home({ version: '2.1.150', release: '2.1.240', email: 'a@x.com', accountKey: 'k1' }),
    ]);
    expect(out).toEqual([{ version: '2.1.150', email: 'a@x.com', keeper: '2.1.100' }]);
  });

  it('leaves a lone home for an account untouched', () => {
    expect(planDuplicatePrune([
      home({ version: '2.1.222', email: 'a@x.com', accountKey: 'k1' }),
    ])).toEqual([]);
  });

  it('ignores homes with no binary (they never compete for the live install)', () => {
    const out = planDuplicatePrune([
      home({ version: '2.1.222', email: 'a@x.com', accountKey: 'k1' }),
      home({ version: '2.1.257', email: 'a@x.com', accountKey: null, hasBinary: false }),
    ]);
    expect(out).toEqual([]);
  });

  it('collapses two equally-bare email-only homes toward the newer release', () => {
    const out = planDuplicatePrune([
      home({ version: '2.1.100', release: '2.1.200', email: 'a@x.com', accountKey: null }),
      home({ version: '2.1.110', release: '2.1.263', email: 'a@x.com', accountKey: null }),
    ]);
    expect(out).toEqual([{ version: '2.1.100', email: 'a@x.com', keeper: '2.1.110' }]);
  });


  it('never folds an identity-less home when two orgs share the email (prunes nothing)', () => {
    const out = planDuplicatePrune([
      home({ version: '2.1.100', email: 'a@x.com', accountKey: 'org-1', signedIn: true }),
      home({ version: '2.1.150', email: 'a@x.com', accountKey: 'org-2', signedIn: false }),
      home({ version: '2.1.200', email: 'a@x.com', accountKey: null, signedIn: true }),
    ]);
    expect(out).toEqual([]);
  });


  it('breaks a same-group keeper tie on signed-in before release/label', () => {
    const out = planDuplicatePrune([
      home({ version: '2.1.110', release: '2.1.263', email: 'a@x.com', accountKey: null, signedIn: false }),
      home({ version: '2.1.100', release: '2.1.263', email: 'a@x.com', accountKey: null, signedIn: true }),
    ]);
    expect(out).toEqual([{ version: '2.1.110', email: 'a@x.com', keeper: '2.1.100' }]);
  });
});
