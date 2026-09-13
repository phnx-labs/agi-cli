/**
 * Session artifact discovery and resolution.
 *
 * Scans parsed session events for file-write tool calls (Write, Edit, etc.)
 * and returns metadata about each artifact: path, authoring tool, existence
 * on disk, and file size. Used by the artifacts subcommand and session detail views.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SessionMeta, SessionArtifact } from './types.js';
import { parseSession } from './parse.js';
import { toComparablePath } from '../platform/index.js';

/** Tool names that produce file artifacts (writes, edits, patches). */
const WRITE_TOOLS = new Set([
  'Write', 'Edit', 'write_file', 'edit_file', 'create_file', 'replace', 'patch',
]);

/** Parse a session and return metadata for every file written or edited during it. */
export function discoverArtifacts(meta: SessionMeta): SessionArtifact[] {
  let events;
  try {
    events = parseSession(meta.filePath, meta.agent);
  } catch {
    return [];
  }

  // Map path -> last write event (later occurrence wins for dedup)
  const latestByPath = new Map<string, { tool: string; timestamp: string }>();

  for (const event of events) {
    if (event.type !== 'tool_use') continue;
    const tool = event.tool || '';
    if (!WRITE_TOOLS.has(tool)) continue;

    const p = event.path
      || event.args?.file_path
      || event.args?.path
      || event.args?.filePath
      || '';
    if (!p) continue;

    latestByPath.set(p, { tool, timestamp: event.timestamp });
  }

  const artifacts: SessionArtifact[] = [];
  for (const [p, { tool, timestamp }] of latestByPath) {
    let exists = false;
    let sizeBytes: number | undefined;
    try {
      const stat = fs.lstatSync(p);
      if (stat.isFile()) {
        exists = true;
        sizeBytes = stat.size;
      }
    } catch {
      // file gone, inaccessible, or symlink/special file
    }

    artifacts.push({
      path: p,
      tool,
      timestamp,
      exists,
      sizeBytes: exists ? sizeBytes : undefined,
      sessionId: meta.id,
    });
  }

  return artifacts;
}

/** Refuse to load artifact files larger than this. Returns '' silently above the cap. */
const ARTIFACT_MAX_BYTES = 50_000_000;

/** Read the current contents of an artifact file from disk. Rejects symlinks. */
export function readArtifact(artifact: SessionArtifact): string {
  const stat = fs.lstatSync(artifact.path);
  if (!stat.isFile()) {
    throw new Error(`Refusing to read non-regular file: ${artifact.path}`);
  }
  if (stat.size > ARTIFACT_MAX_BYTES) return '';
  return fs.readFileSync(artifact.path, 'utf-8');
}

/** Resolve a user-provided name to an artifact by exact path, basename, or path suffix. */
export function resolveArtifact(
  artifacts: SessionArtifact[],
  name: string,
): SessionArtifact | null {
  // Exact path match
  const exact = artifacts.find(a => a.path === name);
  if (exact) return exact;

  // Basename match
  const byBase = artifacts.filter(a => path.basename(a.path) === name);
  if (byBase.length === 1) return byBase[0];
  if (byBase.length > 1) return byBase[0];

  // Path suffix match (e.g. "src/foo.ts"). Normalize so Windows `\` paths match
  // a forward-slash query too; on POSIX this is identical to the old comparison.
  const target = toComparablePath(name);
  const bySuffix = artifacts.filter(a => {
    const ap = toComparablePath(a.path);
    return ap.endsWith('/' + target) || ap === target;
  });
  if (bySuffix.length >= 1) return bySuffix[0];

  return null;
}
