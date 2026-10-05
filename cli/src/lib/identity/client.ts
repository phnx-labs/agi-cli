/** The one place agents-cli talks to its account backend (Phoenix ID). The removed Prix layer
 * (RUSH-2581) hardcoded the URL in five files and re-read the token in seven; this has one base
 * URL, token reader, HTTP funnel and error type. */

import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteFileSync } from '../fs-atomic.js';
import { getRuntimeStateDir } from '../state.js';

/** Where the account backend lives: config, never a literal at a call site. Default is Phoenix
 * ID's custom domain; the legacy workers.dev host stays live for released clients, but new
 * clients and Workers must share this base so token verification can't drift. */
export const DEFAULT_PHOENIX_ID_BASE = 'https://id.byphoenix.com';
export const PHOENIX_ID_BASE = process.env.PHOENIX_ID_BASE ?? DEFAULT_PHOENIX_ID_BASE;

/** Our own session file. agents-cli never reads another product's credentials. */
export function sessionFilePath(): string {
  return path.join(getRuntimeStateDir(), 'phoenix-session.json');
}

export interface PhoenixSession {
  access_token: string;
  email?: string;
  userId?: string;
  /** Hosted OAuth profile image (https URL) when Phoenix ID exposes one; wins over the email-
   * Gravatar fallback in share attribution and is optional forever. */
  avatarUrl?: string;
  /** Display name from `/api/v1/auth/me`, persisted by `refreshSessionProfile`. */
  name?: string;
  /** Unix ms; absent means the server did not scope the token's lifetime. */
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

/** Replace the session file whole: a temp file renamed over it, so a crash mid-write never
 * leaves a truncated bearer, with an explicit 0600 because `writeFile`'s `mode` only applies to
 * a file it creates. */
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
    // Already gone: logging out twice is not an error.
  }
}

/** An error carrying the server's status and message, so callers can branch on it. */
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
  /** Send the stored session token. Default true; the device-flow start does not. */
  auth?: boolean;
  /** Use this token instead of the stored one (mid-login, before the write). */
  token?: string;
  timeoutMs?: number;
}

/** The single HTTP funnel. Every request to the account backend goes through here. */
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
