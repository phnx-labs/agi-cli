import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { RotateCandidate } from '../accounting/rotate.js';
import type { SessionMeta } from './types.js';
import {
  SessionRecoveryError,
  inspectNativeResumeSession,
  resolveSessionRecovery,
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

describe('resolveSessionRecovery transcript guard', () => {
  const healthy = async () => [candidate('2.1.200')];

  it('refuses a live-registry row that never wrote a transcript', async () => {
    // The exact shape activeSessionToSessionMeta synthesizes for a session the
    // registry calls running before (or without) any transcript on disk.
    const phantom = session({ filePath: '', version: undefined, machine: 'zion' });
    await expect(resolveSessionRecovery(phantom, healthy)).rejects.toThrowError(SessionRecoveryError);
    await expect(resolveSessionRecovery(phantom, healthy))
      .rejects.toThrow(/14567b8a.*no transcript for it was ever written on zion/s);
  });

  it('names the harness and cwd a replacement run would need', async () => {
    const phantom = session({ filePath: '', machine: 'zion', cwd: '/Users/x/src/agents-cli' });
    await expect(resolveSessionRecovery(phantom, healthy))
      .rejects.toThrow('agents run claude --cwd /Users/x/src/agents-cli');
  });

  it('refuses a locally owned session whose transcript is gone', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-recovery-gone-'));
    const missing = path.join(root, 'deleted.jsonl');
    await expect(resolveSessionRecovery(session({ filePath: missing }), healthy))
      .rejects.toThrow(/transcript is gone from yosemite-s0/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('still recovers a fan-out row whose peer path does not exist on this box', async () => {
    // parseRemoteList rows carry the PEER's absolute path, meaningless here
    // (/Users vs /home); existence is the owner's to judge.
    const target = await resolveSessionRecovery(
      session({ filePath: '/home/muqsit/.agents/peer.jsonl', _remote: true }),
      healthy,
    );
    expect(target.mode).toBe('continue');
  });

  it('still recovers a fleet-synced mirror stub after the owner goes unreachable (PHNX-3626)', async () => {
    // The real input shape of the owner-unreachable fallback, which the
    // `_remote` exemption alone did NOT cover: upsertMirrorSession writes
    // file_path='' and rowToMeta sets no `_remote`, so the stub arrives with an
    // empty path and only `mirrorSyncedAt` to identify it. resumeLocalFallbackSource
    // then rewrites `machine` to self — so machine is NOT a usable discriminator
    // here, and refusing this row would break the documented replay.
    const stub = session({
      filePath: '',
      _remote: undefined,
      mirrorSyncedAt: Date.parse('2026-09-12T17:00:00.000Z'),
      mirrorSource: 'yosemite-s0',
      machine: 'zion',
    });
    const target = await resolveSessionRecovery(stub, healthy);
    expect(target.mode).toBe('continue');
  });

  it('refuses a path-less row that carries no mirror provenance, even on the fallback shape', async () => {
    // Same machine rewrite, no mirror fields → a live-registry phantom, not a
    // mirror stub. This is the pair that proves mirrorSyncedAt is doing the work.
    await expect(resolveSessionRecovery(
      session({ filePath: '', mirrorSyncedAt: undefined, machine: 'zion' }),
      healthy,
    )).rejects.toThrowError(SessionRecoveryError);
  });

  it('leaves a real on-disk transcript on the ordinary path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-recovery-present-'));
    const filePath = path.join(root, 'transcript.jsonl');
    fs.writeFileSync(filePath, '{}\n');
    const target = await resolveSessionRecovery(session({ filePath }), healthy);
    expect(target.mode).toBe('continue');
    expect(target.version).toBe('2.1.200');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
