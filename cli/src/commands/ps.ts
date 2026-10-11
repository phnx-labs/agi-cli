import type { Command } from 'commander';
import { stripVTControlCharacters } from 'node:util';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import chalk from 'chalk';
import { setHelpSections } from '../lib/help.js';
import { indexActiveBySessionId, runLiveRoster, type LiveStatusFilter, type LiveStatusFlags } from './ps-roster.js';
import { buildPreview, transcriptOnPeerOf } from './sessions-picker.js';
import { loadSessionPreviewDigest } from '../lib/session/preview-digest.js';
import type { ActiveSession } from '../lib/session/active.js';
import { isBookmarked } from '../lib/session/bookmarks.js';
import { discoverSessions, isCompleteSessionId } from '../lib/session/discover.js';
import { buildSessionDetailBlock, formatLiveStatusHeadline, notFoundByIdMessage, sessionTranscriptStamp } from '../lib/session/presentation.js';
import { fetchPeerPreviewEnvelope, runOnPeer, shouldIncludeLocal } from '../lib/session/remote-list.js';
import { applyScopeFilters, computeLocalMetadataMatches, metadataResolveOutcome, resolveSessionMetadataValue, resolveSessionQuery, selectorAllowsEarlyExit, serializeResolvedSessionsJson } from '../lib/session/selection.js';
import { NO_FANOUT_ENV } from '../lib/session/remote-active.js';
import { loadLocalActiveSessions } from '../lib/session/session-cache.js';
import { machineId } from '../lib/session/sync/config.js';
import { registerSessionsStopCommand } from './sessions-stop.js';
import { registerFocusCommand } from './focus.js';
import { registerDetachCommand } from './detach.js';
import { registerSessionsMigrateCommand, registerSessionsMigrationsCommand } from './sessions-migrate.js';
import { registerSessionsWatchCommand } from './sessions-watch.js';

export const PS_STATUSES: readonly LiveStatusFilter[] = [
  'working',
  'idle',
  'waiting',
  'orphaned',
  'crashed',
  'closed',
  'abandoned',
  'queued',
  'unknown',
];

interface PsOptions {
  json?: boolean;
  local?: boolean;
  device?: string[];
  status?: string[];
  interactive?: boolean;
  bookmarks?: boolean;
  routine?: boolean | string;
}

export function statusFlags(values: string[] | undefined): LiveStatusFlags {
  const flags: LiveStatusFlags = {};
  for (const raw of values ?? []) {
    for (const value of raw.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean)) {
      const status = value === 'orphan' ? 'orphaned' : value;
      if (!PS_STATUSES.includes(status as LiveStatusFilter)) {
        throw new Error(`Unknown --status "${value}". Choose from: ${PS_STATUSES.join(', ')}.`);
      }
      flags[status as keyof LiveStatusFlags] = true;
    }
  }
  return flags;
}

export function deviceScope(devices: string[] | undefined): string[] | undefined {
  const hosts = (devices ?? []).filter((d) => !['all', 'fleet'].includes(d.toLowerCase()));
  return hosts.length > 0 ? hosts : undefined;
}

