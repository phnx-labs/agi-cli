import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findInPath } from '../agent-spec/agents.js';
import { RecordingLedger } from './ledger.js';
import { RecordingPipeline } from './pipeline.js';
import { candidateForFile } from './settle.js';
import { runProcess } from './process.js';
import { transcodeRecording } from './transcode.js';

const artifactsBin = process.env.RECORDINGS_ARTIFACTS_BIN;
const ffmpegBin = process.env.FFMPEG_BIN || findInPath('ffmpeg');
const runIntegration = Boolean(artifactsBin && ffmpegBin);

describe.runIf(runIntegration)('recordings pipeline (real ffmpeg + artifacts CLI + local Worker)', () => {
  let root = '';
  let worker: Miniflare;
  let identity: Server;
  let baseUrl = '';
  let identityUrl = '';

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-integration-'));
    identity = createServer((request, response) => {
      if (request.url !== '/api/v1/auth/me' || request.headers.authorization !== 'Bearer recording-test-token') {
        response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ userId: 'recording-user', email: 'recorder@example.com' }));
    });
    await new Promise<void>((resolve, reject) => {
      identity.once('error', reject);
      identity.listen(0, '127.0.0.1', resolve);
    });
    identityUrl = `http://127.0.0.1:${(identity.address() as AddressInfo).port}`;
    worker = new Miniflare({
      modules: [{
        type: 'ESModule',
        path: 'worker.js',
        contents: `export default { async fetch(request, env) {
          const url = new URL(request.url);
          if (request.method !== 'PUT') return new Response('not found', { status: 404 });
          if (request.headers.get('authorization') !== 'Bearer local-write-token') {
            return Response.json({ error: 'unauthorized' }, { status: 401 });
          }
          const body = await request.arrayBuffer();
          const headers = Object.fromEntries(request.headers);
          await env.BUCKET.put(url.pathname.slice(1), body, { customMetadata: { headers: JSON.stringify(headers) } });
          return new Response(null, { status: 200 });
        } };`,
      }],
      r2Buckets: ['BUCKET'],
    });
    baseUrl = (await worker.ready).toString().replace(/\/+$/, '');
    expect(baseUrl).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):/);

    const artifactsDir = path.join(root, '.artifacts');
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.writeFile(path.join(artifactsDir, 'config.json'), JSON.stringify({
      share: { baseUrl, writeToken: 'local-write-token' },
    }));
    await fs.writeFile(path.join(artifactsDir, 'phoenix-session.json'), JSON.stringify({
      access_token: 'recording-test-token', email: 'recorder@example.com', userId: 'recording-user',
    }));
  });

  afterAll(async () => {
    await worker?.dispose();
    await new Promise<void>((resolve) => identity?.close(() => resolve()) ?? resolve());
    await fs.rm(root, { recursive: true, force: true });
  });

  it('transcodes and publishes a real five-second clip without reaching the production endpoint', async () => {
    const source = path.join(root, 'CleanShot 2026-10-08 at 4.51.47 AM.mp4');
    const generated = await runProcess(ffmpegBin!, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100',
      '-t', '5', '-c:v', 'mpeg4', '-c:a', 'aac', source,
    ]);
    expect(generated.exitCode, generated.stderr).toBe(0);

    const configPath = path.join(root, '.artifacts', 'config.json');
    const env = {
      ...process.env,
      ARTIFACTS_CONFIG: configPath,
      ARTIFACTS_SHARE_BACKEND: 'byo',
      ARTIFACTS_GITHUB_USER: 'recordings-test',
      ARTIFACTS_SHARE_TOKEN: 'local-write-token',
      PHOENIX_ID_BASE: identityUrl,
      FFMPEG_BIN: ffmpegBin!,
    };
    const ledger = new RecordingLedger(path.join(root, 'ledger.json'));
    const pipeline = new RecordingPipeline({
      artifactsBin: artifactsBin!,
      env,
      ledger,
      host: 'test-device',
      transcode: (file, signal) => transcodeRecording(file, signal, { ffmpegBin: ffmpegBin!, platform: 'linux' }),
    });
    const candidate = await candidateForFile(source);
    candidate.recordedAt = '2026-10-08T11:51:47.000Z';
    candidate.sessionId = 'session-123';
    const row = await pipeline.upload(candidate);

    expect(row).toMatchObject({ status: 'uploaded', slug: 'cleanshot-2026-10-08-at-4-51-47-am' });
    expect(row.url).toBe(`${baseUrl}/recordings-test/${candidate.slug}`);
    const bucket = await worker.getR2Bucket('BUCKET');
    const object = await bucket.get(`recordings-test/${candidate.slug}`);
    expect(object).not.toBeNull();
    expect(object!.size).toBeGreaterThan(1_000);
    const headers = JSON.parse(object!.customMetadata!.headers) as Record<string, string>;
    expect(headers['x-share-visibility']).toBe('org');
    expect(JSON.parse(headers['x-share-meta'])).toEqual({
      source: 'cleanshot',
      host: 'test-device',
      recorded_at: candidate.recordedAt,
      stem: candidate.stem,
      session: 'session-123',
    });
  }, 120_000);
});
