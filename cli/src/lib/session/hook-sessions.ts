/**
 * Read-only view of the SessionStart hook's live-session state files.
 *
 * Two on-disk sources carry a non-Claude agent's authoritative id (whose id we
 * can't know at spawn), both read here:
 *   1. The `@agents/session-tracker` hook writes
 *      `~/.agents/.cache/terminals/sessions/<pid>.json` with the id plus the join
 *      keys `launch_id` / `terminal_id`. Rich schema, but this package is NOT
 *      deployed on the fleet — its dir is empty there. Scanned into the index by
 *      {@link loadHookSessionIndex}.
 *   2. The ACTUALLY-DEPLOYED SessionStart hook writes
 *      `~/.agents/.cache/state/sessions/<pid>.json` ({@link readStateSessionRecord})
 *      — `{session_id,cwd,pid,ts}`, keyed purely by pid. This is the real fleet id
 *      source for every agent; read targeted per-pid, never scanned (RUSH-2007).
 * Both see agents `ag run` did NOT launch (you typing `claude` in a terminal).
 *
 * This module lets `sessions --active` reconcile a `ps`-discovered pid to that
 * authoritative id. It is deliberately a small hand-rolled reader — the CLI does
 * NOT import the session-tracker package (a separate, workspace-less package;
 * see packages/session-tracker/CLAUDE.md) — mirroring AGI EXT's own
 * hand-copied reader in apps/ext/src/core/liveSession.ts. It only READS the
 * existing dir/schema. The owning launcher also records a completed launch
 * binding in that schema before returning; readers remain read-only across a
 * fleet where old hooks and a new CLI coexist.
 *
 * The whole state dir is scanned ONCE per active-scan into an index (the listing
 * path polls every ~3s), and every lookup keys the pre-built maps — never a
 * re-scan per candidate.
 */
import fs from 'fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { atomicWriteFileSync } from '../fs-atomic.js';
import { hostProcessView } from './process-view.js';
import path from 'path';
import { getTerminalsDir, getRuntimeStateDir } from '../state.js';
import { listPidSessionEntries, pidSessionEntryMatchesLiveProcess, readLivePidSessionEntry, readPidSessionEntry, type PidSessionEntry } from './pid-registry.js';

/** The subset of the hook's on-disk record this reader relies on. Extra fields are ignored. */
export interface HookSessionRecord {
  session_id: string;
  agent?: string;
  cwd?: string;
  pid: number;
  launch_id?: string;
  terminal_id?: string;
  ts?: number;
  completed?: boolean;
}

/** Pre-built lookup maps over one scan of the hook state dir. */
export interface HookSessionIndex {
  byLaunchId: Map<string, HookSessionRecord>;
  byTerminalId: Map<string, HookSessionRecord>;
  byPid: Map<number, HookSessionRecord>;
}

function hookSessionsDir(): string {
  // Sibling of the pid-registry's by-pid/ dir. The hook hardcodes this same path
  // (packages/session-tracker/src/hook.sh); we read it, never move it.
  return path.join(getTerminalsDir(), 'sessions');
}

/**
 * The path the ACTUALLY-DEPLOYED SessionStart hook writes:
 * `~/.agents/.cache/state/sessions/<pid>.json`, carrying `{session_id,cwd,pid,ts}`
 * for EVERY agent (claude/codex/gemini/kimi/grok/antigravity). This is the fleet's
 * real id source; the `terminals/sessions/` path above belongs to the separate
 * `@agents/session-tracker` package, which is not deployed (its dir is empty on the
 * fleet), so a non-Claude tmux session's id resolved ONLY through the index above
 * never landed (RUSH-2007). These records are keyed purely by pid — no
 * launch_id/terminal_id/agent — so they join only on pid. The dir is an unpruned
 * graveyard (thousands of dead-pid files), so this is a TARGETED per-pid read on
 * demand, never a full-dir scan folded into {@link loadHookSessionIndex}.
 */
function stateSessionRecordPath(pid: number): string {
  return path.join(getRuntimeStateDir(), 'sessions', `${pid}.json`);
}

