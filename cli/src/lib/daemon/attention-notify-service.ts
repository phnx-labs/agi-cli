/**
 * Attention desktop banners as a supervised periodic service (PHNX-4004).
 *
 * Each tick reconciles this host's live sessions into attention items through
 * the CLI-owned reconciler (feed/attention.ts — never re-deriving detection) and
 * posts ONE actionable desktop banner per attention key not yet notified. The
 * banner carries the category, the attention key, the session id, and the
 * answerable choices, so the macOS companion can offer Approve / Approve for
 * session / Deny (permission), the options plus a typed reply (question),
 * Approve / Send back (plan review), or Open terminal (a stall/failure, or a
 * request the CLI could not verify is still pending), and route the answer back
 * through `agents feed answer <key> --choice <id>`. The kind — and so the button
 * set — is the reconciler's verdict from explicit harness evidence; an idle
 * reminder never reaches here as a permission (PHNX-3999).
 *
 * Idempotency is a filesystem ledger, not memory: one sidecar file per notified
 * key under `~/.agents/.history/feed/notified/`, so a daemon restart never
 * re-posts a banner already sent — the ledger is the truth. It is pruned with
 * the feed's 14-day retention rule.
 *
 * Reader-independent: unlike the session-state publisher this does NOT gate on a
 * live `sessions watch` reader — an attention banner must fire whether or not
 * anyone is watching the stream. `done` banners are deliberately NOT produced
 * here; they ride the run process's own exit (`run-notify.ts`).
 */

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteFile } from '../fs-atomic.js';
import { getFeedDir } from '../state.js';
import { machineId } from '../machine-id.js';
import { getActiveSessions, type ActiveSession } from '../session/active.js';
import { blockIdForSession, readBlock, readResolution } from '../feed/feed.js';
import { reconcileAttention, harnessOf, type AttentionItem, type AttentionKind } from '../feed/attention.js';
import { notifyDesktop, type DesktopNotification } from '../menubar/notify-desktop.js';
import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';

const ATTENTION_NOTIFY_TICK_MS = 5_000;
const ATTENTION_NOTIFY_DEADLINE_MS = 10_000;
/** Feed retention: a notified-ledger sidecar older than this is pruned. */
const LEDGER_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** Prune the ledger at most this often — the dir is tiny, but a dir walk every 5s is waste. */
const LEDGER_PRUNE_EVERY_MS = 60 * 60 * 1000;
/** UNUserNotificationCenter caps action buttons; the argv contract is ≤ 6 choices. */
const MAX_CHOICES = 6;
/** Body cap — a banner truncates anyway, and a wall of text is noise. */
const BODY_MAX = 200;

/** Which attention kinds produce a banner, and the category + title verb each carries. */
const BANNER_KINDS: Partial<Record<AttentionKind, { category: NonNullable<DesktopNotification['category']>; label: string }>> = {
  permission: { category: 'permission', label: 'Command approval' },
  question: { category: 'question', label: 'Question' },
  plan_review: { category: 'plan_review', label: 'Plan review' },
  stall: { category: 'failure', label: 'Failed' },
  failure: { category: 'failure', label: 'Failed' },
  // A request record the CLI could not confirm is still pending: the `failure`
  // category is the companion's one button set with no approval action — just
  // Open terminal — which is exactly the honest offer here.
  unverified: { category: 'failure', label: 'Could not verify request' },
};

