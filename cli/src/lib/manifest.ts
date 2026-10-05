import * as fs from 'fs';
import * as yaml from 'yaml';
import { stringifyDoc } from './yaml-io.js';
import { ensureLockTarget, atomicWriteFileSync, withFileLock } from './fs-atomic.js';
import type { Manifest } from './types.js';
import { safeJoin } from './paths.js';

export const MANIFEST_FILENAME = 'agents.yaml';

const manifestLockDepth = new Map<string, number>();

function parseManifest(content: string): Manifest {
  return yaml.parse(content) as Manifest;
}

function serializeManifest(manifest: Manifest, existingContent?: string | null): string {
  const entries = Object.entries(manifest as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  );
  const isEmpty = entries.length === 0;

  if (existingContent == null || existingContent.trim() === '') {
    return isEmpty ? '' : yaml.stringify(manifest, { indent: 2 });
  }

  const doc = yaml.parseDocument(existingContent);
  const current: Record<string, unknown> = (doc.toJSON() as Record<string, unknown>) ?? {};
  let changed = false;

  for (const [k, v] of entries) {
    if (JSON.stringify(current[k]) !== JSON.stringify(v)) {
      doc.set(k, v);
      changed = true;
    }
  }

  for (const k of Object.keys(current)) {
    const next = (manifest as Record<string, unknown>)[k];
    if (!(k in (manifest as object)) || next === undefined) {
      doc.delete(k);
      changed = true;
    }
  }

  if (!changed) return existingContent;

  return isEmpty ? '' : stringifyDoc(doc);
}

export function readManifest(repoPath: string): Manifest | null {
  const manifestPath = safeJoin(repoPath, MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  const content = fs.readFileSync(manifestPath, 'utf-8');
  return parseManifest(content);
}

function withManifestLock<T>(filePath: string, fn: () => T): T {
  const depth = manifestLockDepth.get(filePath) ?? 0;
  if (depth > 0) {
    manifestLockDepth.set(filePath, depth + 1);
    try {
      return fn();
    } finally {
      manifestLockDepth.set(filePath, depth);
    }
  }
  ensureLockTarget(filePath);
  return withFileLock(filePath, () => {
    manifestLockDepth.set(filePath, 1);
    try {
      return fn();
    } finally {
      manifestLockDepth.delete(filePath);
    }
  });
}

export function writeManifest(repoPath: string, manifest: Manifest): void {
  const manifestPath = safeJoin(repoPath, MANIFEST_FILENAME);
  withManifestLock(manifestPath, () => {
    let existing: string | null = null;
    try {
      existing = fs.readFileSync(manifestPath, 'utf-8');
    } catch {
    }
    if (existing !== null && existing.trim() === '') existing = null;
    const content = serializeManifest(manifest, existing);
    if (existing !== null && content === existing) return;
    atomicWriteFileSync(manifestPath, content);
  });
}

export function createDefaultManifest(): Manifest {
  return {
    agents: {},
    dependencies: {},
    mcp: {},
    defaults: {
      method: 'symlink',
      scope: 'global',
      agents: ['claude', 'codex', 'cursor', 'opencode'],
    },
  };
}
