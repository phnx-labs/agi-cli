
import * as fs from 'fs';
import * as path from 'path';
import type { SessionAgentId, SessionMeta } from '@phnx-labs/sessions-cli/reader';
import { deriveShortId } from '../text/short-id.js';
import { getCacheDir } from '../state.js';
import { readToken, rushOrgHandle } from '../cloud/rush.js';
import { RUSH_API_BASE } from '../rush-api.js';

const CLOUD_CACHE_DIR = path.join(getCacheDir(), 'cloud-runs');
const CLOUD_EXECUTION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

interface CloudSessionRow {
  id: string;
  harness?: string;
  status?: string;
  title?: string | null;
  prompt?: string | null;
  project?: string | null;
  branch?: string | null;
  created_at?: string;
  updated_at?: string | null;
}

async function api(endpoint: string, token: string, accept?: string): Promise<Response> {
  return fetch(`${RUSH_API_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}`, ...(accept ? { Accept: accept } : {}) },
  });
}

function harnessToFormat(harness: string | undefined): SessionAgentId | null {
  if (harness === 'claude' || harness === 'codex' || harness === 'opencode') return harness;
  return null;
}

function assertContained(candidate: string, rootDir: string): string {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, candidate);
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes cloud session cache: ${candidate}`);
  }
  return resolved;
}

function validateCloudExecutionId(executionId: string): string {
  if (!CLOUD_EXECUTION_ID_RE.test(executionId)) {
    throw new Error(`Invalid cloud execution_id: ${JSON.stringify(executionId)}`);
  }
  return executionId;
}


function cachePathForExecution(executionId: string, agent: SessionAgentId): string {
  const id = validateCloudExecutionId(executionId);
  return assertContained(path.join(id, `session.${agent}.jsonl`), CLOUD_CACHE_DIR);
}

export async function discoverCloudSessions(options?: {
  limit?: number;
}): Promise<SessionMeta[]> {
  const token = readToken();
  const org = await rushOrgHandle(token);
  const limit = options?.limit ?? 50;
  const res = await api(`/o/${encodeURIComponent(org)}/sessions?limit=${limit}`, token);
  if (!res.ok) {
    throw new Error(`cloud sessions list failed (${res.status})`);
  }
  const data = (await res.json()) as { sessions: CloudSessionRow[] };
  const rows = data.sessions ?? [];

  const out: SessionMeta[] = [];
  for (const row of rows) {
    const agent = harnessToFormat(row.harness);
    if (!agent) continue;
    const id = validateCloudExecutionId(row.id);
    const timestamp = row.updated_at || row.created_at || new Date().toISOString();
    const project = row.project ?? undefined;

    const filePath = cachePathForExecution(id, agent);

    out.push({
      id,
      shortId: deriveShortId(id),
      agent,
      timestamp,
      project,
      filePath,
      topic: (row.title || row.prompt)?.split('\n')[0]?.slice(0, 120),
      label: `[cloud/${row.status}]${row.branch ? ` ${row.branch}` : ''}`,
    });
  }

  out.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return out;
}

export async function ensureCloudSessionCached(
  executionId: string,
  destPath?: string,
): Promise<string> {
  const id = validateCloudExecutionId(executionId);
  const callerPath = destPath ? assertContained(destPath, CLOUD_CACHE_DIR) : undefined;
  const token = readToken();
  const org = await rushOrgHandle(token);
  const res = await api(`/o/${encodeURIComponent(org)}/p/_/sessions/${encodeURIComponent(id)}/trajectory`, token, 'application/x-ndjson');
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

export function isCloudSessionPath(filePath: string): boolean {
  const root = path.resolve(CLOUD_CACHE_DIR);
  const resolved = path.resolve(filePath);
  return resolved.startsWith(root + path.sep);
}
