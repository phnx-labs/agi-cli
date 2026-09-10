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
  it('selects the second same-binary account and checks its real transcript slot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-recovery-'));
    try {
      const slotDir = path.join(root, 'second');
      const filePath = path.join(slotDir, '.claude', 'projects', 'project', 'session.jsonl');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ type: 'user', cwd: root }) + '\n');
      const first = candidate('2.1.187', { accountKey: 'first', nativeAccount: 'first', slotDir: path.join(root, 'first') });
      const second = candidate('2.1.187', { accountKey: 'second', nativeAccount: 'second', slotDir });
      expect(resolveSessionRecoveryFromCandidates(session({ filePath, accountKey: 'second' }), [first, second], () => true)).toMatchObject({ mode: 'native', cwd: root, account: { selector: 'second', nativeAccount: 'second' } });
      expect(resolveSessionRecoveryFromCandidates(session({ filePath, accountKey: 'second', version: 'old' }), [first, second], () => true)).toMatchObject({ mode: 'native', version: '2.1.187' });
      expect(resolveSessionRecoveryFromCandidates(session({ filePath }), [first, second], () => true)).toMatchObject({ mode: 'native', account: { selector: 'second' } });
      fs.renameSync(slotDir, path.join(root, 'retained'));
      expect(resolveSessionRecoveryFromCandidates(session({ filePath: filePath.replace(slotDir, path.join(root, 'retained')), accountKey: 'second' }), [first, second], () => true)).toMatchObject({ mode: 'continue', account: { selector: 'second' } });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it.each(['rate_limited', 'signed_out', 'revoked'])('continues in another account when origin is %s', (reason) => {
    const origin = candidate('2.1.187', { accountKey: 'origin', nativeAccount: 'origin', signedIn: reason !== 'signed_out', authVerdict: reason === 'revoked' ? 'revoked' : null, usageStatus: reason === 'rate_limited' ? 'rate_limited' : null });
    const target = candidate('2.1.187', { accountKey: 'provider:second', providerAccount: 'second', accountLabel: 'second' });
    expect(resolveSessionRecoveryFromCandidates(session({ accountKey: 'origin' }), [origin, target], () => true, { available: true })).toMatchObject({ mode: 'continue', account: { selector: 'second', providerAccount: 'second' } });
  });
  it('never claims native ownership from a binary label alone', () => {
    expect(resolveSessionRecoveryFromCandidates(session(), [candidate('2.1.187', { nativeAccount: 'new' })], () => true, { available: true })).toMatchObject({ mode: 'continue' });
  });
  it('fails if the owning device has no healthy account', () => {
    expect(() => resolveSessionRecoveryFromCandidates(session(), [candidate('2.1.187', { signedIn: false })])).toThrow(SessionRecoveryError);
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
