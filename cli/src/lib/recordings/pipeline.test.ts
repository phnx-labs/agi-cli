import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RecordingLedger } from './ledger.js';
import { buildArtifactsRecordingArgs, buildArtifactsRecordingEnv, RecordingPipeline } from './pipeline.js';
import type { RecordingCandidate, TranscodeJob } from './model.js';
import { runProcess } from './process.js';
import { RecordingDependencyError, transcodeRecording } from './transcode.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function fakeArtifacts(directory: string, shareResult: 'ok' | '401' | 'contract' = 'ok'): Promise<string> {
  const script = path.join(directory, 'artifacts.mjs');
  await fs.writeFile(script, `
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'whoami') {
  console.log(JSON.stringify({ signedIn: true, email: 'recorder@example.com' }));
} else if (args[0] === 'share' && ${JSON.stringify(shareResult)} === '401') {
  console.error('401 Unauthorized');
  process.exitCode = 1;
} else if (args[0] === 'share' && ${JSON.stringify(shareResult)} === 'contract') {
  console.error('bad --meta recorded-at=…: unsupported metadata contract');
  process.exitCode = 1;
} else if (args[0] === 'share') {
  console.log(JSON.stringify({ url: 'https://share.test/clip' }));
} else {
  process.exitCode = 2;
}
`);
  return script;
}