export function registerPsCommand(program: Command): void {
  const ps = program
    .command('ps')
    .enablePositionalOptions()
    .description('List running agents on this machine and across the fleet; stop, focus, detach, or migrate one')
    .option('--json', 'Print the roster as JSON (one row per live session)')
    .option('--local', 'Only this machine; skip the fleet fan-out')
    .option('-D, --device <target...>', 'Only these devices (alias from `agents devices`, user@host, or `all`; repeatable)')
    .option('--status <state...>', `Only these live states: ${PS_STATUSES.join(', ')} (repeatable or comma-separated)`)
    .option('--bookmarks', 'Only bookmarked sessions (bookmark one with `sessions bookmark <id>`)')
    .option('--routines, --routine [name]', 'Only routine-run sessions; pass a name to narrow to one routine (fuzzy name matching)')
    .option('--no-interactive', 'Print the roster instead of opening the picker on a TTY');

  setHelpSections(ps, {
    examples: `
      # What is running right now, here and on every reachable device
      agents ps

      # Machine-readable roster for this box only
      agents ps --json --local

      # One peer's running agents, over SSH
      agents ps --json -D yosemite-s0

      # Only agents waiting on you (exits 1 when any are waiting)
      agents ps --status waiting

      # Only bookmarked sessions, or the runs of one routine
      agents ps --bookmarks
      agents ps --routine nightly-review

      # Act on one row by its 8-character id
      agents ps focus 4b2f1a9c
      agents ps detach 4b2f1a9c
      agents ps stop 4b2f1a9c
      agents ps migrate 4b2f1a9c --auto

      # Where migrated sessions went
      agents ps migrations

      # Stream live and recoverable session rows for a long-lived UI
      agents ps watch --json
    `,
    notes: `
      - On a TTY with no --status, ps opens the session picker filtered to running
        sessions: r toggles that filter, f focuses, enter resumes, y copies the command.
      - Type into a running agent with: agents send --channel session --to <id> --text "continue"
      - Resume an ended session with: agents run auto --resume <id>
      - A session on another device is stopped, detached, or focused there over SSH.
      - Put -D and --status after the verb or after the roster flags, never before a
        verb: they take several values, so 'ps -D box stop <id>' reads 'stop' as a device.
    `,
  });

  ps.action(async (opts: PsOptions) => {
    let flags: LiveStatusFlags;
    try {
      flags = statusFlags(opts.status);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 2;
      return;
    }
    await runLiveRoster({
      ...flags,
      json: opts.json,
      local: opts.local,
      host: deviceScope(opts.device),
      interactive: opts.interactive,
      bookmarks: opts.bookmarks,
      routine: opts.routine,
    });
  });

  registerSessionsStopCommand(ps);
  registerFocusCommand(ps);
  registerDetachCommand(ps);
  registerSessionsMigrateCommand(ps);
  registerSessionsMigrationsCommand(ps);
  registerSessionPreviewCommand(ps);
  registerSessionsWatchCommand(ps);
  registerPeerResolveCommand(ps);
}

// Fleet protocol: a peer answers another box's selector or launch-id lookup from its own index.
function registerPeerResolveCommand(ps: Command): void {
  ps.command('resolve', { hidden: true })
    .argument('[selector]')
    .option('--launch-id <id>')
    .option('-a, --agent <agent>')
    .option('-p, --project <name>')
    .option('--json')
    .option('--local')
    .action(async (selector: string | undefined, _options: unknown, invoked: Command) => {
      const opts = invoked.optsWithGlobals() as { launchId?: string; agent?: string; project?: string; json?: boolean };
      if (!opts.json) {
        console.error(chalk.red('ps resolve requires --json.'));
        process.exit(1);
      }
      if (opts.launchId !== undefined) {
        const launchId = opts.launchId.trim();
        if (!launchId) throw new Error('--launch-id requires a non-empty launch id.');
        const { loadHookSessionIndex } = await import('../lib/session/hook-sessions.js');
        const record = loadHookSessionIndex().byLaunchId.get(launchId);
        process.stdout.write(JSON.stringify({ launchId, sessionId: record?.session_id ?? null }) + '\n');
        return;
      }
      if (process.env[NO_FANOUT_ENV] !== '1') {
        console.error(chalk.red('ps resolve is an internal fleet protocol.'));
        process.exit(1);
      }
      const trimmed = selector?.trim();
      if (!trimmed) {
        console.error(chalk.red('ps resolve requires a non-empty selector.'));
        process.exit(1);
      }
      const matches = await computeLocalMetadataMatches(trimmed, { agent: opts.agent, project: opts.project, local: true });
      process.stdout.write(serializeResolvedSessionsJson(matches));
    });
}