/**
 * Read the deployed hook's record for one specific pid, or undefined if absent /
 * corrupt / not fresh. `startedAtMs` (the live process's known start, when the
 * caller has it) rejects a stale record left by a PRIOR process at a reused pid:
 * the hook writes its record AFTER the agent boots, so a record whose `ts`
 * predates the current process's start belongs to a dead predecessor. `ts` is
 * Unix SECONDS (the hook stamps `date +%s`); `startedAtMs` is millis.
 */
export function readStateSessionRecord(
  pid: number,
  startedAtMs?: number,
): HookSessionRecord | undefined {
  if (!pid || pid < 1) return undefined;
  let rec: HookSessionRecord | undefined;
  try {
    rec = parseRecord(fs.readFileSync(stateSessionRecordPath(pid), 'utf8'));
  } catch {
    return undefined; // absent (the common case) or unreadable
  }
  if (!rec) return undefined;
  if (startedAtMs !== undefined && typeof rec.ts === 'number') {
    // Allow a small skew: the hook fires just after exec, and ts is second-
    // granular so it can floor to just before a sub-second process start.
    const SKEW_MS = 5_000;
    if (rec.ts * 1000 < startedAtMs - SKEW_MS) return undefined; // reused-pid graveyard record
  }
  return rec;
}

function parseRecord(raw: string): HookSessionRecord | undefined {
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && typeof o.session_id === 'string' && o.session_id) {
      return o as HookSessionRecord;
    }
  } catch {
    /* unparseable — treat as absent */
  }
  return undefined;
}

/** Keep the newest record (by `ts`) when two collide on the same key. Uses the
 *  same strict `>` tie-break as the session-tracker's own reader (reader.ts). */
function keepNewest(map: Map<string | number, HookSessionRecord>, key: string | number, rec: HookSessionRecord): void {
  const prev = map.get(key);
  if (!prev || (rec.ts ?? 0) > (prev.ts ?? 0)) map.set(key, rec);
}

let clockTicks: number | undefined;

/** Recover an already-running launch after an old reader removed its registry.
 * Enumerate live PIDs, not the hook's unbounded graveyard. Only decode the one
 * allowed environment key; no unrelated environment value escapes this reader.
 * Kernel incarnation and namespace are checked on both sides of the reads. */
function liveUnregisteredHookRecords(): HookSessionRecord[] {
  const scope = hostProcessView();
  if (process.platform !== 'linux' || !scope?.pidNamespace) return [];
  try {
    clockTicks ??= Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 1000 }));
    if (!Number.isFinite(clockTicks) || clockTicks <= 0) return [];
    const bootSeconds = Number(fs.readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)$/m)?.[1]);
    if (!Number.isFinite(bootSeconds)) return [];
    const result: HookSessionRecord[] = [];
    const identity = (pid: number) => {
      if (fs.readlinkSync(`/proc/${pid}/ns/pid`) !== scope.pidNamespace) return undefined;
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return fields[0] !== 'Z' && /^\d+$/.test(fields[19]) ? fields[19] : undefined;
    };
    const prefix = Buffer.from('AGENT_LAUNCH_ID=');
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      try {
        if (!fs.existsSync(stateSessionRecordPath(pid))) continue;
        const before = identity(pid);
        if (!before) continue;
        const rec = readStateSessionRecord(pid);
        const startedSeconds = bootSeconds + Number(before) / clockTicks;
        if (!rec || rec.pid !== pid || typeof rec.ts !== 'number'
          || rec.ts < Math.floor(startedSeconds) || rec.ts > Date.now() / 1000) continue;
        const environment = fs.readFileSync(`/proc/${pid}/environ`);
        let launchId: string | undefined;
        for (let start = 0; start < environment.length;) {
          const end = environment.indexOf(0, start);
          const limit = end < 0 ? environment.length : end;
          if (environment.subarray(start, start + prefix.length).equals(prefix)) {
            launchId = environment.subarray(start + prefix.length, limit).toString('utf8').trim();
            break;
          }
          start = limit + 1;
        }
        if (!launchId || launchId.length > 512 || /[\x00-\x20]/.test(launchId)
          || (rec.launch_id && rec.launch_id !== launchId) || identity(pid) !== before) continue;
        result.push({ ...rec, launch_id: launchId });
      } catch { /* exited, inaccessible, or procfs raced: unknown, never prune */ }
    }
    return result;
  } catch { return []; }
}

