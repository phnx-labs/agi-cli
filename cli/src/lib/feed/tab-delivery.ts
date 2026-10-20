import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJsonSync } from '../fs-atomic.js';
import { getFeedDir } from '../state.js';

/**
 * Text waiting to be typed into a session's editor tab. The CLI cannot reach a VSCodium
 * tab (the agent may run on another machine than the editor), so it records the text on
 * the session's row and the one AGI EXT window that binds the session types it. The
 * agent's transcript moving past the hand-off is the receipt.
 */
export interface TabDelivery {
  id: string;
  sessionId: string;
  text: string;
  /** Submit after typing; false leaves the text in the prompt. */
  enter: boolean;
  at: string;
}

/** A window types a delivery only this long after it was written, so a late window never types an abandoned one. */
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

function transcriptTail(file: string, bytes = 256 * 1024): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** True once the transcript grew after the hand-off and, for typed text, holds it. */
function received(transcript: string, sinceMs: number, text: string): boolean {
  let stat: fs.Stats;
  try { stat = fs.statSync(transcript); } catch { return false; }
  if (stat.mtimeMs <= sinceMs) return false;
  const probe = text.trim().slice(0, 60);
  if (probe.length <= 1) return true;
  return transcriptTail(transcript).includes(JSON.stringify(probe).slice(1, -1));
}

export type TabDeliveryResult =
  | { delivered: true; id: string }
  | { delivered: false; id: string; reason: string };

/**
 * Record the text on the session's row, wait for the receipt, then clear it. On no
 * receipt the record is removed too, so nothing types it later.
 */
export async function deliverToTab(input: {
  sessionId: string;
  text: string;
  enter?: boolean;
  transcript?: string;
  root?: string;
  timeoutMs?: number;
}): Promise<TabDeliveryResult> {
  const at = new Date();
  const delivery: TabDelivery = {
    id: `tab-${input.sessionId.slice(0, 8)}-${at.getTime()}`,
    sessionId: input.sessionId,
    text: input.text,
    enter: input.enter !== false,
    at: at.toISOString(),
  };
  fs.mkdirSync(deliveryDir(input.root), { recursive: true });
  atomicWriteJsonSync(deliveryPath(input.sessionId, input.root), delivery);
  const deadline = at.getTime() + Math.min(input.timeoutMs ?? TAB_DELIVERY_TTL_MS, TAB_DELIVERY_TTL_MS);
  try {
    while (Date.now() < deadline) {
      if (input.transcript && received(input.transcript, at.getTime(), input.text)) {
        return { delivered: true, id: delivery.id };
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return {
      delivered: false,
      id: delivery.id,
      reason: input.transcript
        ? `No editor window holding this session's tab typed it within ${Math.round(TAB_DELIVERY_TTL_MS / 1000)} seconds.`
        : 'This session has no transcript to confirm the delivery.',
    };
  } finally {
    removeTabDelivery(delivery, input.root);
  }
}
