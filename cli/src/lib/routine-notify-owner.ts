
import * as os from 'os';
import type { Meta } from './types.js';
import type { JobConfig, RunMeta } from './scheduling/routines.js';
import { routineKind } from './routine-notify.js';
import { readMeta } from './state.js';
import { getOwnerFromHumans } from './humans.js';
import { readOwnerDest } from './channels/send.js';
import { registerBuiltinProviders } from './channels/providers/index.js';
import { lookupTransport } from './channels/resolve.js';

const TELEGRAM_TRANSPORTS = new Set(['telegram', 'openclaw-telegram']);

function routineLabel(r: Pick<JobConfig, 'agent' | 'workflow' | 'command'>): string {
  const kind = routineKind(r);
  if (kind === 'command') return 'command';
  if (kind === 'workflow') return `workflow ${r.workflow}`;
  return `agent ${r.agent ?? 'unknown'}`;
}

function failureReason(
  meta: Pick<RunMeta, 'status' | 'exitCode' | 'errorMessage'>,
): string {
  if (meta.status === 'timeout') return 'Timed out';
  if (meta.errorMessage) return meta.errorMessage;
  return `Exited with code ${meta.exitCode ?? '?'}`;
}

export function routineFinishOwnerText(
  meta: Pick<RunMeta, 'jobName' | 'status' | 'exitCode' | 'errorMessage' | 'agent' | 'workflow' | 'command'>,
  host: string,
): string | null {

  if (meta.status !== 'failed' && meta.status !== 'timeout') return null;
  return `Routine failed: ${meta.jobName}\n${failureReason(meta)}\n${routineLabel(meta)} · ${host}`;
}

export function routineStartFailedOwnerText(
  config: Pick<JobConfig, 'name' | 'agent' | 'workflow' | 'command'>,
  error: string,
  host: string,
): string {
  return `Routine failed to start: ${config.name}\n${error}\n${routineLabel(config)} · ${host}`;
}

interface OwnerDest {
  channel: string;
  to: string;
}

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

  const primary = readOwnerDest(meta);
  if (primary) push(primary.channel, primary.to);

  for (const ch of ownerChannels) {
    push(ch.id, ch.to);
  }
  return plan;
}

interface OwnerDeliveryAttempt {
  channel: string;
  ok: boolean;
  error?: string;
}

interface OwnerDeliveryResult {
  delivered: boolean;
  channel?: string;
  attempts: OwnerDeliveryAttempt[];
}

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

const notifiedFailures = new Set<string>();
const MAX_DEDUP_KEYS = 1000;

function claimFailureKey(key: string): boolean {
  if (notifiedFailures.has(key)) return false;
  if (notifiedFailures.size >= MAX_DEDUP_KEYS) notifiedFailures.clear();
  notifiedFailures.add(key);
  return true;
}

function releaseFailureKey(key: string): void {
  notifiedFailures.delete(key);
}

export function __resetOwnerFailureDedup(): void {
  notifiedFailures.clear();
}

const NO_DELIVERY: OwnerDeliveryResult = { delivered: false, attempts: [] };

export async function notifyOwnerRoutineFinish(meta: RunMeta): Promise<OwnerDeliveryResult> {
  const text = routineFinishOwnerText(meta, os.hostname());
  if (!text) return NO_DELIVERY;
  const key = `${meta.jobName} ${meta.runId}`;
  if (!claimFailureKey(key)) return NO_DELIVERY;
  const result = await deliverOwnerFailure(text, readMeta());
  if (!result.delivered) releaseFailureKey(key);
  return result;
}

export async function notifyOwnerRoutineStartFailed(config: JobConfig, error: string): Promise<OwnerDeliveryResult> {
  const text = routineStartFailedOwnerText(config, error, os.hostname());
  return deliverOwnerFailure(text, readMeta());
}