function registerSessionPreviewCommand(parent: Command): void {
  const previewCmd = parent
    .command('preview')
    .argument('<id...>', 'Full session IDs or displayed 8-character short IDs')
    .description('Show rich session cards without rendering the full transcripts')
    .option('-a, --agent <agent>', 'Narrow the ID to one agent type/version')
    .option('-p, --project <name>', 'Narrow the ID to one project')
    .option('--local', 'Only this machine; do not resolve the ID across the fleet')
    .option('-D, --device <target...>', 'Resolve only on the named device(s)')
    .option('--json', 'Output the session preview as JSON')
    .option('--refresh', 'Bypass the durable remote-preview cache and negative backoff for one bounded fetch (full ID + single --device only)')
    .option('--revision <cursor>', 'Opaque caller-owned activity cursor (any stable value YOU track, e.g. your own feed\'s lastActivityMs) -- passing the SAME value as your last call confirms nothing changed and serves the cache with zero SSH indefinitely; a different value fetches once, still subject to backoff unless --refresh is also set (full ID + single --device only)');

  setHelpSections(previewCmd, {
    examples: `
      # Preview by the 8-character ID shown in agents ps
      agents ps preview 407b8dd5

      # A full UUID resolves on the first device that owns it
      agents ps preview c70ecdea-6210-4039-9845-246a3a7a9942

      # Stay on this machine or restrict the authoritative lookup to one peer
      agents ps preview 407b8dd5 --local
      agents ps preview 407b8dd5 --device zion

      # Full ID + one --device: durable-cached fast path (PHNX-3999); force a fresh fetch
      agents ps preview c70ecdea-6210-4039-9845-246a3a7a9942 --device zion --json --refresh

      # Several cards in one call: a JSON array in argument order
      agents ps preview 407b8dd5 c70ecdea --json
    `,
    notes: `
      - Full UUIDs are globally unique and may stop the fleet lookup at the first exact hit.
      - Short IDs wait for every selected device so ambiguity is never hidden.
      - Active status is refreshed through the bounded live-state TTL; transcript-derived details use the durable session index.
      - A full UUID with exactly one --device and --json is served from a local durable cache (~45s fresh window); the JSON envelope's "cache" field reports fresh/stale/offline state. --refresh forces one bounded re-fetch.
      - With several IDs, --json prints one array in argument order; each element is the single-ID envelope plus "query", and an ID that does not resolve is an element with "error" set. The exit code is 1 only when no ID resolved.
      - Put -D after the verb: 'ps -D box preview <id>' reads 'preview' as a device.
    `,
  });

  previewCmd.action(async (ids: string[]) => {
    const options = previewCmd.optsWithGlobals() as {
      agent?: string;
      project?: string;
      local?: boolean;
      host?: string[];
      device?: string[];
      json?: boolean;
      refresh?: boolean;
      revision?: string;
    };
    const hosts = [...(options.host ?? []), ...(options.device ?? [])];
    const scope: PreviewScope = {
      agent: options.agent,
      project: options.project,
      local: options.local,
      hosts: hosts.length > 0 ? hosts : undefined,
      json: options.json,
      refresh: options.refresh,
      revision: options.revision,
    };
    if (ids.length === 1) await renderSessionPreview(ids[0], scope);
    else await renderSessionPreviews(ids, scope);
  });
}

type PreviewScope = { agent?: string; project?: string; local?: boolean; hosts?: string[]; json?: boolean; refresh?: boolean; revision?: string };
type PreviewJson = Record<string, unknown>;

function previewErrorJson(message: string): PreviewJson {
  return { schemaVersion: 1, session: null, active: null, preview: null, error: message, details: null };
}

