/**
 * The engine — turns requests into open surfaces.
 *
 * `specForRequest` and `buildRequests` are pure (planning); `openSurface` and
 * `openSurfaces` add the side-effecting transport. A batch runs sequentially and
 * staggered so a `split-right` lands in the tab that was just opened (the split
 * targets the front pane).
 */
import type { Backend, EngineContext, LaunchRequest, LaunchResult, LaunchSpec } from './types.js';
import { BACKENDS } from './backends/index.js';
import { planLayouts, type Packing } from './policy.js';
import { runSpec, type HostResolver } from './transport.js';
import { homeRemainder, remoteCdPrefix } from '../project-root.js';
import { sshExec } from '../ssh-exec.js';

const DEFAULT_STAGGER_MS = 400;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The concrete launch command for a request (pure — no side effects). */
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

/** Open a single surface for one request. Never throws — failures come back in the result. */
export async function openSurface(req: LaunchRequest, opts: OpenOptions = {}): Promise<LaunchResult> {
  try {
    // Both can throw: specForRequest on an unknown backend, runSpec when the
    // SSH transport rejects an invalid --device target. Keep them inside the
    // catch so a bad request degrades to a per-surface failure, never a throw.
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

/** One command to run as a surface. */
export interface SurfaceItem {
  cwd: string;
  command: string[];
  /** Optional harness identity for editor-backed backends (vscodium-agent). */
  agent?: string;
  sessionId?: string;
  title?: string;
}

export interface BuildRequestsOptions {
  backend: Backend;
  host?: string;
  packing?: Packing;
}

/** Turn a list of commands into layout-assigned requests (pure — the planning step). */
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

/**
 * Open many surfaces, applying the layout policy (default: two-per-tab).
 * Sequential + staggered so each split follows the tab it splits.
 */
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
