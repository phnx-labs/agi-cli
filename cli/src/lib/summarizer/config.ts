
import { getConfigValue } from '../device-config.js';

export interface SummarizerConfig {
  enabled: boolean;
  baseUrl?: string;
  model?: string;
}

function envBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no' || v === '') return false;
  return undefined;
}

function envString(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  return v ? v : undefined;
}

export function resolveSummarizerConfig(env: NodeJS.ProcessEnv = process.env): SummarizerConfig {
  let storedEnabled: boolean | undefined;
  let storedBaseUrl: string | undefined;
  let storedModel: string | undefined;
  try {
    storedEnabled = getConfigValue('summarizer.enabled').value as boolean | undefined;
    storedBaseUrl = getConfigValue('summarizer.baseUrl').value as string | undefined;
    storedModel = getConfigValue('summarizer.model').value as string | undefined;
  } catch {
  }
  const enabled = envBool(env.AGENTS_SUMMARIZER_ENABLED) ?? storedEnabled ?? false;
  const baseUrl = envString(env.AGENTS_SUMMARIZER_BASEURL) ?? envString(storedBaseUrl);
  const model = envString(env.AGENTS_SUMMARIZER_MODEL) ?? envString(storedModel);
  return { enabled, baseUrl, model };
}

export function isSummarizerRunnable(config: SummarizerConfig): boolean {
  return config.enabled && Boolean(config.baseUrl) && Boolean(config.model);
}

let cachedReady: { at: number; value: boolean } | null = null;
const READY_TTL_MS = 3_000;

export function isSummarizerReady(nowMs: number = Date.now()): boolean {
  if (cachedReady && nowMs - cachedReady.at < READY_TTL_MS) return cachedReady.value;
  const value = isSummarizerRunnable(resolveSummarizerConfig());
  cachedReady = { at: nowMs, value };
  return value;
}

export function resetSummarizerReadyCacheForTest(): void {
  cachedReady = null;
}
