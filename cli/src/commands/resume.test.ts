import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../lib/session/types.js';
import { sessionRecoveryPeer } from '../lib/session/recovery.js';
import {
  buildResumeRunArgs,
  buildResumeRemoteArgs,
  resumeLocalFallbackSource,
} from './resume.js';
import { consumeResumePinned, RESUME_PINNED_ENV } from '../lib/session/resume-owner.js';

function session(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: '01a0555d-0675-78c1-9758-8214d1afdca2',
    shortId: '01a0555d',
    agent: 'codex',
    version: '0.146.0',
    machine: 'yosemite-m3',
    timestamp: '2026-08-30T10:00:00.000Z',
    filePath: '/mirror/rollout.jsonl',
    ...over,
  };
}

describe('buildResumeRunArgs', () => {
  it('uses the current harness binary and resumes the same id', () => {
    expect(buildResumeRunArgs(session(), undefined, { interactive: true })).toEqual([
      'run', 'codex', '--resume', '01a0555d-0675-78c1-9758-8214d1afdca2', '--interactive',
    ]);
  });

  it('falls back to the bare agent when no version was recorded', () => {
    expect(buildResumeRunArgs(session({ version: undefined }), undefined, {})).toEqual([
      'run', 'codex', '--resume', '01a0555d-0675-78c1-9758-8214d1afdca2',
    ]);
  });
});

it('carries explicit account, model and permission choices through the owner hop', () => {
  const options = { account: 'work', model: 'model-a', mode: 'plan', interactive: true, cwd: '/workspace' };
  const flags = ['--account', 'work', '--model', 'model-a', '--mode', 'plan', '--interactive', '--cwd', '/workspace'];
  expect(buildResumeRemoteArgs(session().id, 'continue', options)).toEqual(['sessions', 'resume', session().id, 'continue', ...flags]);
  expect(buildResumeRunArgs(session(), 'continue', options)).toEqual(['run', 'codex', 'continue', '--resume', session().id, ...flags]);
});

describe('consumeResumePinned', () => {
  it('reads and CLEARS the routing pin so it never reaches the agent child', () => {
    const prior = process.env[RESUME_PINNED_ENV];
    try {
      process.env[RESUME_PINNED_ENV] = '1';
      expect(consumeResumePinned()).toBe(true);
      expect(process.env[RESUME_PINNED_ENV]).toBeUndefined();
      // A second read is false — the pin is one-shot.
      expect(consumeResumePinned()).toBe(false);
    } finally {
      if (prior === undefined) delete process.env[RESUME_PINNED_ENV];
      else process.env[RESUME_PINNED_ENV] = prior;
    }
  });
});

describe('resumeLocalFallbackSource (prefer-device, fall back to local — PHNX-3626)', () => {
  it('rewrites the origin device to this box so recovery resolves locally', () => {
    const peerOwned = session({ machine: 'yosemite-m3' });
    // Before: the session names a peer, so recovery would hop there.
    expect(sessionRecoveryPeer(peerOwned, (h) => h === 'zion')).toBe('yosemite-m3');
    // After: the fallback source names THIS box, so `sessionRecoveryPeer` returns
    // undefined and the delegated `agents run --resume` resolves recovery locally
    // (→ a labelled /continue replay from the synced mirror) instead of bouncing
    // back to the unreachable owner.
    const local = resumeLocalFallbackSource(peerOwned, 'zion');
    expect(local.machine).toBe('zion');
    expect(sessionRecoveryPeer(local, (h) => h === 'zion')).toBeUndefined();
    // Identity/version are preserved so the same session continues.
    expect(local.id).toBe(peerOwned.id);
    expect(local.version).toBe('0.146.0');
  });

  it('leaves the remote hop args unchanged (device is still preferred first)', () => {
    // The prefer-device path is untouched: resume still tries the recorded device
    // via the canonical remote args before any local fallback.
    expect(buildResumeRemoteArgs(session().id, undefined, { interactive: true })).toEqual([
      'sessions', 'resume', '01a0555d-0675-78c1-9758-8214d1afdca2', '--interactive',
    ]);
  });
});

it('preserves the harness constraint on the owner hop without adding a run flag', () => {
  expect(buildResumeRemoteArgs(session().id, undefined, { agent: 'codex', local: true })).toEqual([
    'sessions', 'resume', session().id, '--agent', 'codex',
  ]);
  expect(buildResumeRunArgs(session(), undefined, { agent: 'codex' })).toEqual(['run', 'codex', '--resume', session().id]);
});
