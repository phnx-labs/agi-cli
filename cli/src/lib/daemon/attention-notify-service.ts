/**
 * Attention desktop banners (PHNX-4004, PHNX-4369). Each tick takes the open asks
 * from the CLI-owned reconciler (feed/attention.ts) and drives each banner along
 * its urgency level's schedule (`menubar.menu.notify*`): first banner, reminders
 * (same identifier, so they replace it), withdraw on resolve, and withdraw ~10 s
 * after posting when the level has no `stay` (macOS alert style is app-wide).
 * `interactive.host` unset: this host's asks; this machine: every host's, from
 * the shared fleet collector; another machine: none. The ledger under
 * `feed/notified/` (`<key>`, `<key>#r<n>`) makes a restart re-send nothing.
 * `done` banners ride the run process's exit (`run-notify.ts`), not this service.
 */

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteFile } from '../fs-atomic.js';
import { getFeedDir } from '../state.js';
import { machineId, normalizeHost } from '../machine-id.js';
import { getConfigValue } from '../device-config.js';
import { getActiveSessions, type ActiveSession } from '../session/active.js';
import { mailboxIdForActiveSession } from '../mailbox-target.js';
import { gcMailbox } from '../mailbox-gc.js';
import { blockIdForSession, readBlock, readResolution } from '../feed/feed.js';
import { reconcileAttention, harnessOf, type AttentionItem, type AttentionKind, type AttentionUrgency } from '../feed/attention.js';
import { cachedTicketPriority } from '../feed/ticket-priority.js';
import { sharedFleetFeedHub } from '../feed/watch.js';
import type { FeedHub } from '../feed/hub.js';
import {
  DEFAULT_NOTIFY_SCHEDULES,
  NOTIFY_LEVELS,
  NOTIFY_LEVEL_KEYS,
  formatWaited,
  parseNotifySchedule,
  type NotifySchedule,
} from '../feed/notify-schedule.js';
import { notifyDesktop, withdrawDesktop, type DesktopNotification } from '../menubar/notify-desktop.js';
import { BasePeriodicService, type DaemonContext } from './service.js';
import { span, spanSync } from './diagnostics.js';
import type { DaemonServiceId } from '../daemon-services.js';

const ATTENTION_NOTIFY_TICK_MS = 5_000;
const ATTENTION_NOTIFY_DEADLINE_MS = 10_000;
const LEDGER_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const HOURLY_MS = 60 * 60 * 1000;
const SETTINGS_TTL_MS = 30_000;
export const BANNER_HIDE_AFTER_MS = 10_000;
const MAX_CHOICES = 6;
const BODY_MAX = 200;

const BANNER_KINDS: Partial<Record<AttentionKind, { category: NonNullable<DesktopNotification['category']>; label: string }>> = {
  permission: { category: 'permission', label: 'Command approval' },
  question: { category: 'question', label: 'Question' },
  plan_review: { category: 'plan_review', label: 'Plan review' },
  stall: { category: 'failure', label: 'Failed' },
  failure: { category: 'failure', label: 'Failed' },
  unverified: { category: 'failure', label: 'Could not verify request' },
};

type BannerSession = Partial<Pick<ActiveSession, 'label' | 'title' | 'harness' | 'kind'>>;

export interface AttentionAsk {
  item: AttentionItem;
  session: BannerSession;
}

export type NotifyScope = 'local' | 'fleet' | 'none';

export interface AttentionNotifySettings {
  interactiveHost?: string;
  schedules: Record<AttentionUrgency, NotifySchedule>;
}

