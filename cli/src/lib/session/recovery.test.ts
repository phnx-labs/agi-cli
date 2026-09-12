import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { RotateCandidate } from '../accounting/rotate.js';
import type { SessionMeta } from './types.js';
import {
  SessionRecoveryError,
  inspectNativeResumeSession,
  resolveSessionRecoveryFromCandidates,
  sessionMatchesAccount,
  sessionOriginDevice,
  sessionRecoveryDestinationMatches,
  sessionRecoveryPeer,
  sessionRecoveryRunArgs,
  type SessionWithAccountId,
} from './recovery.js';

function session(over: Partial<SessionWithAccountId> = {}): SessionWithAccountId {
  return {
    id: '14567b8a-db63-4e27-9867-4846813157cc',
    shortId: '14567b8a',
    agent: 'claude',
    version: '2.1.187',
    machine: 'yosemite-s0',
    timestamp: '2026-08-05T15:00:00.000Z',
    filePath: '/retained/transcript.jsonl',
    ...over,
  };
}

function candidate(version: string, over: Partial<RotateCandidate> = {}): RotateCandidate {
  return {
    agent: 'claude',
    version,
    accountKey: `claude:${version}`,
    accountLabel: version,
    email: `${version}@example.test`,
    usageKey: `claude:${version}`,
    usageStatus: null,
    usageSnapshot: null,
    usageError: null,
    usageMinutesToLimit: null,
    plan: null,
    signedIn: true,
    authVerdict: null,
    lastActive: null,
    ...over,
  };
}

