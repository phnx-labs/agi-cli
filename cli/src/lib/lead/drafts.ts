import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteJsonSync } from '../fs-atomic.js';
import { leadRoot } from './paths.js';

export interface LeadDraft {
  key: string;
  text?: string;
  choiceId?: string;
  label: string;
  project: string;
  at: string;
}

const DRAFT_TTL_MS = 24 * 60 * 60_000;

export function leadDraftsDir(): string {
  return path.join(leadRoot(), 'drafts');
}

function draftPath(key: string): string {
  return path.join(leadDraftsDir(), `${createHash('sha256').update(key).digest('hex').slice(0, 20)}.json`);
}

export function writeLeadDraft(draft: LeadDraft): void {
  fs.mkdirSync(leadDraftsDir(), { recursive: true, mode: 0o700 });
  atomicWriteJsonSync(draftPath(draft.key), draft);
  const cutoff = Date.now() - DRAFT_TTL_MS;
  for (const name of fs.readdirSync(leadDraftsDir())) {
    const file = path.join(leadDraftsDir(), name);
    try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch { }
  }
}

export function readLeadDraft(key: string): LeadDraft | undefined {
  try {
    const d = JSON.parse(fs.readFileSync(draftPath(key), 'utf8')) as LeadDraft;
    return d && d.key === key && typeof d.label === 'string' ? d : undefined;
  } catch {
    return undefined;
  }
}
