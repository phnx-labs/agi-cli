import fs from 'node:fs';
import path from 'node:path';
import { getFeedDir } from '../state.js';

export interface TabDelivery {
  id: string;
  sessionId: string;
  text: string;
  enter: boolean;
  at: string;
}

export const TAB_DELIVERY_TTL_MS = 15_000;
const POLL_MS = 250;

function deliveryDir(root?: string): string {
  return path.join(root ?? getFeedDir(), 'deliveries');
}

function deliveryPath(sessionId: string, root?: string): string {
  return path.join(deliveryDir(root), `${sessionId.replace(/[^A-Za-z0-9._-]/g, '-')}.json`);
}

export function tabDeliveryDir(root?: string): string {
  return deliveryDir(root);
}

export function readTabDelivery(sessionId: string, root?: string, nowMs: number = Date.now()): TabDelivery | undefined {
  try {
    const d = JSON.parse(fs.readFileSync(deliveryPath(sessionId, root), 'utf8')) as TabDelivery;
    if (!d || d.sessionId !== sessionId || typeof d.text !== 'string') return undefined;
    return nowMs - Date.parse(d.at) <= TAB_DELIVERY_TTL_MS ? d : undefined;
  } catch {
    return undefined;
  }
}

function removeTabDelivery(d: TabDelivery, root?: string): void {
  const current = readTabDelivery(d.sessionId, root, Number.NEGATIVE_INFINITY);
  if (current && current.id !== d.id) return;
  try { fs.unlinkSync(deliveryPath(d.sessionId, root)); } catch { }
}

function sizeOf(file: string | undefined): number {
  if (!file) return 0;
  try { return fs.statSync(file).size; } catch { return 0; }
}

function appendedSince(file: string, from: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= from) return '';
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function received(appended: string, text: string): boolean {
  if (!appended) return false;
  const probe = Array.from(text.trim()).slice(0, 60).join('');
  if (probe.length <= 1) return appended.includes('"tool_result"');
  return appended.includes(JSON.stringify(probe).slice(1, -1));
}

export type TabDeliveryResult =
  | { delivered: true; id: string }
  | { delivered: false; id: string; reason: string; touched: boolean };

export async function deliverToTab(input: {
  sessionId: string;
  text: string;
  enter?: boolean;
  transcript?: string;
  root?: string;
  timeoutMs?: number;
}): Promise<TabDeliveryResult> {
  if (!input.transcript) {
    return { delivered: false, id: '', touched: false, reason: 'This session has no transcript to confirm a delivery, so nothing was sent.' };
  }
  const at = new Date();
  const delivery: TabDelivery = {
    id: `tab-${input.sessionId.slice(0, 8)}-${at.getTime()}`,
    sessionId: input.sessionId,
    text: input.text,
    enter: input.enter !== false,
    at: at.toISOString(),
  };
  const from = sizeOf(input.transcript);
  fs.mkdirSync(deliveryDir(input.root), { recursive: true, mode: 0o700 });
  const file = deliveryPath(input.sessionId, input.root);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(delivery), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  const deadline = at.getTime() + Math.min(input.timeoutMs ?? TAB_DELIVERY_TTL_MS, TAB_DELIVERY_TTL_MS);
  try {
    while (Date.now() < deadline) {
      if (input.transcript && received(appendedSince(input.transcript, from), input.text)) {
        return { delivered: true, id: delivery.id };
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return {
      delivered: false,
      id: delivery.id,
      touched: sizeOf(input.transcript) > from,
      reason: `No editor window holding this session's tab typed it within ${Math.round(TAB_DELIVERY_TTL_MS / 1000)} seconds.`,
    };
  } finally {
    removeTabDelivery(delivery, input.root);
  }
}