function shorten(text: string, max = BODY_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The banner for one attention item, or `undefined` when its kind does not
 * notify (`done` comes from the run process; `declared`/`review` are surfaced in
 * the feed, not as a native banner). Pure — the service and its test both build
 * through here, so what ships is what is asserted.
 */
export function buildAttentionNotification(item: AttentionItem, session: ActiveSession): DesktopNotification | undefined {
  const spec = BANNER_KINDS[item.kind];
  if (!spec) return undefined;
  const shortId = item.sessionId ? item.sessionId.slice(0, 8) : 'session';
  const who = session.label?.trim() || session.title?.trim() || shortId;
  const n: DesktopNotification = {
    title: `${who} · ${spec.label}`,
    body: shorten(item.question?.text?.trim() || spec.label),
    category: spec.category,
    key: item.key,
  };
  const agent = harnessOf(session);
  if (agent) n.agent = agent;
  if (item.sessionId) n.sessionId = item.sessionId;
  const subtitle = [item.host, item.project].filter(Boolean).join(' · ');
  if (subtitle) n.subtitle = subtitle;
  // A stall/failure has no answerable option list — it offers one button that
  // opens the session's terminal. Everything else carries the reconciled choices.
  const choices =
    spec.category === 'failure'
      ? [{ id: 'open-terminal', label: 'Open terminal' }]
      : (item.choices ?? []).slice(0, MAX_CHOICES).map((c) => ({ id: c.id, label: c.label }));
  if (choices.length) n.choices = choices;
  return n;
}

export interface AttentionNotifyServiceOptions {
  /** Live-session source (default: the real active-session query). Injected in tests. */
  getSessions?: () => Promise<ActiveSession[]>;
  /** Notifier (default: the real desktop notifier). Injected in tests to capture posts. */
  notify?: (n: DesktopNotification) => void;
  /** Feed store root (default: the real feed dir). Overridden in tests. */
  feedRoot?: string;
  /** Notified-ledger dir (default: `<feedRoot>/notified`). Overridden in tests. */
  ledgerDir?: string;
  /** Clock (default: `Date.now`). Injected in tests. */
  now?: () => number;
}

export class AttentionNotifyService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'attention-notify';
  readonly intervalMs = ATTENTION_NOTIFY_TICK_MS;
  readonly deadlineMs = ATTENTION_NOTIFY_DEADLINE_MS;

  private readonly getSessions: () => Promise<ActiveSession[]>;
  private readonly notify: (n: DesktopNotification) => void;
  private readonly feedRoot?: string;
  private readonly ledgerDir: string;
  private readonly now: () => number;
  private lastPruneMs = 0;

  constructor(opts: AttentionNotifyServiceOptions = {}) {
    super();
    this.getSessions = opts.getSessions ?? (() => getActiveSessions());
    this.notify = opts.notify ?? notifyDesktop;
    this.feedRoot = opts.feedRoot;
    this.ledgerDir = opts.ledgerDir ?? path.join(opts.feedRoot ?? getFeedDir(), 'notified');
    this.now = opts.now ?? Date.now;
  }

  protected async onStart(_ctx: DaemonContext): Promise<void> {
    // No handles to open — each tick re-reads sessions and the ledger.
  }

  protected async onStop(): Promise<void> {
    // Nothing to release — the supervisor's timer teardown is the only cleanup.
  }

  protected async onTick(ctx: DaemonContext): Promise<void> {
    const sessions = await this.getSessions();
    const host = machineId();
    for (const session of sessions) {
      if (!session.sessionId) continue;
      // ActiveSession.host names the terminal app; the reconciler's host is the
      // device scope, so the attention key is fleet-routable (mirrors watch.ts).
      const projected: ActiveSession = { ...session, host };
      const blockId = blockIdForSession(session.sessionId);
      const item = reconcileAttention({
        block: readBlock(blockId, this.feedRoot),
        session: projected,
        resolution: readResolution(blockId, this.feedRoot),
        nowMs: this.now(),
      });
      if (!item || !BANNER_KINDS[item.kind]) continue;
      if (await this.hasNotified(item.key)) continue;
      const notification = buildAttentionNotification(item, projected);
      if (!notification) continue;
      this.notify(notification);
      await this.markNotified(item.key);
      ctx.log('INFO', `attention-notify: posted ${item.kind} banner for ${item.key}`);
    }
    await this.pruneLedger();
  }

  /** Filesystem-safe sidecar name for an attention key (`host/session/generation`). */
  private ledgerPath(key: string): string {
    return path.join(this.ledgerDir, encodeURIComponent(key));
  }

  private async hasNotified(key: string): Promise<boolean> {
    // fs/promises has no existsSync; a stat that rejects with ENOENT is the miss.
    try {
      await fs.promises.stat(this.ledgerPath(key));
      return true;
    } catch {
      return false;
    }
  }

  private async markNotified(key: string): Promise<void> {
    await fs.promises.mkdir(this.ledgerDir, { recursive: true });
    await atomicWriteFile(this.ledgerPath(key), JSON.stringify({ key, postedAt: new Date(this.now()).toISOString() }), 'utf-8');
  }

  private async pruneLedger(): Promise<void> {
    const nowMs = this.now();
    if (nowMs - this.lastPruneMs < LEDGER_PRUNE_EVERY_MS) return;
    this.lastPruneMs = nowMs;
    let names: string[];
    try {
      names = await fs.promises.readdir(this.ledgerDir);
    } catch {
      return; // No ledger dir yet — nothing to prune.
    }
    for (const name of names) {
      const filePath = path.join(this.ledgerDir, name);
      try {
        const stat = await fs.promises.stat(filePath);
        if (nowMs - stat.mtimeMs > LEDGER_RETENTION_MS) await fs.promises.rm(filePath, { force: true });
      } catch {
        // A file that vanished mid-walk is already gone; skip it.
      }
    }
  }
}
