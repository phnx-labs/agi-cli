/** Owner phone notification on routine FAILURE (RUSH-2288). Desktop notifications stay on the
 * machine, and a per-routine `agents send --to owner` prompt never runs if the agent fails to
 * spawn. So the DAEMON delivers in-process over owner channels (never Telegram), once per run. */

import * as os from 'os';
import type { Meta } from './types.js';
import type { JobConfig, RunMeta } from './scheduling/routines.js';
import { routineKind } from './routine-notify.js';
import { readMeta } from './state.js';
import { getOwnerFromHumans } from './humans.js';
import { readOwnerDest } from './channels/send.js';
import { registerBuiltinProviders } from './channels/providers/index.js';
import { lookupTransport } from './channels/resolve.js';

/** Transports that are Telegram in any form — never delivered to (owner rule). */
const TELEGRAM_TRANSPORTS = new Set(['telegram', 'openclaw-telegram']);

/** Human label for the routine body ("agent claude", "workflow deploy", "command"). */
function routineLabel(r: Pick<JobConfig, 'agent' | 'workflow' | 'command'>): string {
  const kind = routineKind(r);
  if (kind === 'command') return 'command';
  if (kind === 'workflow') return `workflow ${r.workflow}`;
  return `agent ${r.agent ?? 'unknown'}`;
}

/** The failure reason line for a terminal run: timeout / error message / exit code. */
function failureReason(
  meta: Pick<RunMeta, 'status' | 'exitCode' | 'errorMessage'>,
): string {
  if (meta.status === 'timeout') return 'Timed out';
  if (meta.errorMessage) return meta.errorMessage;
  return `Exited with code ${meta.exitCode ?? '?'}`;
}

/** Owner-phone text for a routine FINISH, or null when it did not fail: only `failed` and `timeout`
 * ping, `completed` is silent, and `running`/`missed` never reach here. A short phone-sized pointer
 * (what failed, why, which box), under the `user-message-guard` length ceiling. */
export function routineFinishOwnerText(
  meta: Pick<RunMeta, 'jobName' | 'status' | 'exitCode' | 'errorMessage' | 'agent' | 'workflow' | 'command'>,
  host: string,
): string | null {
  if (meta.status !== 'failed' && meta.status !== 'timeout') return null;
  return `Routine failed: ${meta.jobName}\n${failureReason(meta)}\n${routineLabel(meta)} · ${host}`;
}

/** Owner-phone text for a routine that failed to even START (`executeJobDetached` threw before a
 * child existed, e.g. `auth_failed`). Never null: always worth a ping for every kind, and the case
 * the per-routine `agents notify` prompt can't cover since it never ran. */
export function routineStartFailedOwnerText(
  config: Pick<JobConfig, 'name' | 'agent' | 'workflow' | 'command'>,
  error: string,
  host: string,
): string {
  return `Routine failed to start: ${config.name}\n${error}\n${routineLabel(config)} · ${host}`;
}

/** One resolved owner destination to attempt, in plan order. */
interface OwnerDest {
  channel: string;
  to: string;
}

/** True when a channel would deliver over Telegram, checking the channel id (`telegram`), the
 * humans.yaml `transport` on the entry, then `notify.transports[id]` remapping (or the id as
 * default transport name); any hit is excluded. */
function isTelegramChannel(
  channelId: string,
  meta: Meta,
  humansTransport?: string,
): boolean {
  if (channelId.trim().toLowerCase() === 'telegram') return true;
  if (humansTransport && TELEGRAM_TRANSPORTS.has(humansTransport.trim().toLowerCase())) {
    return true;
  }
  const transport = meta.notify?.transports?.[channelId] ?? channelId;
  return TELEGRAM_TRANSPORTS.has(transport.trim().toLowerCase());
}

/** Ordered owner delivery plan for a failure ping: the primary owner destination first, then every
 * other owner channel, deduped by (channel, to). Telegram and intrusive channels (voice call) are
 * excluded from both, so an owner with only Telegram gets no ping: silence beats Telegram. */
export function ownerFailureDeliveryPlan(meta: Meta): OwnerDest[] {
  const plan: OwnerDest[] = [];
  const seen = new Set<string>();
  const ownerChannels = getOwnerFromHumans()?.channels ?? [];
  const byId = new Map(ownerChannels.map((ch) => [ch.id, ch]));

  const push = (channel?: string, to?: string): void => {
    const c = channel?.trim();
    const t = to?.trim();
    if (!c || !t) return;
    const entry = byId.get(c);
    if (entry?.intrusive) return;
    if (isTelegramChannel(c, meta, entry?.transport)) return;
    const key = `${c} ${t}`;
    if (seen.has(key)) return;
    seen.add(key);
    plan.push({ channel: c, to: t });
  };

  // Primary = the destination `agents send --to owner` would resolve (humans policy →
  // first addressable → legacy notify.owner). Same filters as the fallbacks.
  const primary = readOwnerDest(meta);
  if (primary) push(primary.channel, primary.to);

  // Fallbacks = the remaining configured owner channels, in declared order.
  for (const ch of ownerChannels) {
    push(ch.id, ch.to);
  }
  return plan;
}