describe('resolveSessionRecoveryFromCandidates', () => {
  it('native-resumes only the healthy origin version', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-recovery-native-'));
    try {
      const home = path.join(root, 'home');
      const cwd = path.join(root, 'original-project');
      const laterCwd = path.join(root, 'later-project');
      const filePath = path.join(home, '.claude', 'projects', '-original-project', `${session().id}.jsonl`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.mkdirSync(cwd);
      fs.mkdirSync(laterCwd);
      fs.writeFileSync(filePath, [
        JSON.stringify({ type: 'attachment', cwd }),
        JSON.stringify({ type: 'user', cwd: laterCwd }),
      ].join('\n') + '\n');
      const source = session({ filePath, cwd: laterCwd });
      const inspection = inspectNativeResumeSession(source, home);
      const result = resolveSessionRecoveryFromCandidates(
        source,
        [candidate('2.1.187'), candidate('2.1.218')],
        () => true,
        inspection,
      );
      expect(result).toMatchObject({ mode: 'native', agent: 'claude', version: '2.1.187', cwd });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('native-resumes the origin home on a rotated provider account when the origin login is limited', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-recovery-rotate-'));
    try {
      const home = path.join(root, 'home');
      const cwd = path.join(root, 'original-project');
      const filePath = path.join(home, '.claude', 'projects', '-original-project', `${session().id}.jsonl`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.mkdirSync(cwd);
      fs.writeFileSync(filePath, JSON.stringify({ type: 'attachment', cwd }) + '\n');
      const source = session({ filePath, cwd });
      const inspection = inspectNativeResumeSession(source, home);
      const result = resolveSessionRecoveryFromCandidates(
        source,
        [
          // Origin login (native, same version) is rate-limited...
          candidate('2.1.187', { usageStatus: 'rate_limited' }),
          // ...but a healthy provider account of the SAME harness is injectable.
          candidate('2.1.187', {
            accountKey: 'provider:tech',
            accountLabel: 'tech',
            email: 'tech@example.test',
            usageKey: null,
            providerAccount: 'tech',
          }),
        ],
        () => true,
        inspection,
      );
      expect(result).toMatchObject({
        mode: 'native',
        agent: 'claude',
        version: '2.1.187',
        cwd,
        account: { providerAccount: 'tech', label: 'tech' },
      });
      expect(result.reason).toContain('rate_limited');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not native-rotate to a different version home; a native sibling uses /continue', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-recovery-no-provider-'));
    try {
      const home = path.join(root, 'home');
      const cwd = path.join(root, 'original-project');
      const filePath = path.join(home, '.claude', 'projects', '-original-project', `${session().id}.jsonl`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.mkdirSync(cwd);
      fs.writeFileSync(filePath, JSON.stringify({ type: 'attachment', cwd }) + '\n');
      const source = session({ filePath, cwd });
      const inspection = inspectNativeResumeSession(source, home);
      const result = resolveSessionRecoveryFromCandidates(
        source,
        [
          // Origin login limited, and the only healthy sibling is a NATIVE login
          // in another version home (no provider account to inject) → /continue.
          candidate('2.1.187', { usageStatus: 'rate_limited' }),
          candidate('2.1.218'),
        ],
        () => true,
        inspection,
      );
      expect(result).toMatchObject({ mode: 'continue', agent: 'claude', version: '2.1.218' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses /continue on a healthy same-harness version when the origin is signed out', () => {
    const result = resolveSessionRecoveryFromCandidates(
      session(),
      [candidate('2.1.187', { signedIn: false }), candidate('2.1.218')],
      () => true,
    );
    expect(result).toMatchObject({ mode: 'continue', agent: 'claude', version: '2.1.218' });
    expect(result.reason).toContain('signed_out');
  });

  it('does NOT native-rotate a signed-out origin, even with a healthy provider account (needs a login, not a rotation)', () => {
    // Native-rotate is gated on a usage/rate LIMIT, not signed_out/revoked
    // (SES-39): a signed-out origin has no credential to resume under and must
    // take the /continue path. The continue pick of the healthy provider still
    // carries RecoveryAccount so exec injects it instead of launching the
    // signed-out native login.
    const result = resolveSessionRecoveryFromCandidates(
      session(),
      [
        candidate('2.1.187', { signedIn: false }),
        candidate('2.1.187', {
          accountKey: 'provider:tech',
          accountLabel: 'tech',
          usageKey: null,
          providerAccount: 'tech',
        }),
      ],
      () => true,
      { available: true, cwd: '/repo/origin-transcript' },
    );
    expect(result).toMatchObject({
      mode: 'continue',
      agent: 'claude',
      version: '2.1.187',
      account: { providerAccount: 'tech', label: 'tech' },
    });
  });

  it('does not launch the exhausted native login when origin is limited, transcript is outside the origin home, and a healthy provider is available', () => {
    // PHNX-3674: native-rotate does not fire when inspection.available is false
    // (trash/backup/reinstall, or a local /continue fallback from an unreachable
    // peer). The continue pick of the healthy provider must carry RecoveryAccount
    // so exec injects it — a credentialless continue on 2.1.187 would spawn as
    // the rate-limited origin login.
    const result = resolveSessionRecoveryFromCandidates(
      session(),
      [
        candidate('2.1.187', { usageStatus: 'rate_limited' }),
        candidate('2.1.187', {
          accountKey: 'provider:tech',
          accountLabel: 'tech',
          email: 'tech@example.test',
          usageKey: null,
          providerAccount: 'tech',
        }),
      ],
      () => true,
      { available: false, reason: 'the indexed transcript is retained outside the active claude@2.1.187 home' },
    );
    expect(result.mode).not.toBe('native');
    expect(result).toMatchObject({
      mode: 'continue',
      agent: 'claude',
      version: '2.1.187',
      account: { providerAccount: 'tech', label: 'tech' },
    });
    expect(result.reason).toContain('rate_limited');
    expect(result.reason).toContain('tech');
  });

  it('keeps a healthy origin home for /continue when the harness has no native resume form', () => {
    const result = resolveSessionRecoveryFromCandidates(
      session(),
      [candidate('2.1.187'), candidate('2.1.218')],
      () => false,
    );
    expect(result).toMatchObject({ mode: 'continue', agent: 'claude', version: '2.1.187' });
  });

  it('never native-resumes from a different isolated version home', () => {
    const result = resolveSessionRecoveryFromCandidates(
      session(),
      [candidate('2.1.218')],
      () => true,
    );
    expect(result.mode).toBe('continue');
    expect(result.version).toBe('2.1.218');
    expect(result.reason).toContain('2.1.187 is not installed');
  });

  it('uses /continue when a same-number reinstall does not own the retained transcript', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-recovery-trash-'));
    try {
      const home = path.join(root, 'active-home');
      const retained = path.join(root, 'trash', `${session().id}.jsonl`);
      fs.mkdirSync(home, { recursive: true });
      fs.mkdirSync(path.dirname(retained), { recursive: true });
      fs.writeFileSync(retained, '{}\n');
      const source = session({ filePath: retained });
      const result = resolveSessionRecoveryFromCandidates(
        source,
        [candidate('2.1.187')],
        () => true,
        inspectNativeResumeSession(source, home),
      );
      expect(result).toMatchObject({ mode: 'continue', agent: 'claude', version: '2.1.187' });
      expect(result.reason).toContain('retained outside the active claude@2.1.187 home');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rotates to a healthy sibling account when the origin version is rate-limited (balanced)', () => {
    // Origin 2.1.187 is throttled → the balanced picker selects a DIFFERENT
    // healthy account of the SAME harness. It resumes via /continue there (a
    // different isolated home does not own the origin transcript for native
    // resume), continuing the same session on the rotated account (PHNX-3626).
    const result = resolveSessionRecoveryFromCandidates(
      session(),
      [candidate('2.1.187', { usageStatus: 'rate_limited' }), candidate('2.1.218')],
      () => true,
    );
    expect(result).toMatchObject({ mode: 'continue', agent: 'claude', version: '2.1.218' });
    expect(result.reason).toContain('rate_limited');
  });

  it('falls back to a healthy version when the origin version was not recorded', () => {
    // The observed codex bug: no recorded origin version → cannot native-resume a
    // specific home, so balanced picks a healthy same-harness version and the log
    // names why (Validation: missing recorded version → healthy-latest, logged).
    const result = resolveSessionRecoveryFromCandidates(
      session({ version: undefined }),
      [candidate('2.1.218')],
      () => true,
    );
    expect(result).toMatchObject({ mode: 'continue', agent: 'claude', version: '2.1.218' });
    expect(result.reason).toContain('the origin version was not recorded');
  });

  it('fails with the concrete device, origin version, and account reason', () => {
    expect(() => resolveSessionRecoveryFromCandidates(
      session(),
      [candidate('2.1.187', { usageStatus: 'rate_limited' })],
      () => true,
    )).toThrowError(SessionRecoveryError);
    expect(() => resolveSessionRecoveryFromCandidates(
      session(),
      [candidate('2.1.187', { usageStatus: 'rate_limited' })],
      () => true,
    )).toThrow(/yosemite-s0.*claude@2\.1\.187.*rate_limited/);
  });
});

describe('resolveSessionRecoveryFromCandidates — account disambiguation (PHNX-3940)', () => {
  function nativeHomeFixture(root: string, id: string) {
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'original-project');
    const filePath = path.join(home, '.claude', 'projects', '-original-project', `${id}.jsonl`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.mkdirSync(cwd);
    fs.writeFileSync(filePath, JSON.stringify({ type: 'attachment', cwd }) + '\n');
    return { home, cwd, filePath };
  }

  it('disambiguates two accounts sharing one managed binary via the persisted sidecar accountId', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-recovery-two-accounts-id-'));
    try {
      const a = nativeHomeFixture(path.join(root, 'a'), session().id);
      const b = nativeHomeFixture(path.join(root, 'b'), session().id);
      // Both accounts run claude@2.1.187 (one managed binary) but only 'b' has
      // the transcript. The sidecar accountId names 'b' directly — matching
      // must not fall back to whichever same-version candidate appears first.
      const source = session({ filePath: b.filePath, cwd: b.cwd, accountId: 'acct-b' });
      const slotA = path.join(root, 'slots', 'acct-a');
      const slotB = path.join(root, 'slots', 'acct-b');
      fs.mkdirSync(path.dirname(slotA), { recursive: true });
      fs.symlinkSync(a.home, slotA);
      fs.symlinkSync(b.home, slotB);
      const candidates = [
        candidate('2.1.187', { accountKey: 'claude:a', fromSlot: true, slotDir: slotA }),
        candidate('2.1.187', { accountKey: 'claude:b', fromSlot: true, slotDir: slotB }),
      ];

      const result = resolveSessionRecoveryFromCandidates(source, candidates, () => true);
      expect(result).toMatchObject({ mode: 'native', agent: 'claude', version: '2.1.187', cwd: b.cwd });
      expect(result.candidate.accountKey).toBe('claude:b');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('disambiguates two accounts sharing one managed binary via transcript ownership when there is no sidecar id', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-recovery-two-accounts-path-'));
    try {
      const a = nativeHomeFixture(path.join(root, 'a'), session().id);
      const b = nativeHomeFixture(path.join(root, 'b'), session().id);
      const source = session({ filePath: b.filePath, cwd: b.cwd });
      const slotA = path.join(root, 'slots', 'acct-a');
      const slotB = path.join(root, 'slots', 'acct-b');
      fs.mkdirSync(path.dirname(slotA), { recursive: true });
      fs.symlinkSync(a.home, slotA);
      fs.symlinkSync(b.home, slotB);
      const candidates = [
        candidate('2.1.187', { accountKey: 'claude:a', fromSlot: true, slotDir: slotA }),
        candidate('2.1.187', { accountKey: 'claude:b', fromSlot: true, slotDir: slotB }),
      ];

      const result = resolveSessionRecoveryFromCandidates(source, candidates, () => true);
      expect(result).toMatchObject({ mode: 'native', agent: 'claude', version: '2.1.187', cwd: b.cwd });
      expect(result.candidate.accountKey).toBe('claude:b');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stays honest — unknown attribution — when two accounts share a version and neither can be proven', () => {
    const result = resolveSessionRecoveryFromCandidates(
      session(),
      [candidate('2.1.187', { accountKey: 'claude:a' }), candidate('2.1.187', { accountKey: 'claude:b' })],
      () => true,
    );
    expect(result.mode).toBe('continue');
    expect(result.reason).toContain('attribution is unknown');
  });

  it('matches the sidecar accountId across a version relabel (vendor auto-update)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-recovery-relabel-'));
    try {
      const home = nativeHomeFixture(root, session().id);
      // The transcript was recorded under 2.1.187, but the vendor relabeled the
      // installed binary to 2.1.220 — only the persisted accountId proves origin.
      const source = session({ filePath: home.filePath, cwd: home.cwd, version: '2.1.187', accountId: 'acct-relabel' });
      const slot = path.join(root, 'slots', 'acct-relabel');
      fs.mkdirSync(path.dirname(slot), { recursive: true });
      fs.symlinkSync(home.home, slot);
      const candidates = [candidate('2.1.220', { accountKey: 'claude:relabel', fromSlot: true, slotDir: slot })];

      const result = resolveSessionRecoveryFromCandidates(source, candidates, () => true);
      expect(result).toMatchObject({ mode: 'native', agent: 'claude', version: '2.1.220', cwd: home.cwd });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('never native-resumes on a symlinked account home — ownership still resolves through the real path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-recovery-symlink-'));
    try {
      const real = nativeHomeFixture(path.join(root, 'real'), session().id);
      const slot = path.join(root, 'slots', 'acct-sym');
      fs.mkdirSync(path.dirname(slot), { recursive: true });
      fs.symlinkSync(real.home, slot);
      const source = session({ filePath: real.filePath, cwd: real.cwd });
      const candidates = [candidate('2.1.187', { fromSlot: true, slotDir: slot })];

      const result = resolveSessionRecoveryFromCandidates(source, candidates, () => true);
      expect(result).toMatchObject({ mode: 'native', agent: 'claude', version: '2.1.187', cwd: real.cwd });
      expect(result.mode === 'native' ? result.execHome : undefined).toBe(slot);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('explicit account: resumes natively when the requested account is the proven origin', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-recovery-explicit-match-'));
    try {
      const home = nativeHomeFixture(root, session().id);
      const source = session({ filePath: home.filePath, cwd: home.cwd });
      const slot = path.join(root, 'slots', 'acct-mine');
      fs.mkdirSync(path.dirname(slot), { recursive: true });
      fs.symlinkSync(home.home, slot);
      const candidates = [
        candidate('2.1.187', { accountKey: 'claude:mine', accountLabel: 'mine', email: 'mine@example.test', nativeAccount: 'mine', fromSlot: true, slotDir: slot }),
      ];

      const result = resolveSessionRecoveryFromCandidates(source, candidates, () => true, undefined, { account: 'mine' });
      expect(result).toMatchObject({ mode: 'native', agent: 'claude', version: '2.1.187', cwd: home.cwd });
      expect(result.reason).toContain('is the session origin');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('explicit account mismatch: never silently native-resumes under a different identity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-recovery-explicit-mismatch-'));
    try {
      const owner = nativeHomeFixture(path.join(root, 'owner'), session().id);
      const other = nativeHomeFixture(path.join(root, 'other'), session().id);
      const source = session({ filePath: owner.filePath, cwd: owner.cwd });
      const ownerSlot = path.join(root, 'slots', 'owner');
      const otherSlot = path.join(root, 'slots', 'other');
      fs.mkdirSync(path.dirname(ownerSlot), { recursive: true });
      fs.symlinkSync(owner.home, ownerSlot);
      fs.symlinkSync(other.home, otherSlot);
      const candidates = [
        candidate('2.1.187', { accountKey: 'claude:owner', accountLabel: 'owner', nativeAccount: 'owner', fromSlot: true, slotDir: ownerSlot }),
        candidate('2.1.187', { accountKey: 'claude:other', accountLabel: 'other', nativeAccount: 'other', fromSlot: true, slotDir: otherSlot }),
      ];

      const result = resolveSessionRecoveryFromCandidates(source, candidates, () => true, undefined, { account: 'other' });
      expect(result.mode).toBe('continue');
      expect(result.candidate.accountKey).toBe('claude:other');
      expect(result.reason).toContain('differs from the session');
      expect(result.reason).toContain('interactive confirmation');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('explicit account: fails loud when the requested account is not a signed-in candidate', () => {
    expect(() => resolveSessionRecoveryFromCandidates(
      session(),
      [candidate('2.1.187')],
      () => true,
      undefined,
      { account: 'nobody' },
    )).toThrowError(SessionRecoveryError);
  });

  it('a provider (injected-credential) account never claims transcript ownership, even riding the same version home', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-recovery-provider-truthful-'));
    try {
      const home = nativeHomeFixture(root, session().id);
      const source = session({ filePath: home.filePath, cwd: home.cwd });
      const candidates = [
        candidate('2.1.187', { usageStatus: 'rate_limited' }),
        candidate('2.1.187', {
          accountKey: 'provider:tech',
          accountLabel: 'tech',
          nativeAccount: 'tech',
          usageKey: null,
          providerAccount: 'tech',
        }),
      ];
      const result = resolveSessionRecoveryFromCandidates(
        source,
        candidates,
        () => true,
        inspectNativeResumeSession(source, home.home),
        { account: 'tech' },
      );
      // The provider account is healthy and requested, but it is never the
      // proven origin — it authenticates the existing origin context via
      // rotation, never masquerades as having produced the transcript itself.
      expect(result.mode).toBe('continue');
      expect(result.candidate.providerAccount).toBe('tech');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a legacy version-home candidate (no slot) is still truthfully matched by transcript ownership', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-recovery-legacy-'));
    try {
      const home = nativeHomeFixture(root, session().id);
      const source = session({ filePath: home.filePath, cwd: home.cwd });
      // No fromSlot/slotDir — a pre-migration install, identified only by version.
      const result = resolveSessionRecoveryFromCandidates(
        source,
        [candidate('2.1.187')],
        () => true,
        inspectNativeResumeSession(source, home.home),
      );
      expect(result).toMatchObject({ mode: 'native', agent: 'claude', version: '2.1.187', cwd: home.cwd });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('sessionMatchesAccount', () => {
  it('matches on the persisted sidecar accountId regardless of path', () => {
    const s = { agent: 'claude' as const, filePath: '/anywhere/session.jsonl', accountId: 'acct-1' };
    expect(sessionMatchesAccount(s, { id: 'acct-1', agent: 'claude' })).toBe(true);
    expect(sessionMatchesAccount(s, { id: 'acct-2', agent: 'claude' })).toBe(false);
  });

  it('never matches across a different agent, even with the same accountId', () => {
    const s = { agent: 'claude' as const, filePath: '/anywhere/session.jsonl', accountId: 'acct-1' };
    expect(sessionMatchesAccount(s, { id: 'acct-1', agent: 'codex' })).toBe(false);
  });

  it('falls back to canonical transcript ownership when there is no sidecar accountId', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-recovery-matches-account-'));
    try {
      const home = path.join(root, 'home');
      fs.mkdirSync(home, { recursive: true });
      const filePath = path.join(home, 'transcript.jsonl');
      fs.writeFileSync(filePath, '{}\n');
      const s = { agent: 'claude' as const, filePath };
      expect(sessionMatchesAccount(s, { id: 'acct-1', agent: 'claude' }, home)).toBe(true);
      expect(sessionMatchesAccount(s, { id: 'acct-1', agent: 'claude' }, path.join(root, 'other-home'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stays unknown (false) with no accountId and no home to prove ownership', () => {
    const s = { agent: 'claude' as const, filePath: '/anywhere/session.jsonl' };
    expect(sessionMatchesAccount(s, { id: 'acct-1', agent: 'claude' })).toBe(false);
  });
});

describe('sessionRecoveryRunArgs', () => {
  it('routes focus, resume, and attach through run auto --resume', () => {
    expect(sessionRecoveryRunArgs(session())).toEqual([
      'run', 'auto', '--resume', '14567b8a-db63-4e27-9867-4846813157cc', '--interactive',
    ]);
  });
});

describe('session recovery placement', () => {
  it('normalizes the indexed origin device', () => {
    expect(sessionOriginDevice(session({ machine: 'YOSEMITE-S0.tail.ts.net' }), 'zion')).toBe('yosemite-s0');
    expect(sessionOriginDevice(session({ machine: undefined }), 'ZION.local')).toBe('zion');
  });

  it('returns a peer only when recovery is not already on the origin', () => {
    expect(sessionRecoveryPeer(session(), (host) => host === 'yosemite-s0')).toBeUndefined();
    expect(sessionRecoveryPeer(session(), () => false)).toBe('yosemite-s0');
  });

  it('matches explicit user@host placement only to the origin', () => {
    expect(sessionRecoveryDestinationMatches(session(), 'muqsit@yosemite-s0', 'zion')).toBe(true);
    expect(sessionRecoveryDestinationMatches(session(), 'zion', 'zion')).toBe(false);
  });
});