/** Capture ownership while the launched wrapper is alive. The deployed hook
 * walks ancestors to this registry entry and preserves these launcher fields. */
export function captureLaunchBinding(pid: number | undefined, launchId: string): PidSessionEntry | undefined {
  if (!pid) return undefined;
  const entry = readLivePidSessionEntry(pid);
  return entry?.launchId === launchId ? structuredClone(entry) : undefined;
}

/** Completion consumes the hook's launcher-keyed registry update, never a
 * numeric-PID metadata guess. The hook PID can be any descendant of the wrapper.
 * Ownership was measured before exit; matching the unique launch and preserved
 * start timestamp prevents a reused slot from supplying another run's id. */
export function recordCompletedLaunch(binding: PidSessionEntry | undefined): void {
  if (!binding?.launchId || !hostProcessView()) return;
  const entry = readPidSessionEntry(binding.pid);
  if (!entry?.sessionId || entry.pid !== binding.pid || entry.launchId !== binding.launchId
    || entry.startedAtMs !== binding.startedAtMs || entry.agent !== binding.agent) return;
  const rec: HookSessionRecord = { session_id: entry.sessionId, pid: entry.pid, agent: entry.agent,
    launch_id: binding.launchId, terminal_id: binding.terminalId, ts: Date.now() / 1000, completed: true };
  try {
    fs.mkdirSync(hookSessionsDir(), { recursive: true });
    const name = createHash('sha256').update(binding.launchId).digest('hex');
    atomicWriteFileSync(path.join(hookSessionsDir(), `launch-${name}.json`), JSON.stringify(rec), 'utf8');
  } catch { /* completion must preserve the child exit status */ }
}

/**
 * Scan the hook state dir once and index every record by launch_id, terminal_id,
 * and pid. Returns empty maps if the dir is absent. Newest-by-`ts` wins a key
 * collision (pid reuse, or a launch id lingering from a since-dead process).
 */
export function loadHookSessionIndex(): HookSessionIndex {
  const byLaunchId = new Map<string, HookSessionRecord>();
  const byTerminalId = new Map<string, HookSessionRecord>();
  const byPid = new Map<number, HookSessionRecord>();
  let files: string[];
  try {
    files = fs.readdirSync(hookSessionsDir()).filter(f => f.endsWith('.json'));
  } catch {
    files = [];
  }
  for (const f of files) {
    let rec: HookSessionRecord | undefined;
    try {
      rec = parseRecord(fs.readFileSync(path.join(hookSessionsDir(), f), 'utf8'));
    } catch {
      /* raced with the hook / pruner — skip */
    }
    if (!rec) continue;
    if (!rec.completed && typeof rec.pid === 'number') keepNewest(byPid as Map<string | number, HookSessionRecord>, rec.pid, rec);
    if (rec.launch_id) keepNewest(byLaunchId as Map<string | number, HookSessionRecord>, rec.launch_id, rec);
    if (!rec.completed && rec.terminal_id) keepNewest(byTerminalId as Map<string | number, HookSessionRecord>, rec.terminal_id, rec);
  }
  // Deployed legacy hooks contain only a pid/session id. Join their targeted
  // records with launch facts instead of requiring a terminal_id they never
  // wrote. This is read-only: an observer cannot infer host PID liveness.
  for (const entry of listPidSessionEntries()) {
    if (!entry.launchId || pidSessionEntryMatchesLiveProcess(entry) !== true) continue;
    const rec: HookSessionRecord | undefined = entry.sessionId
      ? { session_id: entry.sessionId, pid: entry.pid, ts: entry.startedAtMs / 1000, agent: entry.agent }
      : readStateSessionRecord(entry.pid, entry.startedAtMs);
    if (!rec || !kindMatches(rec.agent, entry.agent)) continue;
    if (rec.launch_id && rec.launch_id !== entry.launchId) continue;
    const joined = { ...rec, agent: rec.agent ?? entry.agent, launch_id: entry.launchId, terminal_id: entry.terminalId };
    if (!byLaunchId.has(entry.launchId)) byLaunchId.set(entry.launchId, joined);
    if (!byPid.has(entry.pid)) byPid.set(entry.pid, joined);
    if (entry.terminalId && !byTerminalId.has(entry.terminalId)) byTerminalId.set(entry.terminalId, joined);
  }
  const recovered = new Map<string, HookSessionRecord | null>();
  for (const rec of liveUnregisteredHookRecords()) {
    if (!byPid.has(rec.pid)) byPid.set(rec.pid, rec);
    const previous = recovered.get(rec.launch_id!);
    // Inherited launch metadata cannot disambiguate two different native
    // sessions. Keep their exact PID identities but refuse the ambiguous join.
    recovered.set(rec.launch_id!, previous === null || (previous && previous.session_id !== rec.session_id) ? null : rec);
  }
  for (const [launchId, rec] of recovered) {
    if (rec && !byLaunchId.has(launchId)) byLaunchId.set(launchId, rec);
  }
  return { byLaunchId, byTerminalId, byPid };
}

