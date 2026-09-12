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
  sessionOriginDevice,
  sessionRecoveryDestinationMatches,
  sessionRecoveryPeer,
  sessionRecoveryRunArgs,
} from './recovery.js';

function session(over: Partial<SessionMeta> = {}): SessionMeta {
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

describe('resolveSessionRecoveryFromCandidates — account-first origin identification', () => {
  it('resumes the exact slot account that produced the session when several accounts share one installed binary', () => {
    // Account-first: every native slot for one harness reports the SAME
    // installed binary version (PHNX-3940 T5), so version alone cannot tell
    // two accounts apart — only identity (accountKey) or transcript ownership
    // (slotDir) can.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-recovery-slots-'));
    try {
      const homeA = path.join(root, 'slot-a');
      const homeB = path.join(root, 'slot-b');
      const cwd = path.join(root, 'project');
      fs.mkdirSync(cwd);
      const filePath = path.join(homeA, '.claude', 'projects', '-project', `${session().id}.jsonl`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.mkdirSync(homeB, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ type: 'attachment', cwd }) + '\n');

      const source = session({ filePath, accountKey: 'claude:acct-a' });
      // The WRONG account (B) is listed first — a naive version-only match
      // would pick it, since both share the single installed binary version.
      const candidates: RotateCandidate[] = [
        candidate('2.1.269', {
          accountKey: 'claude:acct-b', accountLabel: 'acct-b',
          nativeAccount: 'acct-b', slotDir: homeB, fromSlot: true, authVerdict: 'live',
        }),
        candidate('2.1.269', {
          accountKey: 'claude:acct-a', accountLabel: 'acct-a',
          nativeAccount: 'acct-a', slotDir: homeA, fromSlot: true, authVerdict: 'live',
        }),
      ];
      const result = resolveSessionRecoveryFromCandidates(source, candidates, () => true);
      expect(result).toMatchObject({
        mode: 'native',
        agent: 'claude',
        version: '2.1.269',
        cwd,
        account: { nativeAccount: 'acct-a', selector: 'acct-a' },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('proves ownership by transcript location when the session carries no accountKey', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-recovery-slots-nokey-'));
    try {
      const homeA = path.join(root, 'slot-a');
      const homeB = path.join(root, 'slot-b');
      const cwd = path.join(root, 'project');
      fs.mkdirSync(cwd);
      const filePath = path.join(homeB, '.claude', 'projects', '-project', `${session().id}.jsonl`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.mkdirSync(homeA, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ type: 'attachment', cwd }) + '\n');

      // No accountKey recorded (a legacy transcript predating attribution) —
      // recovery must still find the right slot by proving which home's
      // transcript this actually is, not by an ambiguous version match.
      const source = session({ filePath });
      const candidates: RotateCandidate[] = [
        candidate('2.1.269', {
          accountKey: 'claude:acct-a', accountLabel: 'acct-a',
          nativeAccount: 'acct-a', slotDir: homeA, fromSlot: true, authVerdict: 'live',
        }),
        candidate('2.1.269', {
          accountKey: 'claude:acct-b', accountLabel: 'acct-b',
          nativeAccount: 'acct-b', slotDir: homeB, fromSlot: true, authVerdict: 'live',
        }),
      ];
      const result = resolveSessionRecoveryFromCandidates(source, candidates, () => true);
      expect(result).toMatchObject({
        mode: 'native',
        version: '2.1.269',
        cwd,
        account: { nativeAccount: 'acct-b' },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('native-resumes the origin account even when its installed alias reports a different version label than the session recorded', () => {
    // The recorded label can drift from the live binary's reported version (a
    // self-updating install, or an alias whose binary prints a newer label
    // than the one it was launched under). Recovery must follow the ACCOUNT,
    // not stall on the stale label and fall through to a brand-new /continue.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-recovery-alias-'));
    try {
      const home = path.join(root, 'home');
      const cwd = path.join(root, 'project');
      fs.mkdirSync(cwd);
      const filePath = path.join(home, '.claude', 'projects', '-project', `${session().id}.jsonl`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ type: 'attachment', cwd }) + '\n');

      // Recorded at launch time as 2.1.269 (missing/uninstalled today); the
      // account that actually produced it now resolves under alias 2.1.225.
      const source = session({ filePath, version: '2.1.269', accountKey: 'claude:acct-a' });
      const candidates: RotateCandidate[] = [
        candidate('2.1.225', {
          accountKey: 'claude:acct-a', accountLabel: 'acct-a',
          nativeAccount: 'acct-a', slotDir: home, fromSlot: true, authVerdict: 'live',
        }),
      ];
      const result = resolveSessionRecoveryFromCandidates(source, candidates, () => true);
      expect(result).toMatchObject({ mode: 'native', version: '2.1.225', cwd });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not native-resume a healthy sibling slot account for a rotated pick — /continue instead', () => {
    // The balanced pick when the origin is unhealthy may land on a DIFFERENT
    // native slot account of the same harness. That sibling's home never
    // produced this transcript, so it must stay on /continue even though it
    // is itself perfectly healthy (only a provider account can be forwarded
    // into the origin's own home — see the PHNX-3626 rotation branch).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-recovery-sibling-'));
    try {
      const homeA = path.join(root, 'slot-a');
      const homeB = path.join(root, 'slot-b');
      const cwd = path.join(root, 'project');
      fs.mkdirSync(cwd);
      const filePath = path.join(homeA, '.claude', 'projects', '-project', `${session().id}.jsonl`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.mkdirSync(homeB, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ type: 'attachment', cwd }) + '\n');

      const source = session({ filePath, accountKey: 'claude:acct-a' });
      const candidates: RotateCandidate[] = [
        candidate('2.1.269', {
          accountKey: 'claude:acct-a', accountLabel: 'acct-a', nativeAccount: 'acct-a',
          slotDir: homeA, fromSlot: true, authVerdict: 'live', usageStatus: 'rate_limited',
        }),
        candidate('2.1.269', {
          accountKey: 'claude:acct-b', accountLabel: 'acct-b', nativeAccount: 'acct-b',
          slotDir: homeB, fromSlot: true, authVerdict: 'live',
        }),
      ];
      const result = resolveSessionRecoveryFromCandidates(source, candidates, () => true);
      expect(result).toMatchObject({
        mode: 'continue',
        version: '2.1.269',
        account: { nativeAccount: 'acct-b' },
      });
      expect(result.reason).toContain('rate_limited');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