async function remoteCachedPreviewJson(query: string, scope: PreviewScope): Promise<PreviewJson | undefined> {
  if (!scope.json || scope.local || scope.hosts?.length !== 1
    || scope.hosts[0] === machineId() || !isCompleteSessionId(query.trim())) return undefined;
  const { getRemoteSessionPreview } = await import('../lib/session/remote-preview-cache.js');
  const result = await getRemoteSessionPreview(query.trim(), scope.hosts[0], {
    refresh: scope.refresh,
    revision: scope.revision,
  });
  const envelope = result.envelope as {
    session?: unknown; active?: unknown; preview?: unknown; error?: unknown; details?: unknown;
  } | undefined;
  return {
    schemaVersion: 1,
    session: envelope?.session ?? null,
    active: result.cache.source === 'live' ? (envelope?.active ?? null) : null,
    preview: envelope?.preview ?? null,
    error: envelope?.error ?? (envelope ? null : result.cache.reason),
    details: envelope?.details ?? null,
    cache: result.cache,
  };
}

async function resolvePreviewSession(query: string, scope: PreviewScope): Promise<{ session: SessionMeta } | { errorLines: string[] }> {
  let outcome = await resolveSessionMetadataValue(query, scope);
  if (outcome.kind !== 'resolved'
    && (!scope.hosts?.length || shouldIncludeLocal(scope.hosts, machineId()))) {
    const discovered = applyScopeFilters(
      await discoverSessions({ all: true, cwd: process.cwd(), limit: 5000, waitForScan: true }),
      scope,
    );
    const localMatches = resolveSessionQuery(discovered, query, { indexFallback: false, scope }).matches
      .map(session => ({ ...session, machine: session.machine || machineId() }));
    const exact = localMatches.find(session => selectorAllowsEarlyExit(query)
      && session.id.toLowerCase() === query.trim().toLowerCase());
    if (exact) outcome = { kind: 'resolved', session: exact };
    else if (outcome.kind === 'not-found' && localMatches.length > 0) {
      outcome = metadataResolveOutcome(localMatches, { sessions: [], unreachable: [] }, query);
    }
  }
  if (outcome.kind === 'partial') {
    const offline = outcome.failedPeers;
    return { errorLines: [
      chalk.yellow(`Warning: ${offline.length} device(s) unreachable, not checked: ${offline.join(', ')}`),
      chalk.red(`No session matching "${query}" on any reachable device (${offline.length} unreachable, not checked).`),
      chalk.gray('  If it lives on an offline box, wake it (agents devices) or run there: agents ssh <device>'),
    ] };
  }
  if (outcome.kind === 'not-found') return { errorLines: notFoundByIdMessage(query) };
  if (outcome.kind === 'ambiguous') {
    return { errorLines: [
      chalk.red(`Multiple sessions match "${query}" across the fleet:`),
      ...outcome.candidates.map((candidate) => {
        const match = candidate.hits[0].session;
        const machines = candidate.hits.map(hit => hit.machine).join(', ');
        return chalk.cyan(`  ${match.shortId}  ${match.id}`) + chalk.gray(`  ${machines}  ${match.agent}${match.version ? ` ${match.version}` : ''}`);
      }),
      chalk.gray('Pass the full session ID to narrow it down.'),
    ] };
  }
  return { session: outcome.session };
}

function localPreviewJson(session: SessionMeta, live: ActiveSession | undefined): PreviewJson {
  const sourceStamp = sessionTranscriptStamp(session);
  const { digest, error, events } = loadSessionPreviewDigest(session);
  return {
    schemaVersion: 1,
    session: {
      id: session.id,
      shortId: session.shortId,
      agent: session.agent,
      version: session.version,
      model: session.model,
      account: session.account,
      machine: session.machine ?? machineId(),
      cwd: session.cwd,
      project: session.project,
      gitBranch: session.gitBranch,
      createdAt: session.timestamp,
      lastActivity: session.lastActivity,
      durationMs: session.durationMs,
      messageCount: session.messageCount,
      tokenCount: session.tokenCount,
      costUsd: session.costUsd,
      label: session.label,
      topic: session.topic,
      ticketId: session.ticketId,
      prUrl: session.prUrl,
    },
    active: live ? {
      status: live.status,
      activity: live.activity,
      awaitingReason: live.awaitingReason,
      lastActivityMs: live.lastActivityMs,
      startedAtMs: live.startedAtMs,
      pid: live.pid,
      host: live.host,
    } : null,
    preview: digest ?? null,
    error: error ?? null,
    details: buildSessionDetailBlock(session, digest, events, sourceStamp),
  };
}

