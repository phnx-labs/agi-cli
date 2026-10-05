import * as fs from 'fs';
import * as path from 'path';
import { getFeedDir, getMailboxRootDir } from './state.js';
import {
  mailboxDir,
  isValidMailboxId,
  readMessage,
  sweepExpired,
} from './mailbox.js';
import { listBlocks, removeBlock, recordMessageReceipt } from './feed/feed.js';
import { atomicWriteJsonSync } from './fs-atomic.js';

export interface GcResult {
  boxesScanned: number;
  deadBoxes: number;
  messagesDroppedExpired: number;
  messagesDroppedDead: number;
  consumedPruned: number;
  blocksRemoved: number;
}

interface GcOptions {
  root?: string;
  feedRoot?: string;
  now?: Date;
  maxConsumedAgeMinutes?: number;
}

const DEFAULT_MAX_CONSUMED_AGE_MINUTES = 24 * 60;

function consumedAgeMinutes(file: string, now: Date): number {
  try {
    const stat = fs.statSync(file);
    return (now.getTime() - stat.mtimeMs) / 60_000;
  } catch {
    return 0;
  }
}

function jsonFiles(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith('.json')).sort();
}

function archiveAllPending(boxDir: string, reason: string, feedRoot?: string): number {
  let n = 0;
  for (const dir of [path.join(boxDir, 'inbox'), path.join(boxDir, 'processing')]) {
    for (const name of jsonFiles(dir)) {
      const src = path.join(dir, name);
      const dest = path.join(boxDir, 'consumed', name);
      try {
        const msg = readMessage(src);
        if (msg) {
          msg.dropped = reason;
          atomicWriteJsonSync(dest, msg);
          fs.unlinkSync(src);
          if (msg.blockId) {
            try {
              recordMessageReceipt(
                msg.blockId,
                { msgId: msg.msgId, status: reason === 'expired' ? 'expired' : 'dropped', at: new Date().toISOString(), from: msg.from },
                feedRoot,
              );
            } catch {
            }
          }
        } else {
          fs.renameSync(src, dest);
        }
        n++;
      } catch {
      }
    }
  }
  return n;
}

function blockAgeMinutes(blockId: string, feedRoot: string | undefined, now: Date): number {
  const file = path.join(feedRoot ?? getFeedDir(), `${blockId}.json`);
  try {
    const stat = fs.statSync(file);
    return (now.getTime() - stat.mtimeMs) / 60_000;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function pruneConsumed(boxDir: string, maxAgeMinutes: number, now: Date): number {
  let n = 0;
  const consumed = path.join(boxDir, 'consumed');
  for (const name of jsonFiles(consumed)) {
    const file = path.join(consumed, name);
    if (consumedAgeMinutes(file, now) >= maxAgeMinutes) {
      try {
        fs.unlinkSync(file);
        n++;
      } catch {
      }
    }
  }
  return n;
}

export function gcMailbox(
  activeBoxIds: Set<string>,
  options: GcOptions = {},
): GcResult {

  const root = options.root ?? getMailboxRootDir();
  const feedRoot = options.feedRoot;
  const now = options.now ?? new Date();
  const maxConsumedAgeMinutes = options.maxConsumedAgeMinutes ?? DEFAULT_MAX_CONSUMED_AGE_MINUTES;

  const result: GcResult = {
    boxesScanned: 0,
    deadBoxes: 0,
    messagesDroppedExpired: 0,
    messagesDroppedDead: 0,
    consumedPruned: 0,
    blocksRemoved: 0,
  };

  let boxNames: string[];
  try {
    boxNames = fs.readdirSync(root);
  } catch {
    return result;
  }

  const blocksToRemove = new Set<string>();
  for (const block of listBlocks(feedRoot)) {
    if (!activeBoxIds.has(block.mailboxId)) {
      blocksToRemove.add(block.blockId);
    }
  }

  for (const name of boxNames) {
    if (!isValidMailboxId(name)) continue;
    result.boxesScanned++;
    const boxDir = mailboxDir(name, root);

    if (!activeBoxIds.has(name)) {
      result.deadBoxes++;
      result.messagesDroppedDead += archiveAllPending(boxDir, 'dead', feedRoot);
      result.consumedPruned += pruneConsumed(boxDir, maxConsumedAgeMinutes, now);
      try {
        for (const sub of ['inbox', 'processing', 'consumed']) {
          const subdir = path.join(boxDir, sub);
          if (fs.existsSync(subdir) && fs.readdirSync(subdir).length === 0) {
            fs.rmdirSync(subdir);
          }
        }
        if (fs.existsSync(boxDir) && fs.readdirSync(boxDir).length === 0) {
          fs.rmdirSync(boxDir);
        }
      } catch {
      }
    } else {
      result.messagesDroppedExpired += sweepExpired(boxDir, name, now, feedRoot);
      result.consumedPruned += pruneConsumed(boxDir, maxConsumedAgeMinutes, now);
    }
  }

  for (const blockId of blocksToRemove) {
    if (blockAgeMinutes(blockId, feedRoot, now) >= maxConsumedAgeMinutes) {
      if (removeBlock(blockId, feedRoot)) {
        result.blocksRemoved++;
      }
    }
  }

  return result;
}
