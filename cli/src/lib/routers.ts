
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

export interface RouterHarnessAllowlist {
  models: string[];
  accounts?: string[];
}

export interface Router {
  name: string;
  task?: string;
  harnesses: Record<string, RouterHarnessAllowlist>;
  weights?: { cost?: number; success?: number; headroom?: number };
  hijack?: boolean;
}

const ROUTER_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,48}$/i;

export function routersDir(): string {
  return path.join(getUserAgentsDir(), 'routers');
}

function routerPath(name: string): string {
  return path.join(routersDir(), `${name}.yml`);
}

export function validateRouterName(name: string): void {
  if (!ROUTER_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid router name '${name}'. Use letters, digits, dash, underscore (max 48 chars).`);
  }
}

export function routerExists(name: string, cwd?: string): boolean {
  validateRouterName(name);
  return resolveResource('routers', name, cwd) !== null;
}

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

export function readRouter(name: string, cwd?: string): Router {
  validateRouterName(name);
  const resolved = resolveResource('routers', name, cwd);
  if (!resolved) {
    throw new Error(`Router '${name}' not found.`);
  }
  return parseRouterFile(resolved.path, name);
}

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

export function deleteRouter(name: string): boolean {
  validateRouterName(name);
  const file = routerPath(name);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

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

export function listRouters(cwd?: string): Router[] {
  const routers: Router[] = [];
  for (const resolved of listResources('routers', cwd)) {
    try {
      routers.push(parseRouterFile(resolved.path, resolved.name));
    } catch {
    }
  }
  return routers.sort((a, b) => a.name.localeCompare(b.name));
}
