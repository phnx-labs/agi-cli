/**
 * agents.yaml manifest reading, writing, and serialization.
 *
 * The manifest file (agents.yaml) is the central configuration for version defaults,
 * repository overrides, dependencies, and MCP server declarations.
 */
import * as fs from 'fs';
import * as yaml from 'yaml';
import { stringifyDoc } from './yaml-io.js';
import { ensureLockTarget, atomicWriteFileSync, withFileLock } from './fs-atomic.js';
import type { Manifest } from './types.js';
import { safeJoin } from './paths.js';

/** Canonical filename for the manifest in any agents repo or project root. */
export const MANIFEST_FILENAME = 'agents.yaml';

// Per-path re-entrancy depth so withManifestLock is safe against recursive calls.
const manifestLockDepth = new Map<string, number>();

/** Parse a YAML string into a typed Manifest object. */
function parseManifest(content: string): Manifest {
  return yaml.parse(content) as Manifest;
}

/**
 * Serialize a Manifest to YAML WITHOUT destroying hand-written comments.
 *
 * Plain `yaml.stringify(manifest)` drops every comment, so `agents mcp add`
 * (and every other writeManifest caller) used to clobber annotations in
 * agents.yaml. Matching `serializeCentral` in state.ts: when existing file
 * text is provided, parse it into a `yaml.Document` (comments + key order
 * preserved) and edit only keys that actually changed. Untouched keys and
 * their comments stay byte-stable. Falls back to plain stringify when there
 * is no existing document yet.
 */
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

  // Full-document write: callers do read-modify-write, so keys absent from the
  // new manifest are intentional removals (e.g. clearing beta).
  for (const k of Object.keys(current)) {
    const next = (manifest as Record<string, unknown>)[k];
    if (!(k in (manifest as object)) || next === undefined) {
      doc.delete(k);
      changed = true;
    }
  }

  // Nothing changed → keep the file byte-identical (comments intact).
  if (!changed) return existingContent;

  // stringifyDoc still normalizes a legacy flow root (`{}`) to block so edited
  // nodes do not render flow, but no longer forces block on a normal document —
  // that flattened committed flow sequences and made this writer disagree with
  // the other agents.yaml writers (RUSH-2505). parseDocument still preserves
  // comments + key ordering.
  return isEmpty ? '' : stringifyDoc(doc);
}

/** Read and parse agents.yaml from a directory. Returns null if the file does not exist. */
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
  // Project manifests are shared (no restricted dir mode unlike ~/.agents).
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

/** Write a Manifest object to agents.yaml in the given directory. */
export function writeManifest(repoPath: string, manifest: Manifest): void {
  const manifestPath = safeJoin(repoPath, MANIFEST_FILENAME);
  withManifestLock(manifestPath, () => {
    let existing: string | null = null;
    try {
      existing = fs.readFileSync(manifestPath, 'utf-8');
    } catch {
      /* first write — no file yet (or empty lock target) */
    }
    // ensureLockTarget may have created an empty file for the lock path.
    if (existing !== null && existing.trim() === '') existing = null;
    const content = serializeManifest(manifest, existing);
    // Skip the atomic rewrite when nothing changed so comments stay byte-stable
    // and concurrent readers never see a no-op churn.
    if (existing !== null && content === existing) return;
    atomicWriteFileSync(manifestPath, content);
  });
}

/** Create a Manifest with sensible defaults for a fresh agents repo. */
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
