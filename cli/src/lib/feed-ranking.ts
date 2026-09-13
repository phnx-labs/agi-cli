import type { OpenBlock, FeedAskStats } from './feed/feed.js';
import type { Classification } from './ask-classifier.js';
import { classifyBlock } from './ask-classifier.js';
import { outcomeForBlock } from './feed-outcome.js';
import type { ActiveSession } from './session/active.js';
import type { SessionMeta } from './session/types.js';
import { projectKeyFromCwd } from './project-key.js';

const MINUTES_PER_HOUR = 60;
const NEEDY_ASKS_PER_HOUR = 6;
const RUNAWAY_TOK_PER_SEC = 250;
const RUNAWAY_BURN_USD_PER_HOUR = 25;
const RELAUNCH_LOOP_COUNT = 3;
const RELAUNCH_LOOP_WINDOW_MS = 10 * 60_000;

export interface FeedSessionSignal {
  sessionId?: string;
  mailboxId?: string;
  kind?: string;
  host?: string;
  context?: ActiveSession['context'];
  runtime?: string;
  pid?: number;
  cwd?: string;
  project?: string;
  startedAtMs?: number;
  status?: ActiveSession['status'];
  tokPerSec?: number;
  costUsd?: number;
  durationMs?: number;
  cloudProvider?: string;
  cloudTaskId?: string;
}