/**
 * True if a hook record's `agent` is compatible with a `ps`-detected kind. Guards
 * the weak pid/children lookups against a STALE file at a reused pid (a dead
 * hooked agent's `<pid>.json` inherited by a live hookless agent at the same pid).
 * Permissive when the record's agent is absent/legacy-`unknown` (never reject on
 * missing metadata). Normalizes the one known naming gap: `ps` reports Cursor as
 * `cursor-agent`, the hook records it as `cursor`.
 */
function kindMatches(recordAgent: string | undefined, kind: string): boolean {
  if (!recordAgent || recordAgent === 'unknown') return true;
  const norm = (k: string) => (k === 'cursor-agent' ? 'cursor' : k);
  return norm(recordAgent) === norm(kind);
}

export interface ResolveOpts {
  pid: number;
  kind: string;
  launchId?: string;
  terminalId?: string;
  /** Immediate child pids of `pid` — the hook records under the agent pid, which
   *  for a wrapper/shell pid we recorded is a child. */
  childPids?: number[];
}

/**
 * Resolve an agent's OWN authoritative session id from the hook index. Priority
 * mirrors the session-tracker's getLiveSession: launchId join (survives pid
 * divergence — the hook runs under the agent pid, our registry entry may sit on a
 * tmux pane leaf or cmd.exe wrapper) → terminalId join → direct pid → children.
 * Every hit is kind-guarded so a stale file at a reused pid can't cross agents.
 * Undefined until the hook lands (it can lag the spawn) or for hookless harnesses.
 */
export function resolveHookSessionRecord(index: HookSessionIndex, opts: ResolveOpts): HookSessionRecord | undefined {
  const { pid, kind, launchId, terminalId, childPids } = opts;
  const take = (rec: HookSessionRecord | undefined): HookSessionRecord | undefined =>
    rec?.session_id && kindMatches(rec.agent, kind)
      && (!launchId || !rec.launch_id || rec.launch_id === launchId) ? rec : undefined;

  if (launchId) {
    const hit = take(index.byLaunchId.get(launchId));
    if (hit) return hit;
  }
  if (terminalId && !launchId) {
    const hit = take(index.byTerminalId.get(terminalId));
    if (hit) return hit;
  }
  const direct = take(index.byPid.get(pid));
  if (direct) return direct;
  for (const c of childPids ?? []) {
    const hit = take(index.byPid.get(c));
    if (hit) return hit;
  }
  return undefined;
}

/** The session id alone — see {@link resolveHookSessionRecord} for the full record
 *  (which also carries the SessionStart `ts` used to stamp `startedAtMs`). */
export function resolveHookSessionId(index: HookSessionIndex, opts: ResolveOpts): string | undefined {
  return resolveHookSessionRecord(index, opts)?.session_id;
}