async function fakeFfmpeg(directory: string, runMs: number): Promise<string> {
  const script = path.join(directory, 'ffmpeg');
  await fs.writeFile(script, `#!${process.execPath}\nsetTimeout(() => {}, ${runMs});\n`, { mode: 0o755 });
  return script;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined, timeoutMs = 5_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function candidate(directory: string, file = 'CleanShot demo.mp4', mtimeMs = 100): RecordingCandidate {
  return {
    path: path.join(directory, file),
    stem: 'CleanShot demo',
    slug: 'cleanshot-demo',
    size: 100,
    mtimeMs,
    recordedAt: '2026-10-08T11:51:47.000Z',
    sessionId: 'session-123',
  };
}

describe('recording artifacts contract', () => {
  it('builds the organization-only publish with capture metadata and one session', () => {
    const candidate: RecordingCandidate = {
      path: '/recordings/source.mp4',
      stem: 'CleanShot 2026-10-08 at 4.51.47 AM',
      slug: 'cleanshot-2026-10-08-at-4-51-47-am',
      size: 100,
      mtimeMs: 200,
      recordedAt: '2026-10-08T11:51:47.000Z',
      sessionId: 'session-123',
    };
    expect(buildArtifactsRecordingArgs(candidate, '/tmp/transcoded.mp4')).toEqual([
      'share', '/tmp/transcoded.mp4',
      '--visibility', 'org',
      '--expire', 'never',
      '--slug', 'cleanshot-2026-10-08-at-4-51-47-am',
      '--meta', 'source=cleanshot',
      '--meta', 'recorded-at=2026-10-08T11:51:47.000Z',
      '--meta', 'stem=CleanShot 2026-10-08 at 4.51.47 AM',
      '--json',
    ]);
  });

  it('passes only the candidate session to artifacts provenance', () => {
    const item = candidate('/recordings');
    expect(buildArtifactsRecordingEnv(item, {
      KEEP_ME: 'yes',
      AGENTS_SESSION_ID: 'daemon-session',
      AGENT_SESSION_ID: 'legacy-daemon-session',
    })).toEqual({
      KEEP_ME: 'yes',
      AGENTS_SESSION_ID: 'session-123',
    });
  });

  it('clears inherited session provenance when the recording has no session', () => {
    const item = { ...candidate('/recordings'), sessionId: undefined };
    expect(buildArtifactsRecordingEnv(item, {
      KEEP_ME: 'yes',
      AGENTS_SESSION_ID: 'daemon-session',
      AGENT_SESSION_ID: 'legacy-daemon-session',
    })).toEqual({ KEEP_ME: 'yes' });
  });

  it('returns the durable URL when an explicit upload is already complete', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-pipeline-'));
    directories.push(directory);
    const ledger = new RecordingLedger(path.join(directory, 'ledger.json'));
    const item = candidate(directory);
    await ledger.queue(item);
    await ledger.update(item.stem, item.path, { status: 'uploaded', url: 'https://share.test/existing' });
    const pipeline = new RecordingPipeline({
      ledger,
      verifyIdentity: async () => { throw new Error('identity should not be called'); },
      transcode: async () => { throw new Error('transcode should not be called'); },
    });

    await expect(pipeline.upload(item)).resolves.toMatchObject({
      status: 'uploaded',
      url: 'https://share.test/existing',
    });
  });

  it('uploads only the explicitly requested file and leaves unrelated queued work for the daemon', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-pipeline-'));
    directories.push(directory);
    const ledger = new RecordingLedger(path.join(directory, 'ledger.json'));
    const item = candidate(directory);
    const other = { ...candidate(directory, 'other.mp4'), stem: 'other', slug: 'other' };
    await fs.writeFile(item.path, 'video');
    await ledger.queue(other);
    const pipeline = new RecordingPipeline({
      artifactsBin: await fakeArtifacts(directory),
      ledger,
      transcode: async (filePath) => ({ filePath, cleanup: async () => undefined }),
    });

    await expect(pipeline.upload(item)).resolves.toMatchObject({ path: item.path, status: 'uploaded' });

    expect(await ledger.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: item.path, status: 'uploaded' }),
      expect.objectContaining({ path: other.path, status: 'queued' }),
    ]));
  });

  it('keeps a 401 upload queued and raises one blocked attention through a real artifacts process', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-pipeline-'));
    directories.push(directory);
    const item = candidate(directory);
    await fs.writeFile(item.path, 'video');
    const attention: string[] = [];
    const ledger = new RecordingLedger(path.join(directory, 'ledger.json'));
    const pipeline = new RecordingPipeline({
      artifactsBin: await fakeArtifacts(directory, '401'),
      ledger,
      retryDelayMs: 60_000,
      dependencyRetryDelayMs: 60_000,
      raiseAttention: async (message) => { attention.push(message); },
      transcode: async (filePath) => ({ filePath, cleanup: async () => undefined }),
    });

    await pipeline.queue([item]);
    await expect(pipeline.drain()).rejects.toThrow(/authentication expired/i);

    expect(await ledger.list()).toEqual([
      expect.objectContaining({ path: item.path, status: 'queued', error: expect.stringMatching(/authentication expired/i) }),
    ]);
    expect(await ledger.pending()).toHaveLength(0);
    expect(attention).toHaveLength(1);
  });

  it('cancels a real in-flight transcode before replacing a re-export row', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-pipeline-'));
    directories.push(directory);
    const original = candidate(directory);
    const replacement = candidate(directory, 'CleanShot demo 2.mp4', 200);
    const ledger = new RecordingLedger(path.join(directory, 'ledger.json'));
    let started!: () => void;
    let aborted!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const didAbort = new Promise<void>((resolve) => { aborted = resolve; });
    const pipeline = new RecordingPipeline({
      artifactsBin: await fakeArtifacts(directory),
      ledger,
      transcode: async (_filePath, signal) => {
        started();
        try {
          await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { signal });
        } finally {
          if (signal?.aborted) aborted();
        }
        return { filePath: original.path, cleanup: async () => undefined };
      },
    });
    await pipeline.queue([original]);
    await pipeline.drain({ awaitUploads: false });
    await didStart;

    pipeline.observeLatest(replacement);
    await pipeline.queue([replacement]);
    await didAbort;

    expect(await ledger.list()).toEqual([
      expect.objectContaining({ path: replacement.path, stem: original.stem, status: 'queued' }),
    ]);
    await pipeline.stop();
  });

  it('raises blocked attention and backs off an incompatible artifacts metadata contract', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-pipeline-'));
    directories.push(directory);
    const item = candidate(directory);
    await fs.writeFile(item.path, 'video');
    const attention: string[] = [];
    const ledger = new RecordingLedger(path.join(directory, 'ledger.json'));
    const pipeline = new RecordingPipeline({
      artifactsBin: await fakeArtifacts(directory, 'contract'),
      ledger,
      dependencyRetryDelayMs: 60_000,
      raiseAttention: async (message) => { attention.push(message); },
      transcode: async (filePath) => ({ filePath, cleanup: async () => undefined }),
    });
    await pipeline.queue([item]);

    await expect(pipeline.drain()).rejects.toThrow(/cannot accept the recordings publish contract/i);

    expect(await ledger.list()).toEqual([
      expect.objectContaining({ path: item.path, status: 'failed', error: expect.stringMatching(/cannot accept/) }),
    ]);
    expect(await ledger.pending()).toHaveLength(0);
    expect(attention).toHaveLength(1);
  });

  it('raises blocked attention and backs off when ffmpeg disappears after watch was enabled', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-pipeline-'));
    directories.push(directory);
    const item = candidate(directory);
    const attention: string[] = [];
    const ledger = new RecordingLedger(path.join(directory, 'ledger.json'));
    const pipeline = new RecordingPipeline({
      ledger,
      retryDelayMs: 60_000,
      verifyIdentity: async () => ({ email: 'recorder@example.com' }),
      raiseAttention: async (message) => { attention.push(message); },
      transcode: async () => { throw new RecordingDependencyError('ffmpeg is required. Install ffmpeg.'); },
    });
    await pipeline.queue([item]);

    await expect(pipeline.drain()).rejects.toThrow(/ffmpeg is required/);

    expect(await ledger.list()).toEqual([
      expect.objectContaining({ path: item.path, status: 'failed', error: expect.stringMatching(/ffmpeg is required/) }),
    ]);
    expect(await ledger.pending()).toHaveLength(0);
    expect(attention).toEqual(['ffmpeg is required. Install ffmpeg.']);
  });

  it('records the running ffmpeg on the row while it transcodes and forgets it once the upload ends (PHNX-4225)', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-pipeline-'));
    directories.push(directory);
    const item = candidate(directory);
    await fs.writeFile(item.path, 'video');
    const ffmpeg = await fakeFfmpeg(directory, 400);
    const ledger = new RecordingLedger(path.join(directory, 'ledger.json'));
    const pipeline = new RecordingPipeline({
      artifactsBin: await fakeArtifacts(directory),
      ledger,
      transcode: async (source, signal, onStart) => {
        const result = await transcodeRecording(source, signal, { ffmpegBin: ffmpeg, onStart });
        await fs.writeFile(result.filePath, 'transcoded');
        return result;
      },
    });
    await pipeline.queue([item]);
    const uploads = pipeline.drain();

    const job = await waitFor(async () => (await ledger.list())[0].transcode);
    expect(isAlive(job.pid)).toBe(true);
    expect((await fs.stat(job.workDir)).isDirectory()).toBe(true);

    await expect(uploads).resolves.toEqual([expect.objectContaining({ status: 'uploaded' })]);
    expect((await ledger.list())[0].transcode).toBeUndefined();
    await expect(fs.stat(job.workDir)).rejects.toThrow();
  });

  it('a restarted daemon stops the transcode the previous daemon left running before requeueing it (PHNX-4225)', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-pipeline-'));
    directories.push(directory);
    const item = candidate(directory);
    const ffmpeg = await fakeFfmpeg(directory, 60_000);
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agents-recording-'));
    directories.push(workDir);
    const orphan = spawn(ffmpeg, ['-i', item.path, path.join(workDir, 'recording.mp4')], { detached: true, stdio: 'ignore' });
    orphan.unref();
    const orphanJob: TranscodeJob = { pid: orphan.pid!, workDir };
    const strangerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agents-recording-'));
    directories.push(strangerDir);
    const ledgerPath = path.join(directory, 'ledger.json');
    const previous = new RecordingLedger(ledgerPath);
    const other = { ...candidate(directory, 'other.mp4'), stem: 'other', slug: 'other' };
    await previous.queue(item);
    await previous.queue(other);
    await previous.update(item.stem, item.path, { status: 'transcoding', transcode: orphanJob });
    await previous.update(other.stem, other.path, { status: 'uploading', transcode: { pid: process.pid, workDir: strangerDir } });

    const restarted = new RecordingPipeline({ ledger: new RecordingLedger(ledgerPath) });
    await expect(restarted.recoverInterrupted()).resolves.toEqual({ reaped: 1 });

    await waitFor(() => (isAlive(orphanJob.pid) ? undefined : true));
    expect(isAlive(process.pid)).toBe(true);
    await expect(fs.stat(workDir)).rejects.toThrow();
    await expect(fs.stat(strangerDir)).rejects.toThrow();
    const rows = await restarted.ledger.list();
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: item.path, status: 'queued' }),
      expect.objectContaining({ path: other.path, status: 'queued' }),
    ]));
    expect(rows.every((row) => row.transcode === undefined)).toBe(true);
  });

  it('starts one recording at a time and the next only after the first finishes (PHNX-4225)', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-pipeline-'));
    directories.push(directory);
    const first = candidate(directory);
    const second = { ...candidate(directory, 'other.mp4'), stem: 'other', slug: 'other' };
    await fs.writeFile(first.path, 'video');
    await fs.writeFile(second.path, 'video');
    const started: string[] = [];
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { finishFirst = resolve; });
    const ledger = new RecordingLedger(path.join(directory, 'ledger.json'));
    const pipeline = new RecordingPipeline({
      artifactsBin: await fakeArtifacts(directory),
      ledger,
      transcode: async (filePath) => {
        started.push(filePath);
        if (filePath === first.path) await firstGate;
        return { filePath, cleanup: async () => undefined };
      },
    });
    await pipeline.queue([first, second]);

    await pipeline.drain({ awaitUploads: false });
    await waitFor(() => (started.length > 0 ? true : undefined));
    await pipeline.drain({ awaitUploads: false });
    expect(started).toHaveLength(1);

    finishFirst();
    await waitFor(async () => ((await ledger.list()).some((row) => row.status === 'uploaded') ? true : undefined));
    await waitFor(async () => { await pipeline.drain({ awaitUploads: false }); return started.length === 2 ? true : undefined; });
    expect(new Set(started)).toEqual(new Set([first.path, second.path]));
    await pipeline.stop();
  });
});
