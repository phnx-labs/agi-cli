/**
 * Rush Cloud session source.
 *
 * Fetches cloud-captured sessions from the cloud proxy (api.prix.dev) and caches
 * them locally so the existing filesystem-based parse pipeline works unchanged.
 *
 * Endpoints consumed by the cloud proxy:
 *   GET /api/v1/cloud-runs                  → list executions
 *   GET /api/v1/cloud-runs/:id              → get one (used for meta)
 *   GET /api/v1/cloud-runs/:id/session.jsonl → raw captured jsonl
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import type { SessionAgentId, SessionMeta } from './types.js';
import { deriveShortId } from '../text/short-id.js';
import { getCacheDir } from '../state.js';
import { isRushSessionExpired } from '../rush-session.js';

const PROXY_BASE = process.env.RUSH_PROXY_BASE ?? 'https://api.prix.dev';
const USER_YAML = path.join(os.homedir(), '.rush', 'user.yaml');
const CLOUD_CACHE_DIR = path.join(getCacheDir(), 'cloud-runs');
const CLOUD_EXECUTION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

interface UserYaml {
  session?: {
    email?: string;
    access_token?: string;
    expires_at?: number;
  };
}

interface CloudRunRow {
  execution_id: string;
  agent: string;
  status: string;
  prompt?: string;
  repo_owner?: string;
  repo_name?: string;
  branch?: string;
  pr_url?: string;
  created_at?: string;
  updated_at?: string;
}

function readToken(): string {
  if (!fs.existsSync(USER_YAML)) {
    throw new Error('Not logged in to Rush. Run `rush login` first.');
  }
  const raw = fs.readFileSync(USER_YAML, 'utf-8');
  const data = yaml.parse(raw) as UserYaml;
  const token = data?.session?.access_token;
  if (!token) {
    throw new Error('No session token in ~/.rush/user.yaml. Run `rush login` first.');
  }
  const expiresAt = data.session?.expires_at;
  if (isRushSessionExpired(expiresAt)) {
    const expiredAt = new Date(expiresAt!).toISOString();
    throw new Error(`Rush session expired at ${expiredAt}. Run \`rush login\` to refresh.`);
  }
  return token;
}

async function api(method: string, endpoint: string, token: string): Promise<Response> {
  return fetch(`${PROXY_BASE}${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Coerce the `agent` field on a cloud-run row to a SessionAgentId. */
function agentToFormat(agent: string): SessionAgentId | null {
  if (agent === 'claude') return 'claude';
  if (agent === 'codex') return 'codex';
  if (agent === 'rush') return 'rush';
  if (agent === 'droid') return 'droid';
  if (agent === 'opencode') return 'opencode';
  return null;
}

export function assertContained(candidate: string, rootDir: string): string {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, candidate);
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes cloud session cache: ${candidate}`);
  }
  return resolved;
}

export function validateCloudExecutionId(executionId: string): string {
  if (!CLOUD_EXECUTION_ID_RE.test(executionId)) {
    throw new Error(`Invalid cloud execution_id: ${JSON.stringify(executionId)}`);
  }
  return executionId;
}

function cachePathForExecution(executionId: string, agent: SessionAgentId): string {
  const id = validateCloudExecutionId(executionId);
  return assertContained(path.join(id, `session.${agent}.jsonl`), CLOUD_CACHE_DIR);
}

/**
 * List cloud executions the user has captured sessions for. Includes
 * completed + needs_review + failed; an empty session_path means capture
 * never ran, so those are silently dropped.
 */
export async function discoverCloudSessions(options?: {
  limit?: number;
}): Promise<SessionMeta[]> {
  const token = readToken();
  const limit = options?.limit ?? 50;
  const res = await api('GET', `/api/v1/cloud-runs?limit=${limit}`, token);
  if (!res.ok) {
    throw new Error(`cloud-runs list failed (${res.status})`);
  }
  const data = (await res.json()) as { executions: CloudRunRow[] };
  const rows = data.executions ?? [];

  const out: SessionMeta[] = [];
  for (const row of rows) {
    const agent = agentToFormat(row.agent);
    if (!agent) continue;
    const id = validateCloudExecutionId(row.execution_id);
    const timestamp = row.updated_at || row.created_at || new Date().toISOString();
    const project = row.repo_owner && row.repo_name ? `${row.repo_owner}/${row.repo_name}` : undefined;

    // filePath doubles as the sink path for the cached jsonl. parseSession
    // dispatches on detectAgent which recognizes the `session.<format>.jsonl`
    // suffix — so the local cache file name must preserve it.
    const filePath = cachePathForExecution(id, agent);

    out.push({
      id,
      shortId: deriveShortId(id),
      agent,
      timestamp,
      project,
      filePath,
      topic: row.prompt?.split('\n')[0]?.slice(0, 120),
      label: `[cloud/${row.status}]${row.branch ? ` ${row.branch}` : ''}`,
    });
  }

  out.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return out;
}

/**
 * Fetch the jsonl for one cloud execution and stash it in the local cache.
 * Returns the local file path. Re-fetches on every call (cheap — executions
 * are immutable once complete). Callers may pass an already-known filePath.
 */
export async function ensureCloudSessionCached(
  executionId: string,
  destPath?: string,
): Promise<string> {
  const id = validateCloudExecutionId(executionId);
  const callerPath = destPath ? assertContained(destPath, CLOUD_CACHE_DIR) : undefined;
  const token = readToken();
  const res = await api('GET', `/api/v1/cloud-runs/${encodeURIComponent(id)}/session.jsonl`, token);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`session.jsonl fetch ${res.status}: ${body.slice(0, 200)}`);
  }
  const format = (res.headers.get('X-Session-Format') || '').toLowerCase();
  if (!['claude', 'codex', 'rush', 'opencode'].includes(format)) {
    throw new Error(`Unknown X-Session-Format on cloud response: "${format}"`);
  }

  const finalPath = callerPath ?? cachePathForExecution(id, format as SessionAgentId);
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  const body = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(finalPath, body);
  return finalPath;
}

/** True if filePath points into the cloud session cache dir. */
export function isCloudSessionPath(filePath: string): boolean {
  const root = path.resolve(CLOUD_CACHE_DIR);
  const resolved = path.resolve(filePath);
  return resolved.startsWith(root + path.sep);
}

/** Extract execution_id from a cloud cache path. */
export function executionIdFromCloudPath(filePath: string): string | null {
  if (!isCloudSessionPath(filePath)) return null;
  const rel = path.relative(CLOUD_CACHE_DIR, filePath);
  const parts = rel.split(path.sep);
  try {
    return parts[0] ? validateCloudExecutionId(parts[0]) : null;
  } catch {
    return null;
  }
}
