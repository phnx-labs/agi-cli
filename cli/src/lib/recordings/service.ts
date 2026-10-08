import type { DaemonContext } from '../daemon/service.js';
import { BasePeriodicService } from '../daemon/service.js';
import { readRecordingsConfig, resolveRecordingDirectory } from './config.js';
import { RecordingPipeline } from './pipeline.js';
import { RecordingSettler } from './settle.js';

export class RecordingsService extends BasePeriodicService {
  readonly id = 'recordings' as const;
  readonly intervalMs = 2_000;
  readonly deadlineMs = 25_000;

  private directory = '';
  private watchedSinceMs = 0;
  private startedAtMs = 0;
  private pipeline: RecordingPipeline | null = null;
  private settler: RecordingSettler | null = null;

  protected async onStart(ctx: DaemonContext): Promise<void> {
    this.pipeline = new RecordingPipeline({
      reportError: (message) => ctx.log('ERROR', `recordings: ${message}`),
    });
    this.settler = new RecordingSettler();
    this.startedAtMs = Date.now();
    await this.pipeline.recoverInterrupted();
  }

  protected async onTick(ctx: DaemonContext, signal: AbortSignal): Promise<void> {
    if (!this.pipeline || !this.settler) return;
    const directory = await resolveRecordingDirectory();
    const configuredSince = Date.parse((await readRecordingsConfig()).watchedSince ?? '');
    const watchedSinceMs = Number.isFinite(configuredSince) ? configuredSince : this.startedAtMs;
    if (directory !== this.directory || watchedSinceMs !== this.watchedSinceMs) {
      this.directory = directory;
      this.watchedSinceMs = watchedSinceMs;
      this.settler = new RecordingSettler();
      ctx.log('INFO', `Recordings watching ${this.directory}`);
    }
    const scan = await this.settler.scan(this.directory, { notBeforeMs: this.watchedSinceMs });
    for (const candidate of scan.latest) this.pipeline.observeLatest(candidate);
    await this.pipeline.queue(scan.ready);
    await this.pipeline.drain({ awaitUploads: false, signal });
  }

  protected async onStop(): Promise<void> {
    await this.pipeline?.stop();
    this.pipeline = null;
    this.settler = null;
  }
}