/** Outcome of one delivery attempt, for logging/telemetry. */
interface OwnerDeliveryAttempt {
  channel: string;
  ok: boolean;
  error?: string;
}

interface OwnerDeliveryResult {
  /** True once any channel in the plan accepted the message. */
  delivered: boolean;
  /** The channel that delivered, when `delivered`. */
  channel?: string;
  /** Every attempt made, in order — empty when no owner channel is configured. */
  attempts: OwnerDeliveryAttempt[];
}

/** Deliver `text` to the owner over the failure plan in-process, trying each channel until one
 * accepts. Uses the non-dying `lookupTransport` (not `resolveTransport`, which `die()`s) so a bad
 * channel name can't kill the daemon. Never throws; returns the attempt log. */
export async function deliverOwnerFailure(text: string, meta: Meta): Promise<OwnerDeliveryResult> {
  const plan = ownerFailureDeliveryPlan(meta);
  const attempts: OwnerDeliveryAttempt[] = [];
  if (plan.length === 0) return { delivered: false, attempts };

  registerBuiltinProviders();
  for (const dest of plan) {
    const { provider, error } = lookupTransport(dest.channel, meta);
    if (!provider) {
      attempts.push({ channel: dest.channel, ok: false, error });
      continue;
    }
    try {
      const result = await provider.send(text, {
        target: dest.to,
        from: 'routines',
        ownerScoped: true,
      });
      attempts.push({ channel: dest.channel, ok: result.ok, error: result.error });
      if (result.ok) return { delivered: true, channel: dest.channel, attempts };
    } catch (err) {
      attempts.push({ channel: dest.channel, ok: false, error: (err as Error).message });
    }
  }
  return { delivered: false, attempts };
}

/** Per-process dedup of failure pings keyed by job+runId (or the synthetic start-failed key), so a
 * run is announced at most once even if the finish hook fires twice or a sweep re-finalizes it.
 * Bounded so a long-lived daemon doesn't grow it. */
const notifiedFailures = new Set<string>();
const MAX_DEDUP_KEYS = 1000;

/** Claim a dedup key for an in-flight delivery; false when already delivered or in flight. Callers
 * MUST {@link releaseFailureKey} when delivery fails so a later tick can retry, else a
 * claim-before-send would suppress permanent failures forever (RUSH-2288 review). */
function claimFailureKey(key: string): boolean {
  if (notifiedFailures.has(key)) return false;
  if (notifiedFailures.size >= MAX_DEDUP_KEYS) notifiedFailures.clear();
  notifiedFailures.add(key);
  return true;
}

/** Drop a key so a failed delivery can be retried on the next finish hook. */
function releaseFailureKey(key: string): void {
  notifiedFailures.delete(key);
}

/** Test-only: reset the dedup set so cases don't leak state into each other. */
export function __resetOwnerFailureDedup(): void {
  notifiedFailures.clear();
}

/** A green run / deduped skip attempted no channel. */
const NO_DELIVERY: OwnerDeliveryResult = { delivered: false, attempts: [] };

/** Daemon glue: on a routine FINISH ping the owner only if the run failed; green runs return early.
 * Deduped per job+runId (claimed while in flight, released when no channel accepted so a later
 * sweep can retry). Best-effort. */
export async function notifyOwnerRoutineFinish(meta: RunMeta): Promise<OwnerDeliveryResult> {
  const text = routineFinishOwnerText(meta, os.hostname());
  if (!text) return NO_DELIVERY; // green / non-terminal → silent
  const key = `${meta.jobName} ${meta.runId}`;
  if (!claimFailureKey(key)) return NO_DELIVERY;
  const result = await deliverOwnerFailure(text, readMeta());
  if (!result.delivered) releaseFailureKey(key);
  return result;
}

/** Daemon glue for a pre-spawn failure (no run record, so no finish hook or runId). Not deduped: it
 * is one scheduled fire on the cron cadence, never a per-second storm, and each is a distinct
 * failure. Best-effort. */
export async function notifyOwnerRoutineStartFailed(config: JobConfig, error: string): Promise<OwnerDeliveryResult> {
  const text = routineStartFailedOwnerText(config, error, os.hostname());
  return deliverOwnerFailure(text, readMeta());
}
