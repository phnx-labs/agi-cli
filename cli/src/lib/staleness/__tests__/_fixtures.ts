
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

import type { SyncManifest } from '../types.js';

const HARNESS_TS = path.join(__dirname, '_harness.ts');

export interface Fixture {
  home: string;
  userDir: string;
  systemDir: string;
  projectRoot: string;
  projectAgents: string;
  cleanup(): void;
}

export function newFixture(prefix: string): Fixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `stale-e2e-${prefix}-`));
  const userDir = path.join(home, '.agents');
  const systemDir = path.join(userDir, '.system');
  const projectRoot = path.join(home, 'project');
  const projectAgents = path.join(projectRoot, '.agents');
  fs.mkdirSync(userDir, { recursive: true });
  fs.mkdirSync(systemDir, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  return {
    home,
    userDir,
    systemDir,
    projectRoot,
    projectAgents,
    cleanup() { fs.rmSync(home, { recursive: true, force: true }); },
  };
}

export type Layer = 'project' | 'user' | 'system';

export function layerBase(fx: Fixture, layer: Layer): string {
  if (layer === 'project') {
    fs.mkdirSync(fx.projectAgents, { recursive: true });
    return fx.projectAgents;
  }
  if (layer === 'user')   return fx.userDir;
  return fx.systemDir;
}

export function writeFile(fx: Fixture, layer: Layer, rel: string, content: string): string {
  const abs = path.join(layerBase(fx, layer), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

export function writeExecFile(fx: Fixture, layer: Layer, rel: string, content: string): string {
  const abs = writeFile(fx, layer, rel, content);
  fs.chmodSync(abs, 0o755);
  return abs;
}

export function removeFile(fx: Fixture, layer: Layer, rel: string): void {
  try { fs.unlinkSync(path.join(layerBase(fx, layer), rel)); } catch {  }
}

export function rmDir(fx: Fixture, layer: Layer, rel: string): void {
  fs.rmSync(path.join(layerBase(fx, layer), rel), { recursive: true, force: true });
}

export function readFile(fx: Fixture, layer: Layer, rel: string): string {
  return fs.readFileSync(path.join(layerBase(fx, layer), rel), 'utf-8');
}

export const AGENT = 'claude';
export const VERSION = '0.0.0-test';


interface HarnessResult {
  manifest?: SyncManifest;
  stale?: boolean;
  exists?: boolean;
  names?: string[];
}

function callHarness(fx: Fixture, op: object): HarnessResult {
  const out = execFileSync('bun', [HARNESS_TS, JSON.stringify(op)], {
    env: { ...process.env, HOME: fx.home },
    encoding: 'utf-8',
  });
  return JSON.parse(out) as HarnessResult;
}

export function build(fx: Fixture, opts: { cwd?: string; agent?: string; version?: string } = {}): SyncManifest {
  const cwd = opts.cwd ?? fx.projectRoot;
  const agent = opts.agent ?? AGENT;
  const version = opts.version ?? VERSION;
  const result = callHarness(fx, { cmd: 'build', agent, version, cwd });
  if (!result.manifest) throw new Error('build did not return manifest');
  return result.manifest;
}

export function isStale(fx: Fixture, opts: { cwd?: string; agent?: string; version?: string } = {}): boolean {
  const cwd = opts.cwd ?? fx.projectRoot;
  const agent = opts.agent ?? AGENT;
  const version = opts.version ?? VERSION;
  const result = callHarness(fx, { cmd: 'isStale', agent, version, cwd });
  if (!result.exists) throw new Error('manifest does not exist; call build() first');
  return result.stale === true;
}

export function list(fx: Fixture, type: string, cwd?: string): string[] {
  const result = callHarness(fx, { cmd: 'list', type, cwd: cwd ?? fx.projectRoot });
  return result.names ?? [];
}

export function tickMtime(): void {
  const end = Date.now() + 15;
  while (Date.now() < end) {  }
}
