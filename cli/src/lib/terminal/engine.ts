import type { Backend, EngineContext, LaunchRequest, LaunchResult, LaunchSpec } from './types.js';
import { BACKENDS } from './backends/index.js';
import { planLayouts, type Packing } from './policy.js';
import { runSpec, type HostResolver } from './transport.js';
import { homeRemainder, remoteCdPrefix } from '../project-root.js';
import { sshExec } from '../ssh-exec.js';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { awaitSpawnAck, ackLandedIn, localSpawnAckPath, spawnAckRelPath, SPAWN_ACK_TIMEOUT_MS, type SpawnAck } from './backends/vscodium-agent.js';

const DEFAULT_STAGGER_MS = 400;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function specsForRequest(req: LaunchRequest, nonce?: string): LaunchSpec[] {
  const backend = BACKENDS[req.backend];
  if (!backend) throw new Error(`unknown backend: ${req.backend}`);
  const meta =
    req.agent || req.sessionId || req.title || req.project || nonce
      ? { agent: req.agent, sessionId: req.sessionId, title: req.title, project: req.project, nonce }
      : undefined;
  const specs = req.layout === 'tab'
    ? backend.buildTab(req.cwd, req.command, meta)
    : backend.buildSplit(req.cwd, req.command, req.layout === 'split-down' ? 'down' : 'right', meta);
  return Array.isArray(specs) ? specs : [specs];
}

export interface OpenOptions {
  resolveHost?: HostResolver;
  ctx?: EngineContext;
  ackTimeoutMs?: number;
}

function ackReader(nonce: string, host: string | undefined, resolveHost?: HostResolver): () => string | undefined {
  if (!host || host === 'local') {
    const file = localSpawnAckPath(nonce);
    return () => {
      try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
    };
  }
  const target = resolveHost ? resolveHost(host) : host;
  return () => {
    const res = sshExec(target, `cat "$HOME"/${spawnAckRelPath(nonce)} 2>/dev/null`, { multiplex: true });
    return res.code === 0 ? res.stdout : undefined;
  };
}

function ackFailure(ack: SpawnAck | undefined, req: LaunchRequest, timeoutMs: number): string | undefined {
  if (!ack) return `the editor extension never confirmed the tab (no spawn ack within ${Math.round(timeoutMs / 1000)}s)`;
  if (!ackLandedIn(ack, req.project)) {
    const where = ack.workspaceName ?? (ack.windowFolders.join(', ') || 'an unknown window');
    if (ack.status === 'failed') return `window "${where}" tried to open the tab but its process never started`;
    if (ack.status === 'wrong-window') return `the request reached window "${where}", which does not hold ${req.project ?? 'the project'}; nothing was opened`;
    return `the tab opened in window "${where}", not ${req.project ?? 'the project window'}`;
  }
  return undefined;
}

export async function openSurface(req: LaunchRequest, opts: OpenOptions = {}): Promise<LaunchResult> {
  try {
    let resolved = req;
    if (req.host && req.host !== 'local' && homeRemainder(req.cwd) !== null) {
      const target = opts.resolveHost ? opts.resolveHost(req.host) : req.host;
      const result = sshExec(target, remoteCdPrefix(req.cwd) + 'pwd -P', { multiplex: true });
      const cwd = result.stdout.replace(/\r?\n$/, '');
      if (result.code !== 0 || !cwd.startsWith('/') || /[\r\n]/.test(cwd)) {
        throw new Error(`Cannot resolve directory ${req.cwd} on ${req.host}: ${(result.stderr || '').trim() || 'no absolute working directory returned'}`);
      }
      resolved = { ...req, cwd };
    }
    const nonce = req.backend === 'vscodium-agent' ? randomUUID() : undefined;
    for (const spec of specsForRequest(resolved, nonce)) {
      const res = await runSpec(spec, req.host, opts.resolveHost);
      if (!res.ok) return { ok: false, request: req, error: res.error };
    }
    if (!nonce) return { ok: true, request: req };
    const timeoutMs = opts.ackTimeoutMs ?? SPAWN_ACK_TIMEOUT_MS;
    const ack = await awaitSpawnAck(nonce, ackReader(nonce, req.host, opts.resolveHost), timeoutMs);
    const failure = ackFailure(ack, req, timeoutMs);
    return failure ? { ok: false, request: req, error: failure, ack } : { ok: true, request: req, ack };
  } catch (err: any) {
    return { ok: false, request: req, error: err?.message ?? String(err) };
  }
}

export interface SurfaceItem {
  cwd: string;
  command: string[];
  agent?: string;
  sessionId?: string;
  title?: string;
  project?: string;
}

export interface BuildRequestsOptions {
  backend: Backend;
  host?: string;
  packing?: Packing;
}

export function buildRequests(items: SurfaceItem[], opts: BuildRequestsOptions): LaunchRequest[] {
  const layouts = planLayouts(items.length, opts.packing ?? 'two-per-tab');
  return items.map((item, i) => ({
    backend: opts.backend,
    layout: layouts[i],
    cwd: item.cwd,
    command: item.command,
    host: opts.host,
    agent: item.agent,
    sessionId: item.sessionId,
    title: item.title,
    project: item.project,
  }));
}

export interface OpenManyOptions extends OpenOptions, BuildRequestsOptions {
  staggerMs?: number;
}

export async function openSurfaces(items: SurfaceItem[], opts: OpenManyOptions): Promise<LaunchResult[]> {
  const requests = buildRequests(items, opts);
  const stagger = opts.staggerMs ?? DEFAULT_STAGGER_MS;
  const results: LaunchResult[] = [];
  for (let i = 0; i < requests.length; i++) {
    results.push(await openSurface(requests[i], opts));
    if (i < requests.length - 1) await sleep(stagger);
  }
  return results;
}
