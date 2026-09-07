import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  LEGACY_PASSPHRASE_ENV,
  SYNC_PASSPHRASE_ENV,
  missingSyncPassphraseMessage,
  resetSyncPassphraseWarnings,
  resolveSyncPassphraseFromEnv,
  warnEnvPassphraseReadableOnce,
} from './sync-passphrase.js';

/** Capture stderr for the duration of `fn` — the warnings are the behavior under
 *  test, so they are observed, never stubbed away. */
function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as NodeJS.WriteStream).write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    (process.stderr as NodeJS.WriteStream).write = original;
  }
  return chunks.join('');
}

describe('sync passphrase resolution (RUSH-1968 — split from the file-store master key)', () => {
  const saved = {
    sync: process.env[SYNC_PASSPHRASE_ENV],
    legacy: process.env[LEGACY_PASSPHRASE_ENV],
  };

  beforeEach(() => {
    delete process.env[SYNC_PASSPHRASE_ENV];
    delete process.env[LEGACY_PASSPHRASE_ENV];
    resetSyncPassphraseWarnings();
  });

  afterEach(() => {
    if (saved.sync === undefined) delete process.env[SYNC_PASSPHRASE_ENV];
    else process.env[SYNC_PASSPHRASE_ENV] = saved.sync;
    if (saved.legacy === undefined) delete process.env[LEGACY_PASSPHRASE_ENV];
    else process.env[LEGACY_PASSPHRASE_ENV] = saved.legacy;
    resetSyncPassphraseWarnings();
  });

  it('neither set → no value, no source, and nothing printed', () => {
    const err = captureStderr(() => {
      expect(resolveSyncPassphraseFromEnv()).toEqual({ value: null, source: null });
    });
    expect(err).toBe('');
  });

  it('the current variable wins and warns nothing about deprecation', () => {
    process.env[SYNC_PASSPHRASE_ENV] = 'sync-secret';
    const err = captureStderr(() => {
      expect(resolveSyncPassphraseFromEnv()).toEqual({ value: 'sync-secret', source: 'sync-env' });
    });
    expect(err).toBe('');
  });

  it('the current variable beats the legacy one when BOTH are set', () => {
    // The migration case: a box that has set the new name while the old export
    // is still lying around must not silently keep using the master key.
    process.env[SYNC_PASSPHRASE_ENV] = 'sync-secret';
    process.env[LEGACY_PASSPHRASE_ENV] = 'file-store-master-key';
    const err = captureStderr(() => {
      expect(resolveSyncPassphraseFromEnv().value).toBe('sync-secret');
    });
    expect(err).toBe('');
  });

  it('falls back to the legacy variable so scripted CI keeps working', () => {
    process.env[LEGACY_PASSPHRASE_ENV] = 'file-store-master-key';
    let out = '';
    out = captureStderr(() => {
      expect(resolveSyncPassphraseFromEnv()).toEqual({
        value: 'file-store-master-key',
        source: 'legacy-env',
      });
    });
    expect(out).toContain(LEGACY_PASSPHRASE_ENV);
    expect(out).toContain('deprecated');
    expect(out).toContain(SYNC_PASSPHRASE_ENV);
  });

  it('the deprecation warning fires exactly ONCE per process, not per call', () => {
    // `push --all` resolves once per bundle; without the latch this floods stderr.
    process.env[LEGACY_PASSPHRASE_ENV] = 'file-store-master-key';
    const first = captureStderr(() => { resolveSyncPassphraseFromEnv(); });
    const second = captureStderr(() => { resolveSyncPassphraseFromEnv(); });
    const third = captureStderr(() => { resolveSyncPassphraseFromEnv(); });
    expect(first).toContain('deprecated');
    expect(second).toBe('');
    expect(third).toBe('');
  });

  it('the readability warning is separate and also fires once', () => {
    // A caller on the CURRENT variable still deserves the /proc readability
    // notice — it must not be swallowed by the deprecation latch.
    const first = captureStderr(() => { warnEnvPassphraseReadableOnce(); });
    const second = captureStderr(() => { warnEnvPassphraseReadableOnce(); });
    expect(first).toContain('readable by other');
    expect(second).toBe('');
  });

  it('the headless error names the CURRENT variable, not the master key', () => {
    // This message is what an operator follows when sync fails on a worker box.
    // Naming the master key here is what put it into ~/.zshenv on seven boxes.
    const msg = missingSyncPassphraseMessage();
    expect(msg).toContain(SYNC_PASSPHRASE_ENV);
    expect(msg).not.toContain(LEGACY_PASSPHRASE_ENV);
  });
});
