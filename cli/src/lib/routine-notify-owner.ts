/**
 * Owner phone notification on routine FAILURE (RUSH-2288).
 *
 * The desktop lifecycle notifications (routine-notify.ts) never leave the
 * machine, so a failed scheduled routine on a headless fleet box was invisible
 * until someone happened to look. The per-routine prompt pattern (a prompt that
 * ends by shelling `agents send --to owner`) does not close the gap either: when the
 * routine's OWN agent fails to spawn (`auth_failed`) that prompt never runs, so
 * the one failure most worth surfacing is the one that goes unheard.
 *
 * So the DAEMON delivers on failure, from the SAME owner channel stack `agents
 * send --to owner` uses (humans.yaml owner channels, or the legacy `notify.owner`),
 * calling the channel providers IN-PROCESS — no shelling out to `ssh mac-mini
 * agents send --to owner`. When the primary owner channel cannot deliver from this box it
 * walks the remaining configured owner channels as fallbacks (OpenClaw, a second
 * channel, …). Telegram is never used.
 *
 * Only failures notify. A green routine of any kind stays silent — this is an
 * ADDITIONAL failures-only lane, and the desktop thresholds (which still ping a
 * green agent/workflow finish on the local screen) are unchanged. Delivery is
 * deduped per job+runId so a run is announced to the owner at most once.
 *
 * The message BUILDERS (`routineFinishOwnerText` / `routineStartFailedOwnerText`)
 * are pure and unit-tested; `notifyOwnerRoutineFinish` /
 * `notifyOwnerRoutineStartFailed` are the daemon glue that reads config and
 * delivers.
 */

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

/**
 * Owner-phone text for a routine FINISH, or null when the run did NOT fail. Only
 * `failed` and `timeout` are failures worth an owner ping — a `completed` run
 * (any kind) is silent, and `running`/`missed` never reach this path from the
 * daemon's finish hook. The text is a short, phone-sized pointer: what failed,
 * why, and on which box (so the owner knows where to look), well under the
 * `user-message-guard` length ceiling.
 */
export function routineFinishOwnerText(
  meta: Pick<RunMeta, 'jobName' | 'status' | 'exitCode' | 'errorMessage' | 'agent' | 'workflow' | 'command'>,
  host: string,
): string | null {
  if (meta.status !== 'failed' && meta.status !== 'timeout') return null;
  return `Routine failed: ${meta.jobName}\n${failureReason(meta)}\n${routineLabel(meta)} · ${host}`;
}

/**
 * Owner-phone text for a routine that failed to even START (the daemon's
 * pre-spawn catch — `executeJobDetached` threw before a child existed, e.g.
 * `auth_failed`). Never null: a broken start is always a failure worth the ping,
 * for every routine kind, and it is exactly the case the per-routine `agents
 * notify` prompt can never cover because that prompt never ran.
 */
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

/**
 * True when a channel would deliver over Telegram. Checks, in order:
 * 1. the channel id itself (`telegram`);
 * 2. the humans.yaml `transport` field on the channel entry (when provided);
 * 3. `notify.transports[id]` remapping (or the id as the default transport name).
 * Any of those landing on a Telegram-delivering provider is excluded.
 */
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

/**
 * Ordered owner delivery plan for a failure ping: the primary owner destination
 * (the same one `agents send --to owner` resolves) first, then every other configured
 * owner channel as a fallback. Deduped by (channel, to). Telegram channels and
 * intrusive channels (a voice call is too much for a routine failure) are
 * excluded entirely — so an owner whose ONLY channel is Telegram gets an empty
 * plan and no ping, which is the intended "silence beats Telegram" outcome.
 *
 * The same filters apply to the primary and the fallback list — a policy that
 * points normal severity at a voice channel must not auto-call the owner on
 * every routine failure.
 */
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

/**
 * Deliver `text` to the owner over the failure plan, in-process, trying each
 * channel until one accepts. Uses the non-dying `lookupTransport` (never
 * `resolveTransport`, which `die()`s the process) so a daemon survives a bad
 * channel name. Best-effort by contract: the daemon wraps this in try/catch, but
 * it also never throws for a delivery failure — it returns the attempt log.
 */
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

/**
 * Per-process dedup of failure pings, keyed by job+runId (finishes) or the
 * synthetic start-failed key. A run is announced to the owner at most once even
 * if the finish hook fires twice or a later sweep re-finalizes the same record.
 * Bounded so a long-lived daemon never grows it without limit.
 */
const notifiedFailures = new Set<string>();
const MAX_DEDUP_KEYS = 1000;

/**
 * Claim a dedup key for an in-flight delivery. Returns false when this
 * job+runId was already delivered (or is already in flight). Callers MUST
 * {@link releaseFailureKey} when delivery fails so a later tick can retry —
 * claiming before send without a release would suppress permanent failures
 * forever (RUSH-2288 review).
 */
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

/**
 * Daemon glue: on a routine FINISH, ping the owner IFF the run failed. Green
 * runs return early (no ping). Deduped per job+runId — claimed for the
 * in-flight window so two finish hooks don't double-text, released when no
 * channel accepted so a later sweep can retry. Best-effort.
 */
export async function notifyOwnerRoutineFinish(meta: RunMeta): Promise<OwnerDeliveryResult> {
  const text = routineFinishOwnerText(meta, os.hostname());
  if (!text) return NO_DELIVERY; // green / non-terminal → silent
  const key = `${meta.jobName} ${meta.runId}`;
  if (!claimFailureKey(key)) return NO_DELIVERY;
  const result = await deliverOwnerFailure(text, readMeta());
  if (!result.delivered) releaseFailureKey(key);
  return result;
}

/**
 * Daemon glue: on a pre-spawn failure (no run record, so no finish hook and no
 * runId), ping the owner. Not deduped — a pre-spawn failure is one scheduled
 * fire on the cron cadence (never a per-second storm), and each such fire is a
 * distinct failure the owner should hear about. Best-effort.
 */
export async function notifyOwnerRoutineStartFailed(config: JobConfig, error: string): Promise<OwnerDeliveryResult> {
  const text = routineStartFailedOwnerText(config, error, os.hostname());
  return deliverOwnerFailure(text, readMeta());
}
