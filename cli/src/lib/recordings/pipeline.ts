import { getCliLaunch } from '../cli-entry.js';
import { invocation, resolveArtifactsBin } from '../artifacts-client.js';
import { machineId } from '../machine-id.js';
import { RecordingIdentityError, verifyOrganizationIdentity } from './identity.js';
import { RecordingLedger } from './ledger.js';
import { isNewerRecording, type RecordingCandidate, type RecordingLedgerRow } from './model.js';
import { processFailure, runProcess } from './process.js';
import { transcodeRecording, type TranscodedRecording } from './transcode.js';

interface ActiveUpload {
  candidate: RecordingCandidate;
  controller: AbortController;
  promise: Promise<RecordingLedgerRow | null>;
  superseded: boolean;
}

export interface RecordingPipelineOptions {
  ledger?: RecordingLedger;
  artifactsBin?: string;
  env?: NodeJS.ProcessEnv;
  host?: string;
  transcode?: (sourcePath: string, signal?: AbortSignal) => Promise<TranscodedRecording>;
  verifyIdentity?: (signal?: AbortSignal) => Promise<{ email: string }>;
  raiseAttention?: (message: string) => Promise<void>;
  reportError?: (message: string) => void;
  retryDelayMs?: number;
}

function rowCandidate(row: RecordingLedgerRow): RecordingCandidate {
  return {
    path: row.path,
    stem: row.stem,
    slug: row.slug,
    size: row.size,
    mtimeMs: row.mtimeMs,
    recordedAt: row.recordedAt,
    sessionId: row.sessionId,
  };
}

function resultUrl(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as { url?: unknown };
    if (typeof parsed.url === 'string' && parsed.url.length > 0) return parsed.url;
  } catch {
    const line = stdout.trim().split(/\r?\n/).find((value) => /^https?:\/\//.test(value));
    if (line) return line;
  }
  throw new Error('artifacts share completed without returning a URL.');
}

function isUnauthorizedOutput(exitCode: number, output: string): boolean {
  return exitCode === 401 || /\b401\b|unauthori[sz]ed|authentication expired|not signed in/i.test(output);
}

