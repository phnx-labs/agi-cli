import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getActiveSessions } from '../session/active.js';
import {
  cleanShotStem,
  isNewerRecording,
  isRecordingFile,
  slugifyRecordingStem,
  type RecordingCandidate,
} from './model.js';

interface Observation {
  candidate: RecordingCandidate;
  unchangedSinceMs: number;
  readyEmitted: boolean;
}

export interface RecordingScan {
  latest: RecordingCandidate[];
  ready: RecordingCandidate[];
}

export interface RecordingSettlerOptions {
  settleMs?: number;
  now?: () => number;
  sessionsAt?: (recordedAtMs: number) => Promise<string | undefined>;
}

async function sessionAtRecordingTime(recordedAtMs: number): Promise<string | undefined> {
  const sessions = await getActiveSessions({ localOnly: true });
  const matching = sessions.filter((session) =>
    session.sessionId && (session.startedAtMs ?? Number.POSITIVE_INFINITY) <= recordedAtMs,
  );
  return matching.length === 1 ? matching[0].sessionId : undefined;
}

export class RecordingSettler {
  private readonly observations = new Map<string, Observation>();
  private readonly settleMs: number;
  private readonly now: () => number;
  private readonly sessionsAt: (recordedAtMs: number) => Promise<string | undefined>;

  constructor(options: RecordingSettlerOptions = {}) {
    this.settleMs = options.settleMs ?? 10_000;
    this.now = options.now ?? Date.now;
    this.sessionsAt = options.sessionsAt ?? sessionAtRecordingTime;
  }

  async scan(directory: string, options: { notBeforeMs?: number } = {}): Promise<RecordingScan> {
    const names = await fs.readdir(directory);
    const now = this.now();
    const seen = new Set<string>();
    const candidates: RecordingCandidate[] = [];

    await Promise.all(names.map(async (name) => {
      const filePath = path.join(directory, name);
      if (!isRecordingFile(filePath)) return;
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat?.isFile()) return;
      seen.add(filePath);
      const previous = this.observations.get(filePath);
      const recordedAtMs = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
      if (options.notBeforeMs !== undefined && recordedAtMs < options.notBeforeMs) return;
      const candidate: RecordingCandidate = {
        path: filePath,
        stem: cleanShotStem(filePath),
        slug: slugifyRecordingStem(cleanShotStem(filePath)),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        recordedAt: new Date(recordedAtMs).toISOString(),
        sessionId: previous?.candidate.sessionId ?? await this.sessionsAt(recordedAtMs),
      };
      const unchangedSinceMs = previous && previous.candidate.size === candidate.size
        ? previous.unchangedSinceMs
        : now;
      const readyEmitted = previous?.candidate.size === candidate.size && previous.readyEmitted;
      this.observations.set(filePath, { candidate, unchangedSinceMs, readyEmitted: readyEmitted === true });
      candidates.push(candidate);
    }));

    for (const filePath of this.observations.keys()) {
      if (!seen.has(filePath)) this.observations.delete(filePath);
    }

    const latestByStem = new Map<string, RecordingCandidate>();
    for (const candidate of candidates) {
      const current = latestByStem.get(candidate.stem);
      if (!current || isNewerRecording(candidate, current)) latestByStem.set(candidate.stem, candidate);
    }
    const latest = [...latestByStem.values()];
    const ready = latest.filter((candidate) => {
      const observation = this.observations.get(candidate.path);
      if (!observation || observation.readyEmitted || now - observation.unchangedSinceMs < this.settleMs) return false;
      observation.readyEmitted = true;
      return true;
    });
    return { latest, ready };
  }
}

export async function candidateForFile(filePath: string): Promise<RecordingCandidate> {
  const resolved = path.resolve(filePath);
  if (!isRecordingFile(resolved)) throw new Error('Recording must be an .mp4 or .mov file.');
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error(`Recording is not a file: ${resolved}`);
  const recordedAtMs = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
  const stem = cleanShotStem(resolved);
  return {
    path: resolved,
    stem,
    slug: slugifyRecordingStem(stem),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    recordedAt: new Date(recordedAtMs).toISOString(),
    sessionId: await sessionAtRecordingTime(recordedAtMs),
  };
}