async function liveSessionsById(): Promise<Map<string, ActiveSession>> {
  try {
    return indexActiveBySessionId((await loadLocalActiveSessions()).sessions);
  } catch {
    return new Map();
  }
}

export async function previewJsonFor(query: string, scope: PreviewScope, live: Promise<Map<string, ActiveSession>>): Promise<PreviewJson> {
  const cached = await remoteCachedPreviewJson(query, scope);
  if (cached) return cached;
  const resolved = await resolvePreviewSession(query, scope);
  if ('errorLines' in resolved) return previewErrorJson(resolved.errorLines.map(line => stripVTControlCharacters(line).trim()).join(' '));
  const { session } = resolved;
  const transcriptPeer = transcriptOnPeerOf(session);
  if (transcriptPeer) {
    const fetched = await fetchPeerPreviewEnvelope(session.id, transcriptPeer);
    if (fetched.ok && fetched.envelope && typeof fetched.envelope === 'object' && !Array.isArray(fetched.envelope)) return fetched.envelope as PreviewJson;
    return previewErrorJson(`Session ${session.id} is on ${transcriptPeer}, but that device did not answer (${fetched.ok ? 'invalid-json' : fetched.reason}).`);
  }
  return localPreviewJson(session, (await live).get(session.id));
}

export async function renderSessionPreviews(queries: string[], scope: PreviewScope, read: typeof previewJsonFor = previewJsonFor): Promise<void> {
  if (!scope.json) {
    const shown: boolean[] = [];
    for (const [index, query] of queries.entries()) {
      if (index > 0) console.log('');
      try {
        shown.push(await printSessionPreview(query, scope));
      } catch (err) {
        console.error(chalk.red(`${query}: ${(err as Error).message}`));
        shown.push(false);
      }
    }
    if (!shown.some(Boolean)) process.exitCode = 1;
    return;
  }
  const live = liveSessionsById();
  const results: PreviewJson[] = await Promise.all(queries.map(async (query) => {
    try {
      return { query, ...await read(query, scope, live) };
    } catch (err) {
      return { query, ...previewErrorJson((err as Error).message) };
    }
  }));
  console.log(JSON.stringify(results));
  if (results.every(result => result.session === null)) process.exitCode = 1;
}

export async function renderSessionPreview(query: string, scope: PreviewScope): Promise<void> {
  if (!await printSessionPreview(query, scope)) process.exitCode = 1;
}

async function printSessionPreview(query: string, scope: PreviewScope): Promise<boolean> {
  const cached = await remoteCachedPreviewJson(query, scope);
  if (cached) {
    console.log(JSON.stringify(cached));
    return true;
  }
  const resolved = await resolvePreviewSession(query, scope);
  if ('errorLines' in resolved) {
    resolved.errorLines.forEach(line => console.error(line));
    return false;
  }
  const { session } = resolved;
  const transcriptPeer = transcriptOnPeerOf(session);
  if (transcriptPeer) {
    const args = ['ps', 'preview', session.id, '--local'];
    if (scope.json) args.push('--json');
    const rendered = await runOnPeer(args, transcriptPeer);
    if (rendered === 'no-target') {
      console.error(chalk.red(`Session ${session.id} is on ${transcriptPeer}, but that device is not reachable.`));
      return false;
    }
    return true;
  }

  const live = (await liveSessionsById()).get(session.id);
  if (scope.json) {
    console.log(JSON.stringify(localPreviewJson(session, live)));
    return true;
  }
  const headline = formatLiveStatusHeadline(live, isBookmarked(session.id));
  if (headline) console.log(headline);
  console.log(buildPreview(session));
  return true;
}
