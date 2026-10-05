/** Router management: named, task-typed allowlists of (harness, model/tier, account) constraining an
 * Agent Router decision; a generalization of a profile. YAML under ~/.agents/routers/, resolved as
 * a layered resource but always CREATED in the user layer, mirroring profiles.ts. */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { getUserAgentsDir } from './state.js';
import { resolveResource, listResources } from './resources.js';
import { ALL_AGENT_IDS } from './agents.js';
import type { AgentId } from './types.js';
import { isTierToken, resolveTierMap, MODEL_TIERS } from './model-tiers.js';
import { getModelCatalog } from './models.js';
import { resolveVersion } from './installations/versions.js';

/** Per-harness allowlist inside a router: eligible models/tiers + linked accounts. */
export interface RouterHarnessAllowlist {
  /** Concrete model ids and/or tier tokens (cheap|default|best|ultra) eligible under this router. */
  models: string[];
  /** Durable credential accounts eligible under this router. Routing is limited to these. */
  accounts?: string[];
}

/** A named router: a reusable, task-typed allowlist of harnesses x models/tiers x accounts. */
export interface Router {
  name: string;
  /** Free-text task type this router serves (e.g. "research", "prod-refactor"). */
  task?: string;
  /** Allowlist -- only these harness x model/tier x account combos are eligible under this router. */
  harnesses: Record<string, RouterHarnessAllowlist>;
  /** Scoped policy weights, applied within the router (consumed by routing, a later ticket). */
  weights?: { cost?: number; success?: number; headroom?: number };
  /** Opt-in re-route of a pinned target when it's exhausted (consumed by routing, a later ticket). */
  hijack?: boolean;
}

const ROUTER_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,48}$/i;

/** Directory this machine writes router YAML files to (user layer). */
export function routersDir(): string {
  return path.join(getUserAgentsDir(), 'routers');
}

function routerPath(name: string): string {
  return path.join(routersDir(), `${name}.yml`);
}

/** Validate a router name against the allowed pattern. Throws on invalid input. */
export function validateRouterName(name: string): void {
  if (!ROUTER_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid router name '${name}'. Use letters, digits, dash, underscore (max 48 chars).`);
  }
}

/** Check whether a router resolves, project > user > system (like other resources). */
export function routerExists(name: string, cwd?: string): boolean {
  validateRouterName(name);
  return resolveResource('routers', name, cwd) !== null;
}

/** The layer a router resolves from, or null. `writeRouter`/`deleteRouter` touch only the user
 * layer, so callers editing or removing MUST check this first: editing a router from another layer
 * would write a user file that stays permanently shadowed. */
export function routerSource(name: string, cwd?: string): string | null {
  validateRouterName(name);
  return resolveResource('routers', name, cwd)?.source ?? null;
}

function parseRouterFile(file: string, name: string): Router {
  const raw = fs.readFileSync(file, 'utf-8');
  const parsed = yaml.parse(raw) as Router;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Router '${name}' is malformed.`);
  }
  if (!parsed.name) parsed.name = name;
  if (!parsed.harnesses || typeof parsed.harnesses !== 'object') parsed.harnesses = {};
  return parsed;
}

/** Read a router, resolved project > user > system. Throws if not found or malformed. */
export function readRouter(name: string, cwd?: string): Router {
  validateRouterName(name);
  const resolved = resolveResource('routers', name, cwd);
  if (!resolved) {
    throw new Error(`Router '${name}' not found.`);
  }
  return parseRouterFile(resolved.path, name);
}

/** Write a router to disk atomically (write-to-tmp then rename). Always writes the user layer. */
export function writeRouter(router: Router): void {
  validateRouterName(router.name);
  const dir = routersDir();
  fs.mkdirSync(dir, { recursive: true });
  const body = yaml.stringify(router);
  const file = routerPath(router.name);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body, 'utf-8');
  fs.renameSync(tmp, file);
}

/** Delete a router from the user layer. Returns false if it did not exist there. */
export function deleteRouter(name: string): boolean {
  validateRouterName(name);
  const file = routerPath(name);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

/** Rename a router on disk, re-keying the user-layer file and preserving every field. Throws if
 * `oldName` doesn't resolve or resolves from a non-user layer (see {@link routerSource}), or if
 * `newName` already resolves; there is no overwrite path. */
export function renameRouter(oldName: string, newName: string): void {
  validateRouterName(newName);
  const source = routerSource(oldName);
  if (source === null) {
    throw new Error(`Router '${oldName}' not found.`);
  }
  if (source !== 'user') {
    throw new Error(
      `Router '${oldName}' resolves from the '${source}' layer, not 'user' -- ` +
      `agents route rename can only rename a user-layer router. Rename its file directly, ` +
      `or create a user-layer router under a different name.`,
    );
  }
  if (routerExists(newName)) {
    throw new Error(`Router '${newName}' already exists; remove it first.`);
  }
  const router = readRouter(oldName);
  router.name = newName;
  writeRouter(router);
  deleteRouter(oldName);
}

/** Fail-loud validation (Agent Router spec E1): never persist a harness id or model/tier token
 * this machine can't vouch for; throws on the first invalid one. Harness ids need only be
 * registered; a model must be a tier token, a resolved tier rung, or in the extracted catalog. */
export function validateRouter(router: Router): void {
  for (const [harness, allowlist] of Object.entries(router.harnesses)) {
    if (!(ALL_AGENT_IDS as string[]).includes(harness)) {
      throw new Error(`router '${router.name}': unknown harness '${harness}'. Known harnesses: ${ALL_AGENT_IDS.join(', ')}.`);
    }
    const agent = harness as AgentId;
    for (const token of allowlist.models) {
      if (isTierToken(token)) continue;

      const version = resolveVersion(agent) ?? '0.0.0';
      const tierMap = resolveTierMap(agent, version);
      const tierRungIds = new Set(
        MODEL_TIERS.map((t) => tierMap[t].model).filter((m): m is string => m !== null),
      );
      if (tierRungIds.has(token)) continue;

      const catalog = getModelCatalog(agent, version);
      const inCatalog = catalog
        ? catalog.models.some((m) => m.id === token) || Boolean(catalog.aliases[token])
        : false;
      if (inCatalog) continue;

      throw new Error(
        `router '${router.name}': unknown model '${token}' for harness '${harness}'. ` +
        `Use a tier token (${MODEL_TIERS.join('|')}) or a model id '${harness}' actually ships.`,
      );
    }
  }
}

/** List every router resolved project > user > system (deduplicated union, project wins, same as
 * {@link resolveResource}); malformed files are silently skipped and surfaced by `agents route view
 * <name>`. */
export function listRouters(cwd?: string): Router[] {
  const routers: Router[] = [];
  for (const resolved of listResources('routers', cwd)) {
    try {
      routers.push(parseRouterFile(resolved.path, resolved.name));
    } catch {
      // Skip malformed router files.
    }
  }
  return routers.sort((a, b) => a.name.localeCompare(b.name));
}
