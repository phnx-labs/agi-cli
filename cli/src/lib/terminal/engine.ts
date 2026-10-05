import type { Backend, EngineContext, LaunchRequest, LaunchResult, LaunchSpec } from './types.js';
import { BACKENDS } from './backends/index.js';
import { planLayouts, type Packing } from './policy.js';
import { runSpec, type HostResolver } from './transport.js';
import { homeRemainder, remoteCdPrefix } from '../project-root.js';
import { sshExec } from '../ssh-exec.js';

const DEFAULT_STAGGER_MS = 400;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function specForRequest(req: LaunchRequest): LaunchSpec {
  const backend = BACKENDS[req.backend];
  if (!backend) throw new Error(`unknown backend: ${req.backend}`);
  const meta =
    req.agent || req.sessionId || req.title
      ? { agent: req.agent, sessionId: req.sessionId, title: req.title }
      : undefined;
  if (req.layout === 'tab') return backend.buildTab(req.cwd, req.command, meta);
  return backend.buildSplit(
    req.cwd,
    req.command,
    req.layout === 'split-down' ? 'down' : 'right',
    meta,
  );
}

export interface OpenOptions {
  resolveHost?: HostResolver;
  ctx?: EngineContext;
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
    const spec: LaunchSpec = specForRequest(resolved);
    const res = await runSpec(spec, req.host, opts.resolveHost);
    return { ok: res.ok, request: req, error: res.error };
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
