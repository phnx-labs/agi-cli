import * as path from 'node:path';

export type RecordingStatus = 'queued' | 'transcoding' | 'uploading' | 'uploaded' | 'failed';

export interface RecordingCandidate {
  path: string;
  stem: string;
  slug: string;
  size: number;
  mtimeMs: number;
  recordedAt: string;
  sessionId?: string;
}

export interface RecordingLedgerRow {
  path: string;
  stem: string;
  slug: string;
  url: string | null;
  status: RecordingStatus;
  error: string | null;
  size: number;
  mtimeMs: number;
  recordedAt: string;
  sessionId?: string;
  updatedAt: string;
  retryAt?: string;
}

export function isRecordingFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.mp4' || ext === '.mov';
}

export function cleanShotStem(filePath: string): string {
  const raw = path.basename(filePath, path.extname(filePath));
  const reexport = /^(CleanShot .+?) ([1-9]\d*)$/.exec(raw);
  return reexport?.[1] ?? raw;
}

export function slugifyRecordingStem(stem: string): string {
  const slug = stem
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
    .replace(/-+$/g, '');
  return slug || 'recording';
}

export function candidateVersion(candidate: Pick<RecordingCandidate, 'mtimeMs' | 'path'>): string {
  return `${candidate.mtimeMs}:${candidate.path}`;
}

export function isNewerRecording(
  candidate: Pick<RecordingCandidate, 'mtimeMs' | 'path'>,
  current: Pick<RecordingCandidate, 'mtimeMs' | 'path'>,
): boolean {
  return candidate.mtimeMs > current.mtimeMs
    || (candidate.mtimeMs === current.mtimeMs && candidate.path.localeCompare(current.path) > 0);
}