interface RankedFeedBlock extends OpenBlock {
  delayRank: NonNullable<OpenBlock['delayRank']>;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function signalKey(signal: FeedSessionSignal): string[] {
  return [signal.mailboxId, signal.sessionId, signal.cloudTaskId].filter((v): v is string => !!v);
}

export function buildSessionSignals(
  active: ActiveSession[],
  metas: SessionMeta[] = [],
): FeedSessionSignal[] {
  const metaById = new Map(metas.map((m) => [m.id, m]));
  return active.map((s) => {
    const sessionId = s.sessionId;
    const meta = sessionId ? metaById.get(sessionId) : undefined;
    return {
      sessionId,
      mailboxId: s.agentId ?? s.sessionId ?? s.cloudTaskId,
      kind: s.kind,
      host: s.machine ?? s.provenance?.host ?? s.host,
      context: s.context,
      runtime: s.context,
      pid: s.pid,
      cwd: s.cwd,
      project: s.project ?? projectKeyFromCwd(s.cwd),
      startedAtMs: s.startedAtMs,
      status: s.status,
      tokPerSec: s.tokPerSec,
      costUsd: meta?.costUsd,
      durationMs: meta?.durationMs,
      cloudProvider: s.cloudProvider,
      cloudTaskId: s.cloudTaskId,
    };
  });
}

function indexSignals(signals: FeedSessionSignal[]): Map<string, FeedSessionSignal> {
  const out = new Map<string, FeedSessionSignal>();
  for (const signal of signals) {
    for (const key of signalKey(signal)) {
      if (!out.has(key)) out.set(key, signal);
    }
  }
  return out;
}

function signalForBlock(block: OpenBlock, signals: Map<string, FeedSessionSignal>): FeedSessionSignal | undefined {
  return signals.get(block.mailboxId) ?? signals.get(block.sessionId);
}

export function decisionIrreducibility(c: Classification): number {
  switch (c.class) {
    case 'decision': return 1;
    case 'approval': return 0.8;
    case 'clarification': return 0.6;
    case 'stall':
    case 'fyi':
      return 0;
  }
}

function fallbackBurnRate(block: OpenBlock): number {
  switch (block.costOfDelay) {
    case 'high': return 10;
    case 'medium': return 3;
    case 'low': return 1;
    default: return 1;
  }
}

export function burnUsdPerHour(signal: FeedSessionSignal | undefined, block: OpenBlock): number {
  const cost = finiteNumber(signal?.costUsd);
  const duration = finiteNumber(signal?.durationMs);
  if (cost !== undefined && duration !== undefined && duration > 0) {
    return cost / (duration / 3_600_000);
  }
  const existing = finiteNumber(block.delayRank?.burnUsdPerHour);
  if (existing !== undefined) return existing;
  return fallbackBurnRate(block);
}

function idleMinutes(block: OpenBlock, nowMs: number): number {
  const ts = Date.parse(block.ts);
  if (!Number.isFinite(ts)) return 0;
  return Math.max(0, (nowMs - ts) / 60_000);
}

function blastRadii(blocks: OpenBlock[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const block of blocks) {
    const key = outcomeForBlock(block).key;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out = new Map<string, number>();
  for (const block of blocks) {
    out.set(block.blockId, Math.max(1, finiteNumber(block.downstreamAgents) ?? counts.get(outcomeForBlock(block).key) ?? 1));
  }
  return out;
}

export function rankFeedBlocks(
  blocks: OpenBlock[],
  signals: FeedSessionSignal[] = [],
  now: Date = new Date(),
): RankedFeedBlock[] {
  const bySignal = indexSignals(signals);
  const radii = blastRadii(blocks);
  const nowMs = now.getTime();
  return blocks
    .map((block): RankedFeedBlock => {
      const c = classifyBlock(block);
      const idle = idleMinutes(block, nowMs);
      const blastRadius = radii.get(block.blockId) ?? 1;
      const burn = burnUsdPerHour(signalForBlock(block, bySignal), block);
      const irreducible = finiteNumber(block.delayRank?.decisionIrreducibility) ?? decisionIrreducibility(c);
      const score = idle * blastRadius * burn * irreducible;
      return {
        ...block,
        delayRank: {
          score,
          idleMinutes: idle,
          blastRadius,
          burnUsdPerHour: burn,
          decisionIrreducibility: irreducible,
        },
      };
    })
    .sort((a, b) => {
      if (b.delayRank.score !== a.delayRank.score) return b.delayRank.score - a.delayRank.score;
      return Date.parse(a.ts) - Date.parse(b.ts);
    });
}

function recentAskCount(stats: FeedAskStats, now: Date = new Date()): number {
  const cutoff = now.getTime() - 60 * 60_000;
  return stats.recentAskTimestamps.filter((ts) => {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) && parsed >= cutoff;
  }).length;
}

export function needyControlCards(
  stats: FeedAskStats[],
  signals: FeedSessionSignal[] = [],
  now: Date = new Date(),
  threshold = NEEDY_ASKS_PER_HOUR,
): OpenBlock[] {
  const bySignal = indexSignals(signals);
  const cards: OpenBlock[] = [];
  for (const row of stats) {
    const count = recentAskCount(row, now);
    if (count < threshold) continue;
    const signal = bySignal.get(row.mailboxId) ?? bySignal.get(row.sessionId);
    cards.push({
      blockId: `control-needy-${row.sessionId.replace(/[^A-Za-z0-9._-]/g, '-')}`,
      sessionId: row.sessionId,
      mailboxId: row.mailboxId,
      host: signal?.host ?? 'local',
      runtime: signal?.runtime ?? signal?.context ?? 'unknown',
      project: signal?.project,
      ts: row.lastAskAt,
      kind: 'control',
      questions: [{
        header: 'Needy agent',
        text: `${row.mailboxId} asked ${count} times in the last hour. Inspect the session; this is likely a loop bug, not ${count} separate decisions.`,
      }],
      needy: {
        askCountLastHour: count,
        threshold,
        totalAskCount: row.totalAskCount,
      },
    });
  }
  return cards;
}

function relaunchLoopCount(signal: FeedSessionSignal, signals: FeedSessionSignal[], nowMs: number): number {
  if (!signal.cwd || !signal.kind || !signal.startedAtMs) return 0;
  return signals.filter((candidate) =>
    candidate.kind === signal.kind &&
    candidate.cwd === signal.cwd &&
    candidate.startedAtMs !== undefined &&
    nowMs - candidate.startedAtMs <= RELAUNCH_LOOP_WINDOW_MS
  ).length;
}

export function runawayControlCards(
  signals: FeedSessionSignal[],
  now: Date = new Date(),
): OpenBlock[] {
  const nowMs = now.getTime();
  const cards: OpenBlock[] = [];
  const seen = new Set<string>();
  for (const signal of signals) {
    const tokPerSec = finiteNumber(signal.tokPerSec);
    const cost = finiteNumber(signal.costUsd);
    const duration = finiteNumber(signal.durationMs);
    const burn = cost !== undefined && duration !== undefined && duration > 0
      ? cost / (duration / 3_600_000)
      : undefined;
    const loopCount = relaunchLoopCount(signal, signals, nowMs);
    const reasons: string[] = [];
    if (tokPerSec !== undefined && tokPerSec >= RUNAWAY_TOK_PER_SEC) reasons.push(`${Math.round(tokPerSec)} tok/s`);
    if (burn !== undefined && burn >= RUNAWAY_BURN_USD_PER_HOUR) reasons.push(`$${burn.toFixed(2)}/hr`);
    if (loopCount >= RELAUNCH_LOOP_COUNT) reasons.push(`${loopCount} launches in 10 minutes`);
    if (reasons.length === 0) continue;

    const id = signal.mailboxId ?? signal.sessionId ?? signal.cloudTaskId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    cards.push({
      blockId: `control-runaway-${id.replace(/[^A-Za-z0-9._-]/g, '-')}`,
      sessionId: signal.sessionId ?? id,
      mailboxId: signal.mailboxId ?? id,
      host: signal.host ?? 'local',
      runtime: signal.runtime ?? signal.context ?? 'unknown',
      project: signal.project,
      ts: new Date(signal.startedAtMs ?? nowMs).toISOString(),
      kind: 'control',
      questions: [{
        header: 'Runaway agent',
        text: `${id} is burning abnormally (${reasons.join(', ')}). Pause or kill it before it burns more parallel capacity.`,
      }],
      runaway: {
        reason: reasons.join(', '),
        tokPerSec,
        burnUsdPerHour: burn,
        relaunchesPerTenMinutes: loopCount || undefined,
      },
    });
  }
  return cards;
}

export function synthesizeControlCards(
  signals: FeedSessionSignal[],
  stats: FeedAskStats[],
  now: Date = new Date(),
): OpenBlock[] {
  return [
    ...runawayControlCards(signals, now),
    ...needyControlCards(stats, signals, now),
  ];
}
