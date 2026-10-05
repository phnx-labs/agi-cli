// Sole Phoenix ID seam: canonical base URL, owned session file/token reader/HTTP funnel/error type; never read another product's credentials.
// Phoenix session state is replaced atomically with mode 0600.

import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteFileSync } from '../fs-atomic.js';
import { getRuntimeStateDir } from '../state.js';

export const DEFAULT_PHOENIX_ID_BASE = 'https://id.byphoenix.com';
export const PHOENIX_ID_BASE = process.env.PHOENIX_ID_BASE ?? DEFAULT_PHOENIX_ID_BASE;

export function sessionFilePath(): string {
  return path.join(getRuntimeStateDir(), 'phoenix-session.json');
}

export interface PhoenixSession {
  access_token: string;
  email?: string;
  userId?: string;
  avatarUrl?: string;
  name?: string;
  expires_at?: number;
}

export function readSession(): PhoenixSession | null {
  try {
    const raw = fs.readFileSync(sessionFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as PhoenixSession;
    return parsed.access_token ? parsed : null;
  } catch {
    return null;
  }
}

export function writeSession(session: PhoenixSession): void {
  const file = sessionFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, JSON.stringify(session, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function clearSession(): void {
  try {
    fs.rmSync(sessionFilePath(), { force: true });
  } catch {
  }
}

export class PhoenixApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'PhoenixApiError';
  }
}

interface RequestOptions {
  body?: unknown;
  auth?: boolean;
  token?: string;
  timeoutMs?: number;
}

export async function phoenixRequest<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  route: string,
  opts: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.auth !== false) {
    const token = opts.token ?? readSession()?.access_token;
    if (!token) throw new PhoenixApiError("Not signed in. Run 'agents auth login'.", 401);
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${PHOENIX_ID_BASE}${route}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PhoenixApiError(`Could not reach the account service (${detail}).`, 0);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `${response.status} ${response.statusText}`;
    throw new PhoenixApiError(message, response.status);
  }
  return payload as T;
}
