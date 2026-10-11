import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { findInPath } from '../agent-spec/agents.js';
import { execFileBounded } from '../exec-bounded.js';
import type { TranscodeJob } from './model.js';
import { processFailure, runProcess } from './process.js';

const WORK_DIR_PREFIX = 'agents-recording-';
const OUTPUT_NAME = 'recording.mp4';

export const FFMPEG_INSTALL_HINT = process.platform === 'darwin'
  ? 'Install it with `brew install ffmpeg`.'
  : 'Install it with your system package manager (for example `apt install ffmpeg`).';

export class RecordingDependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordingDependencyError';
  }
}

export function resolveFfmpegBin(): string {
  const explicit = process.env.FFMPEG_BIN?.trim();
  const resolved = explicit || findInPath('ffmpeg');
  if (!resolved) throw new RecordingDependencyError(`ffmpeg is required to publish recordings. ${FFMPEG_INSTALL_HINT}`);
  return resolved;
}

export interface TranscodedRecording {
  filePath: string;
  cleanup: () => Promise<void>;
}

export async function transcodeRecording(
  sourcePath: string,
  signal?: AbortSignal,
  options: { ffmpegBin?: string; platform?: NodeJS.Platform; onStart?: (job: TranscodeJob) => void } = {},
): Promise<TranscodedRecording> {
  const ffmpeg = options.ffmpegBin ?? resolveFfmpegBin();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), WORK_DIR_PREFIX));
  const output = path.join(directory, OUTPUT_NAME);
  const codec = (options.platform ?? process.platform) === 'darwin' ? 'h264_videotoolbox' : 'libx264';
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath,
    '-map', '0:v:0', '-map', '0:a?',
    '-vf', "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30",
    '-c:v', codec, '-b:v', '3M', '-maxrate', '3M', '-bufsize', '6M', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', output,
  ];
  try {
    const result = await runProcess(ffmpeg, args, {
      signal,
      onSpawn: (pid) => options.onStart?.({ pid, workDir: directory, ownerPid: process.pid }),
    });
    if (result.exitCode !== 0) throw processFailure('ffmpeg', args, result);
    return { filePath: output, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function reapTranscode(job: TranscodeJob): Promise<{ killed: boolean }> {
  if (!path.basename(job.workDir).startsWith(WORK_DIR_PREFIX)) {
    throw new Error(`Refusing to reap a transcode outside an ${WORK_DIR_PREFIX}* work dir: ${job.workDir}`);
  }
  let killed = false;
  if (process.platform !== 'win32') {
    const ps = await execFileBounded('ps', ['-ww', '-o', 'args=', '-p', String(job.pid)], { timeoutMs: 5_000 });
    if (ps.timedOut) throw new Error(`ps timed out checking transcode pid ${job.pid}`);
    if (ps.code === 0 && ps.stdout.includes(path.join(job.workDir, OUTPUT_NAME))) {
      try {
        process.kill(-job.pid, 'SIGKILL');
        killed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }
  await fs.rm(job.workDir, { recursive: true, force: true });
  return { killed };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