function shorten(text: string, max = BODY_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function buildAttentionNotification(item: AttentionItem, session: BannerSession): DesktopNotification | undefined {
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
  const choices =
    spec.category === 'failure'
      ? [{ id: 'open-terminal', label: 'Open terminal' }]
      : (item.choices ?? []).slice(0, MAX_CHOICES).map((c) => ({ id: c.id, label: c.label }));
  if (choices.length) n.choices = choices;
  return n;
}

export function notifyScope(interactiveHost: string | undefined, self: string): NotifyScope {
  if (!interactiveHost?.trim()) return 'local';
  return normalizeHost(interactiveHost) === normalizeHost(self) ? 'fleet' : 'none';
}

export function readAttentionNotifySettings(): AttentionNotifySettings {
  const schedules = {} as Record<AttentionUrgency, NotifySchedule>;
  for (const level of NOTIFY_LEVELS) {
    const stored = getConfigValue(NOTIFY_LEVEL_KEYS[level]).value;
    const parsed = parseNotifySchedule(Array.isArray(stored) ? stored.map(String) : DEFAULT_NOTIFY_SCHEDULES[level]);
    // A hand-edited agents.yaml can hold what `config set` refuses; the level then keeps its default.
    schedules[level] = typeof parsed === 'string' ? parseNotifySchedule(DEFAULT_NOTIFY_SCHEDULES[level]) as NotifySchedule : parsed;
  }
  const host = getConfigValue('interactive.host').value;
  return { interactiveHost: typeof host === 'string' ? host : undefined, schedules };
}

export function dueStage(schedule: NotifySchedule, openedMs: number, nowMs: number): number {
  if (schedule.sidebar) return -1;
  let stage = -1;
  schedule.atMs.forEach((at, i) => { if (openedMs + at <= nowMs) stage = i; });
  return stage;
}

interface BannerState {
  key: string;
  postedAt: string;
  level: AttentionUrgency;
  stage: number;
  bannerUp: boolean;
  hideAt?: number;
  resolvedAt?: string;
}

interface AttentionNotifyServiceOptions {
  getSessions?: () => Promise<ActiveSession[]>;
  notify?: (n: DesktopNotification) => void;
  withdraw?: (keys: string[]) => void;
  fleetHub?: () => FeedHub;
  settings?: () => AttentionNotifySettings;
  self?: () => string;
  gc?: (activeBoxIds: Set<string>) => void;
  feedRoot?: string;
  ledgerDir?: string;
  now?: () => number;
}

export class AttentionNotifyService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'attention-notify';
  readonly intervalMs = ATTENTION_NOTIFY_TICK_MS;
  readonly deadlineMs = ATTENTION_NOTIFY_DEADLINE_MS;

  private readonly getSessions: () => Promise<ActiveSession[]>;
  private readonly notify: (n: DesktopNotification) => void;
  private readonly withdraw: (keys: string[]) => void;
  private readonly fleetHubOf: () => FeedHub;
  private readonly readSettings: () => AttentionNotifySettings;
  private readonly self: () => string;
  private readonly gc: (activeBoxIds: Set<string>) => void;
  private readonly feedRoot?: string;
  private readonly ledgerDir: string;
  private readonly now: () => number;
  private lastHourlyMs = 0;
  private gcScan: Promise<void> | null = null;
  private settingsCache?: { at: number; value: AttentionNotifySettings };
  private banners: Map<string, BannerState> | null = null;
  private fleetHub: FeedHub | null = null;
  private detachFleet: (() => void) | null = null;

  constructor(opts: AttentionNotifyServiceOptions = {}) {
    super();
    this.getSessions = opts.getSessions ?? (() => getActiveSessions());
    this.notify = opts.notify ?? notifyDesktop;
    this.withdraw = opts.withdraw ?? withdrawDesktop;
    this.fleetHubOf = opts.fleetHub ?? sharedFleetFeedHub;
    this.readSettings = opts.settings ?? readAttentionNotifySettings;
    this.self = opts.self ?? machineId;
    this.feedRoot = opts.feedRoot;
    this.gc = opts.gc ?? ((ids) => { gcMailbox(ids, { feedRoot: this.feedRoot }); });
    this.ledgerDir = opts.ledgerDir ?? path.join(opts.feedRoot ?? getFeedDir(), 'notified');
    this.now = opts.now ?? Date.now;
  }

  protected async onStart(_ctx: DaemonContext): Promise<void> {
    this.lastHourlyMs = this.now();
  }

  protected async onStop(): Promise<void> {
    this.releaseFleet();
  }

  protected async onTick(ctx: DaemonContext): Promise<void> {
    const nowMs = this.now();
    const settings = this.settings(nowMs);
    const scope = notifyScope(settings.interactiveHost, this.self());
    if (scope !== 'fleet') this.releaseFleet();
    const local = scope === 'local' ? await this.localAsks(nowMs) : undefined;
    const { asks, scopes } = local
      ? { asks: local.asks, scopes: null }
      : scope === 'fleet'
        ? this.fleetAsks()
        : { asks: [], scopes: null };
    const banners = await this.loadBanners();

    const toWithdraw: string[] = [];
    const seen = new Set<string>();
    let posted = 0;
    for (const { item, session } of asks) {
      if (!BANNER_KINDS[item.kind]) continue;
      seen.add(item.key);
      const level = item.urgency ?? 'normal';
      const schedule = settings.schedules[level];
      if (schedule.sidebar) continue;
      const opened = Date.parse(item.openedAt);
      const openedMs = Number.isFinite(opened) ? opened : nowMs;
      const stage = dueStage(schedule, openedMs, nowMs);
      if (stage < 0 || await this.stageSent(item.key, stage, banners)) continue;
      const notification = buildAttentionNotification(item, session);
      if (!notification) continue;
      notification.level = level;
      if (schedule.sound) notification.sound = true;
      if (stage > 0) {
        notification.reminder = stage;
        notification.subtitle = [notification.subtitle, `Still waiting · ${formatWaited(nowMs - openedMs)}`].filter(Boolean).join(' · ');
      }
      this.notify(notification);
      await this.recordStage(banners, {
        key: item.key,
        postedAt: new Date(nowMs).toISOString(),
        level,
        stage,
        bannerUp: true,
        ...(schedule.stay ? {} : { hideAt: nowMs + BANNER_HIDE_AFTER_MS }),
      });
      posted += 1;
      ctx.log('INFO', `attention-notify: posted ${level} ${item.kind} banner for ${item.key}${stage ? ` (reminder ${stage})` : ''}`, { event: 'attention.posted', kind: item.kind, key: item.key, level, reminder: stage });
    }

    for (const state of banners.values()) {
      const resolved = !seen.has(state.key) && (scopes === null || scopes.has(state.key.split('/')[0]));
      if (resolved) {
        if (state.bannerUp) toWithdraw.push(state.key);
        banners.delete(state.key);
        await this.writeState({ ...state, bannerUp: false, resolvedAt: new Date(nowMs).toISOString() });
      } else if (state.bannerUp && state.hideAt !== undefined && nowMs >= state.hideAt) {
        toWithdraw.push(state.key);
        state.bannerUp = false;
        delete state.hideAt;
        await this.writeState(state);
      }
    }
    if (toWithdraw.length) {
      this.withdraw(toWithdraw);
      ctx.log('INFO', `attention-notify: withdrew ${toWithdraw.length} banner(s)`, { event: 'attention.withdrawn', keys: toWithdraw });
    }

    await this.hourly(ctx, nowMs, local?.sessions);
    ctx.log('DEBUG', `attention-notify: ${asks.length} ask(s) in ${scope} scope, ${posted} banner(s) posted`, { event: 'attention.tick', scope, asks: asks.length, posted });
  }

  private settings(nowMs: number): AttentionNotifySettings {
    if (!this.settingsCache || nowMs - this.settingsCache.at >= SETTINGS_TTL_MS || nowMs < this.settingsCache.at) {
      this.settingsCache = { at: nowMs, value: this.readSettings() };
    }
    return this.settingsCache.value;
  }

  private async localAsks(nowMs: number): Promise<{ asks: AttentionAsk[]; sessions: ActiveSession[] }> {
    const sessions = await span('attention.sessions', () => this.getSessions(), () => ({}));
    const host = normalizeHost(this.self());
    const asks: AttentionAsk[] = [];
    for (const session of sessions) {
      if (!session.sessionId) continue;
      const projected: ActiveSession = { ...session, host };
      const blockId = blockIdForSession(session.sessionId);
      const item = spanSync('attention.reconcile', () => reconcileAttention({
        block: readBlock(blockId, this.feedRoot),
        session: projected,
        resolution: readResolution(blockId, this.feedRoot),
        ticketPriority: (ticketId) => cachedTicketPriority(ticketId, nowMs),
        nowMs,
      }));
      if (item) asks.push({ item, session: projected });
    }
    return { asks, sessions };
  }

  private fleetAsks(): { asks: AttentionAsk[]; scopes: Set<string> } {
    const hub = this.fleetHubOf();
    // The feed-stream service closes the shared hub when it stops; re-attach rather than read a dead stream.
    if (this.fleetHub !== hub || !this.detachFleet || !hub.active) {
      this.releaseFleet();
      this.fleetHub = hub;
      this.detachFleet = hub.subscribe(() => {});
    }
    const asks = hub.state.attention().map(({ item, agent }) => ({
      item: item.urgency ? item : { ...item, urgency: 'normal' as const },
      session: agent ?? {},
    }));
    return { asks, scopes: hub.state.reportingScopes };
  }

  private releaseFleet(): void {
    this.detachFleet?.();
    this.detachFleet = null;
    this.fleetHub = null;
  }

  private ledgerPath(key: string, stage = 0): string {
    return path.join(this.ledgerDir, encodeURIComponent(stage ? `${key}#r${stage}` : key));
  }

  private async loadBanners(): Promise<Map<string, BannerState>> {
    if (this.banners) return this.banners;
    const banners = new Map<string, BannerState>();
    let names: string[] = [];
    try {
      names = await fs.promises.readdir(this.ledgerDir);
    } catch {
    }
    for (const name of names) {
      if (name.includes('%23r')) continue;
      try {
        const state = JSON.parse(await fs.promises.readFile(path.join(this.ledgerDir, name), 'utf-8')) as Partial<BannerState>;
        if (state.key && state.level && typeof state.stage === 'number' && !state.resolvedAt) banners.set(state.key, state as BannerState);
      } catch {
      }
    }
    this.banners = banners;
    return banners;
  }

  private async stageSent(key: string, stage: number, banners: Map<string, BannerState>): Promise<boolean> {
    const known = banners.get(key);
    if (known && known.stage >= stage) return true;
    try {
      await fs.promises.stat(this.ledgerPath(key, stage));
      return true;
    } catch {
      return false;
    }
  }

  private async recordStage(banners: Map<string, BannerState>, state: BannerState): Promise<void> {
    banners.set(state.key, state);
    await this.writeState(state);
    for (let reminder = 1; reminder <= state.stage; reminder += 1) {
      await atomicWriteFile(this.ledgerPath(state.key, reminder), JSON.stringify({ key: state.key, reminder, postedAt: state.postedAt }), 'utf-8');
    }
  }

  private async writeState(state: BannerState): Promise<void> {
    await fs.promises.mkdir(this.ledgerDir, { recursive: true });
    await atomicWriteFile(this.ledgerPath(state.key), JSON.stringify(state), 'utf-8');
  }

  private async hourly(ctx: DaemonContext, nowMs: number, fetched?: ActiveSession[]): Promise<void> {
    if (nowMs - this.lastHourlyMs < HOURLY_MS) return;
    this.lastHourlyMs = nowMs;
    await this.pruneLedger(nowMs);
    if (fetched) {
      this.sweep(ctx, fetched);
      return;
    }
    if (this.gcScan) return;
    this.gcScan = this.getSessions()
      .then((sessions) => this.sweep(ctx, sessions))
      .catch((err: Error) => ctx.log('WARN', `attention-notify: mailbox gc skipped: ${err.message}`, { event: 'attention.gc.failed' }))
      .finally(() => { this.gcScan = null; });
  }

  private sweep(ctx: DaemonContext, sessions: ActiveSession[]): void {
    try {
      const active = new Set(sessions.map(mailboxIdForActiveSession).filter((id): id is string => !!id));
      spanSync('attention.gc', () => this.gc(active));
    } catch (err) {
      ctx.log('WARN', `attention-notify: mailbox gc skipped: ${(err as Error).message}`, { event: 'attention.gc.failed' });
    }
  }

  private async pruneLedger(nowMs: number): Promise<void> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.ledgerDir);
    } catch {
      return;
    }
    for (const name of names) {
      const filePath = path.join(this.ledgerDir, name);
      try {
        const stat = await fs.promises.stat(filePath);
        if (nowMs - stat.mtimeMs > LEDGER_RETENTION_MS) await fs.promises.rm(filePath, { force: true });
      } catch {
      }
    }
  }
}
