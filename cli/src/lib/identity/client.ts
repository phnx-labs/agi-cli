/**
 * The ONE place agents-cli talks to its account backend (Phoenix ID).
 *
 * Why a seam at all: the removed Prix-coupled layer (RUSH-2581) had no single
 * entry point — the backend URL was hardcoded in five files and the session
 * token was re-read from `~/.rush/user.yaml` by seven separate functions, so
 * re-pointing identity meant editing a dozen call sites and rewriting error
 * strings scattered through the tree. This module is the correction: one base
 * URL, one token reader, one HTTP funnel, one error type. Commands import from
 * here and nothing else.
 *
 * The shape mirrors the seams this repo already proved elsewhere —
 * the bounded secrets process client (`lib/secrets-client.ts`) and
 * `CloudProvider` (`lib/cloud/types.ts`) — so a second identity backend, if
 * one is ever needed, is a swap here rather than a sweep across commands.
 */

import * as fs from 'fs';
import * as path from 'path';

import { getRuntimeStateDir } from '../state.js';

/**
 * Where the account backend lives. Config, never a literal at a call site.
 *
 * The default is Phoenix ID's branded custom domain. The legacy workers.dev
 * hostname remains live for already-released clients, but new clients and
 * managed Workers must share this canonical base so token verification cannot
 * drift across the release boundary.
 */
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
  /**
   * Hosted OAuth profile image (https URL), when Phoenix ID exposes one. Wins
   * over the email-Gravatar fallback in share attribution. Optional forever —
   * a missing value just means the Gravatar/initials fallback.
   */
  avatarUrl?: string;
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

export function writeSession(session: PhoenixSession): void {
  const file = sessionFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(session, null, 2), { mode: 0o600 });
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