async function defaultAttention(message: string): Promise<void> {
  const session = `recordings-${machineId()}`;
  const launch = getCliLaunch([
    'feed', 'post', '--title', 'Recordings need attention', message, '--blocked', '--session', session,
  ]);
  const result = await runProcess(launch.command, launch.args, { timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw processFailure(launch.command, launch.args, result);
}

export function buildArtifactsRecordingArgs(candidate: RecordingCandidate, transcodedPath: string, host: string): string[] {
  const args = [
    'share', transcodedPath,
    '--visibility', 'org',
    '--expire', 'never',
    '--slug', candidate.slug,
    '--meta', 'source=cleanshot',
    '--meta', `host=${host}`,
    '--meta', `recorded_at=${candidate.recordedAt}`,
    '--meta', `stem=${candidate.stem}`,
  ];
  if (candidate.sessionId) args.push('--meta', `session=${candidate.sessionId}`);
  args.push('--json');
  return args;
}

export class RecordingPipeline {
  readonly ledger: RecordingLedger;
  private readonly active = new Map<string, ActiveUpload>();
  private readonly configuredArtifactsBin?: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly host: string;
  private readonly transcode: (sourcePath: string, signal?: AbortSignal) => Promise<TranscodedRecording>;
  private readonly verifyIdentity: (signal?: AbortSignal) => Promise<{ email: string }>;
  private readonly raiseAttention: (message: string) => Promise<void>;
  private readonly reportError: (message: string) => void;
  private readonly retryDelayMs: number;

  constructor(options: RecordingPipelineOptions = {}) {
    this.ledger = options.ledger ?? new RecordingLedger();
    this.configuredArtifactsBin = options.artifactsBin;
    this.env = options.env ?? process.env;
    this.host = options.host ?? machineId();
    this.transcode = options.transcode ?? ((source, signal) => transcodeRecording(source, signal));
    this.verifyIdentity = options.verifyIdentity
      ?? ((signal) => verifyOrganizationIdentity(signal, { artifactsBin: this.artifactsBin(), env: this.env }));
    this.raiseAttention = options.raiseAttention ?? defaultAttention;
    this.reportError = options.reportError ?? (() => undefined);
    this.retryDelayMs = options.retryDelayMs ?? 60_000;
  }

  private artifactsBin(): string {
    return this.configuredArtifactsBin ?? resolveArtifactsBin();
  }

  observeLatest(candidate: RecordingCandidate): void {
    const active = this.active.get(candidate.stem);
    if (!active || active.candidate.path === candidate.path) return;
    if (!isNewerRecording(candidate, active.candidate)) return;
    active.superseded = true;
    active.controller.abort();
    void this.ledger.update(active.candidate.stem, active.candidate.path, {
      status: 'failed',
      error: `Superseded by ${candidate.path}`,
      retryAt: '9999-12-31T23:59:59.999Z',
    }).catch((error) => {
      this.reportError(error instanceof Error ? error.message : String(error));
    });
  }

  async queue(candidates: RecordingCandidate[]): Promise<void> {
    for (const candidate of candidates) await this.ledger.queue(candidate);
  }

  async recoverInterrupted(): Promise<void> {
    await this.ledger.recoverInterrupted();
  }

  private async attention(message: string): Promise<void> {
    if (!await this.ledger.shouldPostAttention(message)) return;
    try {
      await this.raiseAttention(message);
    } catch (error) {
      await this.ledger.clearAttention();
      throw error;
    }
  }

  private async share(candidate: RecordingCandidate, filePath: string, signal: AbortSignal): Promise<string> {
    const launch = invocation(this.artifactsBin());
    const args = [...launch.prefix, ...buildArtifactsRecordingArgs(candidate, filePath, this.host)];
    const result = await runProcess(launch.command, args, { signal, env: this.env });
    if (result.exitCode !== 0) {
      const output = `${result.stderr}\n${result.stdout}`;
      if (isUnauthorizedOutput(result.exitCode, output)) {
        throw new RecordingIdentityError(
          'AUTH_REQUIRED',
          'Artifacts authentication expired during upload. Run `artifacts auth login`; recordings remain queued.',
        );
      }
      throw processFailure('artifacts', args, result);
    }
    return resultUrl(result.stdout);
  }

  private start(candidate: RecordingCandidate): Promise<RecordingLedgerRow | null> {
    const controller = new AbortController();
    const active: ActiveUpload = {
      candidate,
      controller,
      superseded: false,
      promise: Promise.resolve(null),
    };
    const promise = (async (): Promise<RecordingLedgerRow | null> => {
      let transcoded: TranscodedRecording | undefined;
      try {
        await this.ledger.update(candidate.stem, candidate.path, { status: 'transcoding', error: null, retryAt: undefined });
        transcoded = await this.transcode(candidate.path, controller.signal);
        await this.ledger.update(candidate.stem, candidate.path, { status: 'uploading' });
        const url = await this.share(candidate, transcoded.filePath, controller.signal);
        return await this.ledger.update(candidate.stem, candidate.path, {
          status: 'uploaded',
          url,
          error: null,
          retryAt: undefined,
        });
      } catch (error) {
        if (active.superseded) return null;
        if (error instanceof RecordingIdentityError && error.code === 'AUTH_REQUIRED') {
          await this.ledger.update(candidate.stem, candidate.path, {
            status: 'queued',
            error: error.message,
            retryAt: undefined,
          });
          await this.attention(error.message);
          return null;
        }
        const message = error instanceof Error ? error.message : String(error);
        await this.ledger.update(candidate.stem, candidate.path, {
          status: 'failed',
          error: message,
          retryAt: new Date(Date.now() + this.retryDelayMs).toISOString(),
        });
        throw error;
      } finally {
        await transcoded?.cleanup();
      }
    })();
    active.promise = promise;
    this.active.set(candidate.stem, active);
    void promise.finally(() => {
      if (this.active.get(candidate.stem) === active) this.active.delete(candidate.stem);
    }).catch((error) => {
      if (!active.superseded) this.reportError(error instanceof Error ? error.message : String(error));
    });
    return promise;
  }

  async drain(options: { awaitUploads?: boolean; signal?: AbortSignal } = {}): Promise<RecordingLedgerRow[]> {
    const pending = await this.ledger.pending();
    const candidates = pending.map(rowCandidate).filter((candidate) => !this.active.has(candidate.stem));
    if (candidates.length === 0) return [];
    try {
      await this.verifyIdentity(options.signal);
      await this.ledger.clearAttention();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const candidate of candidates) {
        await this.ledger.update(candidate.stem, candidate.path, { status: 'queued', error: message });
      }
      await this.attention(message);
      throw error;
    }
    const uploads = candidates.map((candidate) => this.start(candidate));
    if (options.awaitUploads === false) return [];
    const rows = await Promise.all(uploads);
    return rows.filter((row): row is RecordingLedgerRow => row !== null);
  }

  async upload(candidate: RecordingCandidate, signal?: AbortSignal): Promise<RecordingLedgerRow> {
    this.observeLatest(candidate);
    await this.queue([candidate]);
    const rows = await this.drain({ signal });
    const row = rows.find((entry) => entry.stem === candidate.stem && entry.path === candidate.path);
    if (!row || row.status !== 'uploaded') throw new Error(`Recording did not upload: ${candidate.path}`);
    return row;
  }

  async stop(): Promise<void> {
    const active = [...this.active.values()];
    for (const upload of active) upload.controller.abort();
    await Promise.allSettled(active.map((upload) => upload.promise));
  }
}
