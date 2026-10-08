import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getUserAgentsDir } from '../state.js';
import { atomicWriteFile } from '../fs-atomic.js';
import { runProcess } from './process.js';

interface RecordingsConfig {
  directory?: string;
}

export function recordingsStateDir(): string {
  return path.join(getUserAgentsDir(), 'recordings');
}

export function recordingsConfigPath(): string {
  return path.join(recordingsStateDir(), 'config.json');
}

export function recordingsLedgerPath(): string {
  return path.join(recordingsStateDir(), 'ledger.json');
}

async function readConfig(): Promise<RecordingsConfig> {
  try {
    return JSON.parse(await fs.readFile(recordingsConfigPath(), 'utf8')) as RecordingsConfig;
  } catch {
    return {};
  }
}

export async function writeRecordingDirectory(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Recording directory does not exist: ${resolved}`);
  await fs.mkdir(recordingsStateDir(), { recursive: true, mode: 0o700 });
  await atomicWriteFile(recordingsConfigPath(), `${JSON.stringify({ directory: resolved }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

export async function defaultCleanShotDirectory(): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new Error('CleanShot export directory auto-detection is available only on macOS. Pass --dir <path>.');
  }
  const result = await runProcess('defaults', ['read', 'pl.maketheweb.cleanshotx', 'exportPath'], { timeoutMs: 5_000 });
  const directory = result.stdout.trim();
  if (result.exitCode !== 0 || !directory) {
    throw new Error('Could not read CleanShot exportPath. Set it in CleanShot or pass --dir <path>.');
  }
  return directory;
}

export async function resolveRecordingDirectory(override?: string): Promise<string> {
  const configured = (await readConfig()).directory;
  const directory = override || configured || await defaultCleanShotDirectory();
  const resolved = path.resolve(directory);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Recording directory does not exist: ${resolved}`);
  return resolved;
}
