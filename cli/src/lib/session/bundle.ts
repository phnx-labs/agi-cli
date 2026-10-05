
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { SYNC_AGENTS, mirrorPath, type SyncAgentSpec } from './sync/agents.js';
import { redactSecrets } from '../redact.js';
import { encryptTranscript, decryptTranscriptBody } from './sync/transcript-crypto.js';

export const BUNDLE_KIND = 'agents-session-bundle';
const BUNDLE_VERSION = 1;

function hashContent(content: string | Uint8Array): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export interface BundleHeader {
  kind: typeof BUNDLE_KIND;
  version: number;
  exportedAt: string;
  origin: string;
  encrypted: boolean;
  redacted: boolean;
  count: number;
  sessions: number;
}

export interface BundleRecord {
  agent: string;
  machine: string;
  sessionId: string;
  relKey: string;
  size: number;
  hash: string;
  label?: string;
  encrypted: boolean;
  body: string;
}

export interface ParsedBundle {
  header: BundleHeader;
  records: BundleRecord[];
}

export interface FileToExport {
  agent: string;
  machine: string;
  sessionId: string;
  relKey: string;
  absPath: string;
  label?: string;
}

interface BuildRecordOpts {
  redact: boolean;
  encryptKey: Buffer | null;
  knownSecrets?: readonly string[];
}

export function specForAgent(agentId: string): SyncAgentSpec | undefined {
  return SYNC_AGENTS.find(s => s.id === agentId);
}

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

export function serializeBundle(header: BundleHeader, records: BundleRecord[]): string {
  const lines = [JSON.stringify(header)];
  for (const r of records) lines.push(JSON.stringify(r));
  return lines.join('\n') + '\n';
}

export function writeBundleFile(outPath: string, wire: string): void {

  fs.writeFileSync(outPath, wire, { encoding: 'utf-8', mode: 0o600 });
  fs.chmodSync(outPath, 0o600);
}

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

export type ImportStatus = 'new' | 'dup' | 'conflict' | 'unknown';

export interface ImportPlanItem {
  record: BundleRecord;
  targetPath: string;
  status: ImportStatus;
}

interface PlanImportOpts {
  decryptKey: Buffer | null;
}

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
  placed: number;
  skipped: number;
  overwritten: number;
  conflicts: number;
  unknown: number;
}

interface WriteImportOpts {
  overwrite: boolean;
  decryptKey: Buffer | null;
}

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
