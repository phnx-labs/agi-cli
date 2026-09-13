/**
 * Portable session bundle — the on-the-wire format behind `agents sessions
 * export` / `import` (RUSH-1710 / RUSH-1711).
 *
 * A bundle is a self-describing NDJSON stream: the FIRST line is a
 * {@link BundleHeader}, every subsequent line is one {@link BundleRecord} (one
 * constituent file of a session). NDJSON — not tar — because the bundle has to
 * pipe cleanly over `agents ssh … export --stdout | … import -` (RUSH-1712)
 * without any external archiver on either box, stays inspectable with `head`,
 * and lets each file body carry its own encryption envelope.
 *
 * This module owns the FORMAT and the import PLACEMENT only; selecting which
 * sessions to export (which needs the session DB) lives in the export command.
 * Placement reuses the sync mirror model verbatim: a foreign machine's session
 * lands at {@link mirrorPath}(spec, originMachine, relKey), exactly where the
 * cross-machine sync writes it — so the existing scanner indexes it as a
 * machine-tagged row and "local always wins" falls out of the scanner's
 * live-home-first dedup with no extra logic here.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { SYNC_AGENTS, mirrorPath, type SyncAgentSpec } from './sync/agents.js';
import { redactSecrets } from '../redact.js';
import { encryptTranscript, decryptTranscriptBody } from './sync/transcript-crypto.js';

export const BUNDLE_KIND = 'agents-session-bundle';
const BUNDLE_VERSION = 1;

/** SHA-256 of a file body, used for the bundle's dedup/conflict check on import. */
function hashContent(content: string | Uint8Array): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** First line of a bundle: what it is and how the bodies are encoded. */
export interface BundleHeader {
  kind: typeof BUNDLE_KIND;
  version: number;
  /** ISO timestamp the bundle was produced. */
  exportedAt: string;
  /** Machine that produced the bundle (informational; per-record `machine` is authoritative for placement). */
  origin: string;
  /** True when record bodies are AES-256-GCM envelopes (see transcript-crypto). */
  encrypted: boolean;
  /** True when bodies were secret-scrubbed before hashing/sealing. */
  redacted: boolean;
  /** Number of file records that follow. */
  count: number;
  /** Distinct session count across those records. */
  sessions: number;
}

/** One constituent file of one session. Dir-shaped sessions emit several, sharing `sessionId`. */
export interface BundleRecord {
  /** SYNC_AGENTS id (claude, codex, kimi, …). */
  agent: string;
  /** ORIGIN machine of this session — where placement mirrors it to. */
  machine: string;
  sessionId: string;
  /** Storage-relative key within the agent's subdir (preserved on import). */
  relKey: string;
  /** Byte length of the plaintext body. */
  size: number;
  /** SHA-256 of the plaintext body — identity + byte-exact dedup. */
  hash: string;
  /** Human label carried from SessionMeta, if any. */
  label?: string;
  /** True when `body` is an encryption envelope rather than plaintext. */
  encrypted: boolean;
  /** File content: plaintext, or a transcript-crypto envelope when `encrypted`. */
  body: string;
}

export interface ParsedBundle {
  header: BundleHeader;
  records: BundleRecord[];
}

/** A single file selected for export, resolved to an absolute on-disk path. */
export interface FileToExport {
  agent: string;
  /** Origin machine of the session (self for live-home, the peer for a mirror). */
  machine: string;
  sessionId: string;
  relKey: string;
  absPath: string;
  label?: string;
}

interface BuildRecordOpts {
  /** Scrub secrets from the body before hashing/sealing (default-on at the command layer). */
  redact: boolean;
  /** Non-null → seal each body with this key; null → plaintext bodies. */
  encryptKey: Buffer | null;
  /**
   * Literal secret values to mask verbatim during redaction (value-aware pass):
   * e.g. live credentials from an injected secrets bundle, so they never leak in
   * an exported transcript regardless of format. Only used when `redact` is set.
   */
  knownSecrets?: readonly string[];
}

/** Look up the sync spec for an agent id (undefined → agent not sync-representable). */
export function specForAgent(agentId: string): SyncAgentSpec | undefined {
  return SYNC_AGENTS.find(s => s.id === agentId);
}

/**
 * Read one file and turn it into a bundle record. The hash and size are always
 * computed over the PLAINTEXT (post-redaction) body, so they equal what lands on
 * disk after import — keeping dedup byte-exact whether or not the bundle is
 * encrypted.
 */
export function buildRecord(file: FileToExport, opts: BuildRecordOpts): BundleRecord {
  let body = fs.readFileSync(file.absPath, 'utf-8');
  if (opts.redact) body = redactSecrets(body, opts.knownSecrets);
  const hash = hashContent(body);
  const size = Buffer.byteLength(body, 'utf-8');

  let stored = body;
  let encrypted = false;
  if (opts.encryptKey) {
    stored = encryptTranscript(body, opts.encryptKey);
    encrypted = true;
  }
  const rec: BundleRecord = {
    agent: file.agent,
    machine: file.machine,
    sessionId: file.sessionId,
    relKey: file.relKey,
    size,
    hash,
    encrypted,
    body: stored,
  };
  if (file.label) rec.label = file.label;
  return rec;
}

/** Build the header for a set of records. */
export function makeHeader(args: {
  origin: string;
  exportedAt: string;
  encrypted: boolean;
  redacted: boolean;
  records: BundleRecord[];
}): BundleHeader {
  const sessions = new Set(args.records.map(r => `${r.agent}:${r.machine}:${r.sessionId}`)).size;
  return {
    kind: BUNDLE_KIND,
    version: BUNDLE_VERSION,
    exportedAt: args.exportedAt,
    origin: args.origin,
    encrypted: args.encrypted,
    redacted: args.redacted,
    count: args.records.length,
    sessions,
  };
}

