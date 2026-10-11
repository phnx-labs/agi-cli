import type { Backend, EngineContext, LaunchRequest, LaunchResult, LaunchSpec } from './types.js';
import { BACKENDS } from './backends/index.js';
import { planLayouts, type Packing } from './policy.js';
import { runSpec, type HostResolver } from './transport.js';
import { homeRemainder, remoteCdPrefix } from '../project-root.js';
import { sshExec } from '../ssh-exec.js';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { awaitSpawnAck, ackLandedIn, localSpawnAckPath, SPAWN_ACK_TIMEOUT_MS, type SpawnAck } from './backends/vscodium-agent.js';

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

function ackReader(nonce: string): () => string | undefined {
  const file = localSpawnAckPath(nonce);
  return () => {
    try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
  };
}

function ackFailure(ack: SpawnAck | undefined, req: LaunchRequest, timeoutMs: number): string | undefined {
  if (!ack) return `VSCodium didn't confirm a tab within ${Math.round(timeoutMs / 1000)}s`;
  if (!ackLandedIn(ack, req.project)) {
    const where = ack.workspaceName ?? (ack.windowFolders.join(', ') || 'an unknown window');
    const why = ack.reason ? ` (${ack.reason})` : '';
    if (ack.status === 'failed') return `window "${where}" could not open the tab${why}`;
    if (ack.status === 'wrong-window') return `the request reached window "${where}", which does not hold ${req.project ?? 'the project'}; nothing was opened${why}`;
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
    // The extension opens a /spawn only in the window holding its project.
    // The ack is a file on the machine running the editor; it is read here only.
    if (req.backend === 'vscodium-agent' && req.host && req.host !== 'local') {
      return { ok: false, request: req, error: `VSCodium tabs open on this machine only; run the command on ${req.host} instead of passing --device` };
    }
    if (req.backend === 'vscodium-agent' && !req.project) {
      return { ok: false, request: req, error: `no local project folder for ${req.cwd}, so there is no VSCodium window to open it in` };
    }
    const nonce = req.backend === 'vscodium-agent' ? randomUUID() : undefined;
    for (const spec of specsForRequest(resolved, nonce)) {
      const res = await runSpec(spec, req.host, opts.resolveHost);
      if (!res.ok) return { ok: false, request: req, error: res.error };
    }
    if (!nonce) return { ok: true, request: req };
    const timeoutMs = opts.ackTimeoutMs ?? SPAWN_ACK_TIMEOUT_MS;
    const ack = await awaitSpawnAck(nonce, ackReader(nonce), timeoutMs);
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

// What the terminal that ran the command is told about one launch. Only what was
// confirmed is reported: an editor ack names the window and tab; a backend that gives
// no confirmation is said to have been sent the request, never to have opened it.
export function describeLaunch(result: LaunchResult, subject: { verb: string; label: string }): string {
  const ack = result.ack;
  if (!result.ok) return `Can't open ${subject.label}: ${result.error ?? 'unknown error'}.`;
  if (ack) {
    const window = ack.workspaceName ?? ack.windowFolders[0] ?? 'unknown';
    const tab = ack.title ?? ack.terminalId ?? 'untitled';
    return ack.status === 'focused-existing'
      ? `Already open → focused tab "${tab}" in window "${window}"`
      : `${subject.verb} ${subject.label}\n  → VSCodium window "${window}", new tab "${tab}"`;
  }
  const label = BACKENDS[result.request.backend]?.label ?? result.request.backend;
  return `Sent ${subject.label} to ${label}. ${label} does not report back, so whether the tab opened is not confirmed.`;
}
