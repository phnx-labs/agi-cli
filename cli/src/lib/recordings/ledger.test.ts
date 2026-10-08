import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RecordingLedger } from './ledger.js';
import type { RecordingCandidate } from './model.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('RecordingLedger', () => {
  it('recovers a zero-byte initialization left by an interrupted first writer', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-ledger-'));
    directories.push(directory);
    const ledgerPath = path.join(directory, 'ledger.json');
    await fs.writeFile(ledgerPath, '');
    const ledger = new RecordingLedger(ledgerPath);
    const candidate: RecordingCandidate = {
      path: path.join(directory, 'clip.mp4'), stem: 'clip', slug: 'clip', size: 42, mtimeMs: 100,
      recordedAt: '2026-10-08T12:00:00.000Z',
    };

    await ledger.queue(candidate);

    expect(await ledger.list()).toEqual([expect.objectContaining({ path: candidate.path, status: 'queued' })]);
  });

  it('resumes an interrupted upload after a fresh ledger instance starts', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-ledger-'));
    directories.push(directory);
    const ledgerPath = path.join(directory, 'ledger.json');
    const candidate: RecordingCandidate = {
      path: path.join(directory, 'clip.mp4'),
      stem: 'clip',
      slug: 'clip',
      size: 42,
      mtimeMs: 100,
      recordedAt: '2026-10-08T12:00:00.000Z',
    };
    const firstProcess = new RecordingLedger(ledgerPath);
    await firstProcess.queue(candidate);
    await firstProcess.update(candidate.stem, candidate.path, { status: 'uploading' });

    const restarted = new RecordingLedger(ledgerPath);
    await restarted.recoverInterrupted(200);
    const pending = await restarted.pending(200);

    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ path: candidate.path, status: 'queued' });
    expect(pending[0].error).toMatch(/Interrupted/);
  });

  it('does not queue an already uploaded source fingerprint again', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-ledger-'));
    directories.push(directory);
    const ledger = new RecordingLedger(path.join(directory, 'ledger.json'));
    const candidate: RecordingCandidate = {
      path: path.join(directory, 'clip.mp4'), stem: 'clip', slug: 'clip', size: 42, mtimeMs: 100,
      recordedAt: '2026-10-08T12:00:00.000Z',
    };
    await ledger.queue(candidate);
    await ledger.update('clip', candidate.path, { status: 'uploaded', url: 'https://share.test/clip' });
    await ledger.queue(candidate);
    expect(await ledger.pending()).toHaveLength(0);
  });

  it('replaces an earlier re-export row with the newer source at the same stem and slug', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-ledger-'));
    directories.push(directory);
    const ledger = new RecordingLedger(path.join(directory, 'ledger.json'));
    const original: RecordingCandidate = {
      path: path.join(directory, 'CleanShot demo.mp4'), stem: 'CleanShot demo', slug: 'cleanshot-demo',
      size: 42, mtimeMs: 100, recordedAt: '2026-10-08T12:00:00.000Z',
    };
    await ledger.queue(original);
    await ledger.update(original.stem, original.path, { status: 'uploaded', url: 'https://share.test/old' });

    const replacement = { ...original, path: path.join(directory, 'CleanShot demo 2.mp4'), size: 84, mtimeMs: 200 };
    await ledger.queue(replacement);

    expect(await ledger.list()).toEqual([
      expect.objectContaining({
        path: replacement.path,
        stem: original.stem,
        slug: original.slug,
        status: 'queued',
        url: null,
        error: null,
      }),
    ]);
  });

  it('reads pending work without rewriting the ledger', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-ledger-'));
    directories.push(directory);
    const ledgerPath = path.join(directory, 'ledger.json');
    const ledger = new RecordingLedger(ledgerPath);
    await ledger.queue({
      path: path.join(directory, 'clip.mp4'), stem: 'clip', slug: 'clip', size: 42, mtimeMs: 100,
      recordedAt: '2026-10-08T12:00:00.000Z',
    });
    const before = await fs.stat(ledgerPath);

    expect(await ledger.pending()).toHaveLength(1);

    const after = await fs.stat(ledgerPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('lets only one process claim a queued source fingerprint', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-ledger-'));
    directories.push(directory);
    const ledgerPath = path.join(directory, 'ledger.json');
    const candidate: RecordingCandidate = {
      path: path.join(directory, 'clip.mp4'), stem: 'clip', slug: 'clip', size: 42, mtimeMs: 100,
      recordedAt: '2026-10-08T12:00:00.000Z',
    };
    await new RecordingLedger(ledgerPath).queue(candidate);

    const claims = await Promise.all([
      new RecordingLedger(ledgerPath).claim(candidate.stem, candidate.path),
      new RecordingLedger(ledgerPath).claim(candidate.stem, candidate.path),
    ]);

    expect(claims.sort()).toEqual([false, true]);
  });
});
