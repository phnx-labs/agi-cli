
import type { MonitorSource } from '../config.js';
import type { Observation } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BODY = 1024 * 1024;

export async function evaluate(source: MonitorSource): Promise<Observation | null> {
  const url = source.url;
  if (!url) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    let body = await res.text();
    if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY);
    return {
      raw: `${res.status}\n${body}`,
      meta: { status: res.status, ok: res.ok },
    };
  } catch (err) {
    return { raw: `error: ${(err as Error).message}`, meta: { status: 0, ok: false } };
  } finally {
    clearTimeout(timer);
  }
}
