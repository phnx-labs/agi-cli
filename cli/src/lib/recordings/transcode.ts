import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { findInPath } from '../agent-spec/agents.js';
import { processFailure, runProcess } from './process.js';

export const FFMPEG_INSTALL_HINT = process.platform === 'darwin'
  ? 'Install it with `brew install ffmpeg`.'
  : 'Install it with your system package manager (for example `apt install ffmpeg`).';

export function resolveFfmpegBin(): string {
  const explicit = process.env.FFMPEG_BIN?.trim();
  const resolved = explicit || findInPath('ffmpeg');
  if (!resolved) throw new Error(`ffmpeg is required to publish recordings. ${FFMPEG_INSTALL_HINT}`);
  return resolved;
}

export interface TranscodedRecording {
  filePath: string;
  cleanup: () => Promise<void>;
}

export async function transcodeRecording(
  sourcePath: string,
  signal?: AbortSignal,
  options: { ffmpegBin?: string; platform?: NodeJS.Platform } = {},
): Promise<TranscodedRecording> {
  const ffmpeg = options.ffmpegBin ?? resolveFfmpegBin();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agents-recording-'));
  const output = path.join(directory, 'recording.mp4');
  const codec = (options.platform ?? process.platform) === 'darwin' ? 'h264_videotoolbox' : 'libx264';
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath,
    '-map', '0:v:0', '-map', '0:a?',
    '-vf', "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30",
    '-c:v', codec, '-b:v', '3M', '-maxrate', '3M', '-bufsize', '6M', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', output,
  ];
  try {
    const result = await runProcess(ffmpeg, args, { signal });
    if (result.exitCode !== 0) throw processFailure('ffmpeg', args, result);
    return { filePath: output, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