/**
 * Merge record sets from several bundles (e.g. a fan-out pull across hosts),
 * deduping by agent + origin machine + session + file so the same session seen
 * from two peers lands once. First occurrence wins.
 */
export function mergeRecords(sets: BundleRecord[][]): BundleRecord[] {
  const seen = new Set<string>();
  const out: BundleRecord[] = [];
  for (const set of sets) {
    for (const r of set) {
      const key = `${r.agent}:${r.machine}:${r.sessionId}:${r.relKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

/** Serialize a bundle to its NDJSON wire form (header line + one line per record). */
export function serializeBundle(header: BundleHeader, records: BundleRecord[]): string {
  const lines = [JSON.stringify(header)];
  for (const r of records) lines.push(JSON.stringify(r));
  return lines.join('\n') + '\n';
}

/**
 * Write a serialized bundle to disk owner-only (0600). A bundle carries raw
 * transcript bodies — even redacted, never world/group-readable — and encryption
 * is opt-in, so the file mode is the baseline confidentiality guard. `mode` on
 * `writeFileSync` only applies when the file is created, so we `chmod` too to
 * clamp an existing (possibly looser) file on overwrite.
 */
export function writeBundleFile(outPath: string, wire: string): void {
  fs.writeFileSync(outPath, wire, { encoding: 'utf-8', mode: 0o600 });
  fs.chmodSync(outPath, 0o600);
}

/** Parse an NDJSON bundle, validating the header kind + version. Throws on malformed input. */
export function parseBundle(text: string): ParsedBundle {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) throw new Error('Empty session bundle.');

  let header: BundleHeader;
  try {
    header = JSON.parse(lines[0]) as BundleHeader;
  } catch {
    throw new Error('Malformed session bundle: first line is not JSON.');
  }
  if (!header || header.kind !== BUNDLE_KIND) {
    throw new Error(`Not an agents session bundle (kind=${(header as { kind?: string } | null)?.kind ?? 'missing'}).`);
  }
  if (header.version !== BUNDLE_VERSION) {
    throw new Error(`Unsupported bundle version ${header.version} — this CLI reads v${BUNDLE_VERSION}.`);
  }

  const records: BundleRecord[] = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]) as BundleRecord);
    } catch {
      throw new Error(`Malformed session bundle: record on line ${i + 1} is not JSON.`);
    }
  }
  return { header, records };
}

/** Placement outcome for one record, computed against what is already on disk. */
export type ImportStatus = 'new' | 'dup' | 'conflict' | 'unknown';

export interface ImportPlanItem {
  record: BundleRecord;
  /** Absolute path the file lands at (empty for `unknown` agents). */
  targetPath: string;
  status: ImportStatus;
}

interface PlanImportOpts {
  /** Key to open encrypted record bodies (null → only plaintext bodies readable). */
  decryptKey: Buffer | null;
}

/**
 * Compute where each record lands and whether it duplicates / conflicts with an
 * existing file. Pure w.r.t. the filesystem it reads (no writes). Dedup is
 * byte-exact: a target that already holds an identical body is `dup`; a target
 * that holds a DIFFERENT body is `conflict` (only overwritten with --overwrite).
 * An agent with no sync spec is `unknown` and never placed.
 */
export function planImport(bundle: ParsedBundle, opts: PlanImportOpts): ImportPlanItem[] {
  return bundle.records.map((record): ImportPlanItem => {
    const spec = specForAgent(record.agent);
    if (!spec) return { record, targetPath: '', status: 'unknown' };

    const body = decryptTranscriptBody(record.body, opts.decryptKey);
    const bodyHash = hashContent(body);
    const targetPath = mirrorPath(spec, record.machine, record.relKey);

    let status: ImportStatus = 'new';
    if (fs.existsSync(targetPath)) {
      const existing = fs.readFileSync(targetPath, 'utf-8');
      status = hashContent(existing) === bodyHash ? 'dup' : 'conflict';
    }
    return { record, targetPath, status };
  });
}

export interface WriteResult {
  /** New files written. */
  placed: number;
  /** Byte-exact dups skipped. */
  skipped: number;
  /** Conflicts replaced (only with overwrite). */
  overwritten: number;
  /** Conflicts left in place (overwrite off). */
  conflicts: number;
  /** Records for agents with no sync spec. */
  unknown: number;
}

interface WriteImportOpts {
  overwrite: boolean;
  decryptKey: Buffer | null;
}

/**
 * Materialize a plan to disk. `dup` records are always skipped (local wins);
 * `conflict` records are replaced only when `overwrite` is set; `unknown` records
 * are counted and skipped.
 */
export function writeImport(plan: ImportPlanItem[], opts: WriteImportOpts): WriteResult {
  const res: WriteResult = { placed: 0, skipped: 0, overwritten: 0, conflicts: 0, unknown: 0 };
  for (const item of plan) {
    if (item.status === 'unknown') { res.unknown++; continue; }
    if (item.status === 'dup') { res.skipped++; continue; }
    if (item.status === 'conflict' && !opts.overwrite) { res.conflicts++; continue; }

    const body = decryptTranscriptBody(item.record.body, opts.decryptKey);
    fs.mkdirSync(path.dirname(item.targetPath), { recursive: true });
    fs.writeFileSync(item.targetPath, body, 'utf-8');
    if (item.status === 'conflict') res.overwritten++;
    else res.placed++;
  }
  return res;
}
