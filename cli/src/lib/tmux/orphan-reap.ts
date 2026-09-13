/**
 * Reap the helper processes an exited agent leaves behind (RUSH-2521).
 *
 * ## The leak
 *
 * An interactive agent runs as the leaf of a detached tmux pane
 * (`runInTmux` → `createSession`, [`../exec.ts`](../exec.ts)). Anything the
 * harness spawns — MCP servers, background daemons, `exec` helper trees — is a
 * child of that pane. When the agent exits, the kernel SIGHUPs the pane's
 * FOREGROUND process group only. A helper that put itself in its own process
 * group, or that ignores SIGHUP, survives: it reparents to init and keeps its
 * memory forever. Measured on the fleet: one pane holding 2.5 GB of Claude Code
 * background daemons 22 days after its session ended, and 34 orphaned
 * `cgraph-mcp --daemon` processes on a single worker.
 *
 * ## Why attribution is by ENVIRONMENT, not by pid ancestry / tty / pgid
 *
 * Every obvious OS handle is destroyed by exactly the event we are detecting:
 *
 * - **ppid ancestry** — an orphan is reparented to init the instant its parent
 *   dies, so the chain back to the pane is gone.
 * - **controlling terminal** — POSIX disassociates the controlling terminal from
 *   every process in a session when the session leader exits, so the orphan's
 *   `tty` reads `?`. Verified on Linux: an orphan under a dead pane leader shows
 *   `tty=?` while its own pane still reports `pane_tty=/dev/pts/6`.
 * - **process group** — the helpers that survive are precisely the ones that
 *   left the pane's process group (that is why they survived the SIGHUP).
 * - **POSIX session id** — durable and correct, but not portable: `ps -o sid=`
 *   exists on Linux and does not exist on macOS (`ps: sid: keyword not found`),
 *   `ps -o sess=` reports 0 there, and `pgrep -s` is Linux-only.
 *
 * What DOES survive all of it is the process environment. `runInTmux` stamps
 * `AGENT_TMUX_SESSION_NAME` into the pane env ([`../exec.ts`](../exec.ts)), and
 * every descendant inherits it — including a reparented one. So a process
 * carrying `AGENT_TMUX_SESSION_NAME=<name>` is attributable to that tmux session
 * with no heuristics at all, and tmux itself is the liveness oracle for whether
 * that session's agent is still running.
 *
 * ## The second tier: harness daemons that scrub the environment
 *
 * Claude Code's background pool (`claude … daemon run`, which owns the
 * `bg-pty-host` / `bg-spare` processes) starts with a clean environment, so tier
 * one cannot see it. It does, however, declare its owner in its own argv:
 * `daemon run --origin transient --spawned-by {"label":"claude",…,"pid":3834601}`.
 * A pool whose declared spawner pid is dead is unowned, so it and its descendants
 * are reaped. That rule lives in {@link DETACHED_HELPER_RULES} rather than an
 * inline `if (agent === 'claude')`, so another harness that detaches helpers the
 * same way is one table entry.
 *
 * ## Safety
 *
 * Nothing is killed without positive proof its owner is gone:
 *
 * - a tmux session that still exists AND whose agent pane process is alive
 *   protects every process it owns;
 * - a tmux session with a client attached protects every process it owns,
 *   whatever the pane state;
 * - the reaping process itself, its ancestors, pid 1, and every long-lived
 *   agents-cli service ({@link isProtectedAgentsService}) are never candidates.
 * - an UNRELIABLE read of tmux's session state (the query threw, timed out, or
 *   tmux itself never answered) disables tier 1 for that sweep entirely;
 * - an absent session entry is unknown, even after a reliable read. A tmux
 *   server restart can produce the same empty snapshot while marked agents
 *   remain alive, so tier 1 requires a present owner with positive death proof.
 * - tier 2 is anchored on the actual claude EXECUTABLE (argv[0]'s basename),
 *   never a substring match anywhere in the command line, and excludes any
 *   process still structurally part of a LIVE pane leaf's process tree right
 *   now (tmux's own `#{pane_pid}`, expanded to its current descendants —
 *   independent of whether any of those processes' environment markers were
 *   ever readable) or that carries a marker whose own session is
 *   live/attached — a live interactive agent, OR a subprocess it spawns
 *   (e.g. its own Bash tool invoking `claude --print "…"` as a sub-task),
 *   whose argv happens to quote this file's docblock (it contains the exact
 *   `daemon run --spawned-by {"pid":...}` shape) must never become a kill
 *   seed, and that has to hold even where tier 1's marker is dead (macOS, or
 *   any `claude` invocation started outside an agents-cli pane). Two review
 *   rounds found this: first that marker-only exclusion left the whole
 *   macOS/bare-invocation case open (round 2, closed by the pane-pid check),
 *   then that the pane-pid check alone only covered the pane LEAF itself, not
 *   its own live children (round 3, closed by expanding the check to the
 *   leaf's current descendant set via {@link descendantsOf}). A process that
 *   has genuinely reparented away — a real detached daemon, no longer chained
 *   to any live leaf by ppid — is deliberately NOT in that set and remains
 *   reapable, whatever unrelated live agent happens to also be running.
 *
 * ## Known platform gap — tier 1 is Linux-only today
 *
 * Tier 1's env-marker attribution requires reading another process's
 * environment. `/proc/<pid>/environ` makes that a plain file read on Linux.
 * macOS has no `/proc`; `ps -E` was the fallback, but on modern macOS (verified
 * live on mac-mini 15.6, macOS Sequoia) `ps -E` no longer prints another
 * process's environment at all — only the CALLING process's own env shows up.
 * `readAgentProcesses()` therefore returns every macOS process with
 * `tmuxSession: undefined`, and tier 1's `if (!p.tmuxSession) continue` skips
 * all of them. This is SAFE (tier 1 silently no-ops rather than misattributing
 * anything) but not effective: on macOS, only tier 2 — the detached-helper
 * registry — can reap anything today. A macOS fix needs a different channel
 * entirely (env is inherently unreadable cross-process there without a native
 * helper); it is not a parsing bug {@link parseTmuxSessionMarker} can fix.
 */

import { execFile } from 'child_process';
import * as fsp from 'fs/promises';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Ceiling on the `ps` snapshot so a wedged `ps` can never stall the daemon tick. */
const PS_TIMEOUT_MS = 10_000;

/**
 * Ceiling on a single tmux pane-owner query. Without this a wedged tmux server
 * hangs `readPaneOwners` forever, which — before this bound existed — could
 * only be told apart from "genuinely no sessions" by the caller giving up and
 * treating it as empty (RUSH-2521 review: exactly the failure mode that let a
 * flaky tick select every marked process on the box as orphaned).
 */
const TMUX_QUERY_TIMEOUT_MS = 10_000;

/** Grace between SIGTERM and SIGKILL for a reaped orphan. */
const REAP_GRACE_MS = 2_000;

/** Env var `runInTmux` stamps into the pane, inherited by every descendant. */
export const TMUX_SESSION_ENV = 'AGENT_TMUX_SESSION_NAME';

/** One process, with the fields the reaper attributes on. */
export interface AgentProcess {
  pid: number;
  ppid: number;
  /** Full command line (`ps -o args=`). */
  args: string;
  /** Value of {@link TMUX_SESSION_ENV} inherited from the pane, when present. */
  tmuxSession?: string;
}

/** Liveness of the tmux session that owns a set of processes. */
export interface PaneOwner {
  /** The session's agent pane process is still running. */
  agentAlive: boolean;
  /** A client is attached to the session — a human is looking at it. */
  attached: boolean;
}

/** Why a process was selected, for human output and tests. */
type OrphanReason = 'tmux-agent-exited' | 'detached-helper';

interface OrphanCandidate {
  pid: number;
  args: string;
  reason: OrphanReason;
  /** Owning tmux session, when the process carried the marker. */
  tmuxSession?: string;
}

interface OrphanReapResult {
  /** Processes signalled (SIGTERM, escalated to SIGKILL when they ignore it). */
  killed: number;
  /** One human-readable line per reaped process. */
  details: string[];
  /** Selected candidates, whether or not they were killed (`dryRun`). */
  candidates: OrphanCandidate[];
  /**
   * Non-fatal observations worth logging — e.g. "tier 1 skipped this sweep:
   * a tmux query failed" (see {@link selectOrphanProcesses}'s `ownersReliable`).
   * Never gates the reap; it only explains why fewer candidates were found.
   */
  warnings: string[];
}

/**
 * A harness that detaches helper daemons from the session environment, and the
 * pid it records as their owner.
 *
 * Registry rather than per-agent branches: a second harness with the same shape
 * is one entry, and the completeness of the table is what a reviewer checks.
 */
interface DetachedHelperRule {
  /** Harness id, for the reap detail line. */
  agent: string;
  /** Owner pid the helper declares in its own argv, or undefined when it is not this rule's process. */
  spawnerPid(args: string): number | undefined;
}

/**
 * Basename of argv[0] — the actual executable a process runs, not whatever
 * text later argv tokens happen to contain. `ps -o args=` gives one opaque
 * command-line string (no reliable per-token quoting to split on), so this
 * takes the first whitespace-delimited run and strips its directory prefix.
 */
function argv0Basename(args: string): string {
  const m = /^\s*(\S+)/.exec(args);
  const token = m ? m[1] : '';
  const base = token.split(/[\\/]/).pop() ?? '';
  return base.toLowerCase();
}

/**
 * Claude Code's background daemon pool. Its argv carries a JSON `--spawned-by`
 * blob naming the claude process that started it, e.g.
 * `claude.exe daemon run --origin transient --spawned-by {"label":"claude","cwd":"/…","pid":3834601}`.
 * The `bg-pty-host` / `bg-spare` workers are its children and are reaped as
 * descendants rather than matched individually — they carry no owner of their own.
 *
 * Anchored on argv[0]'s basename, not a substring match anywhere in the full
 * command line: `daemon\s+run` and `--spawned-by\s+.*"pid"\s*:\s*(\d+)` both
 * appear verbatim in THIS FILE's own docblock above, so a `grep`, `cat`, or
 * pager viewing `orphan-reap.ts` — or a coding agent whose tool-call argv
 * quotes this review's own bug report — matched the old substring-only rule
 * and became a kill seed for its whole process subtree (RUSH-2521 review,
 * reproduced against the exact diff text). Only a process whose real
 * executable is `claude`/`claude.exe` can seed this rule now.
 */
const CLAUDE_BG_DAEMON: DetachedHelperRule = {
  agent: 'claude',
  spawnerPid(args: string): number | undefined {
    const exe = argv0Basename(args);
    if (exe !== 'claude' && exe !== 'claude.exe') return undefined;
    if (!/\bdaemon\s+run\b/.test(args)) return undefined;
    const m = /--spawned-by\s+.*?"pid"\s*:\s*(\d+)/.exec(args);
    if (!m) return undefined;
    const pid = parseInt(m[1], 10);
    return Number.isFinite(pid) && pid > 1 ? pid : undefined;
  },
};

export const DETACHED_HELPER_RULES: DetachedHelperRule[] = [CLAUDE_BG_DAEMON];

/**
 * Long-lived agents-cli services that must never be reaped, even when they
 * inherited a pane's environment because the CLI invocation that started them
 * happened to run inside an agent pane.
 *
 * This is a safety invariant, not a fallback: the routines daemon runs this very
 * reaper, so killing it would make the reaper delete its own executor, and the
 * secrets broker holds the keychain session every live agent depends on.
 */
export function isProtectedAgentsService(args: string): boolean {
  return /\b__daemon-run\b/.test(args)
    || /\bsecrets\s+_agent-run\b/.test(args)
    || /\bAGI Menu\b/.test(args)
    || /\bAgents CLI\.app\b/.test(args);
}

/** Is this pid currently running? Signal-0 probe, matching `platform/process.ts`. */
function livePid(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user — alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Pure. Select the processes whose owning agent is provably gone.
 *
 * `owners` maps a tmux session name to its liveness. An ABSENT name is never
 * proof that the marked process is orphaned: the tmux server can restart or its
 * socket can disappear while the pane's process tree is still alive. That exact
 * state made the daemon classify every live agent as `tmux-session-gone` and
 * SIGTERM it on startup (RUSH-2603). Tier 1 therefore requires a PRESENT owner
 * whose pane process is confirmed dead and has no attached client. A reliable
 * empty map means "nothing proven dead", not "every marked process is dead".
 * `opts.ownersReliable` still disables tier 1 when any query failed to answer.
 */
export function selectOrphanProcesses(
  procs: AgentProcess[],
  owners: Map<string, PaneOwner>,
  opts: {
    protectedPids: Set<number>;
    isAlive?: (pid: number) => boolean;
    ownersReliable?: boolean;
    /**
     * Every pane leaf pid tmux itself currently reports (see
     * {@link parsePanePids}) — marker-independent, so it protects a live pane
     * leaf process even when {@link TMUX_SESSION_ENV} was never readable for
     * it (tier 1 is dead on macOS by design; a bare `claude` invocation
     * outside an agents-cli-managed pane never carries the marker either).
     * Without this, a live interactive agent whose OWN argv happened to
     * quote {@link DETACHED_HELPER_RULES}'s match pattern (this file's own
     * docblock does) could seed tier 2 the moment its marker was unreadable
     * — the exact residual gap the executable anchor alone did not close
     * (RUSH-2521 review, round 2).
     */
    livePanePids?: Set<number>;
  },
): OrphanCandidate[] {
  const isAlive = opts.isAlive ?? livePid;
  const ownersReliable = opts.ownersReliable ?? true;
  const eligible = (p: AgentProcess): boolean =>
    p.pid > 1 && !opts.protectedPids.has(p.pid) && !isProtectedAgentsService(p.args);
  /**
   * Every pid STILL reachable, right now, from a live pane leaf through ppid
   * links — not just the leaf itself. A live agent's own child (e.g. a Bash
   * tool spawning `claude --print "…daemon run --spawned-by…"` as a
   * sub-invocation) inherits nothing from `livePanePids` (that set only ever
   * contains the leaf's own pid) unless we walk the tree, and on macOS that
   * child ALSO carries no readable env marker (tier 1 is dead there) — so
   * without this expansion, the "must never become a kill seed, whatever its
   * own argv says" guarantee only held for the leaf itself, not the live
   * agent's actual subprocess tree the same docblock's threat model names
   * (RUSH-2521 review, round 3). A process that has genuinely reparented away
   * (a real detached daemon, ppid now 1 or otherwise no longer chained to the
   * leaf) is NOT in this set and remains reapable — this only protects what
   * is still structurally part of the live agent's own tree right now.
   */
  const livePaneSubtree = opts.livePanePids && opts.livePanePids.size > 0
    ? new Set(descendantsOf(procs, [...opts.livePanePids]))
    : undefined;
  /**
   * A process still owned by a live/attached pane can never seed a kill,
   * whatever its own argv says. Two independent signals, either sufficient:
   * the process is still IN a live pane leaf's process tree right now (tmux's
   * own data, no marker needed), or it carries a marker whose session is
   * live/attached.
   */
  const ownedByLivePane = (p: AgentProcess): boolean => {
    if (livePaneSubtree?.has(p.pid)) return true;
    if (!p.tmuxSession) return false;
    const owner = owners.get(p.tmuxSession);
    return !!owner && (owner.agentAlive || owner.attached);
  };

  const out: OrphanCandidate[] = [];
  const seen = new Set<number>();
  const push = (p: AgentProcess, reason: OrphanReason): void => {
    if (seen.has(p.pid)) return;
    seen.add(p.pid);
    out.push({ pid: p.pid, args: p.args, reason, tmuxSession: p.tmuxSession });
  };

  // Tier 1 — inherited pane marker with a dead owner. Skipped whole when the
  // owners read is unreliable (see the docstring above).
  if (ownersReliable) {
    for (const p of procs) {
      if (!p.tmuxSession || !eligible(p)) continue;
      const owner = owners.get(p.tmuxSession);
      if (!owner) continue;
      // An attached client or a live agent pane process is a hard exclusion.
      if (owner.attached || owner.agentAlive) continue;
      push(p, 'tmux-agent-exited');
    }
  }

  // Tier 2 — a detached helper daemon whose declared spawner is dead, plus the
  // workers it owns. Its own descendants are pulled in because they carry no
  // owner declaration of their own. A candidate seed that still carries a
  // LIVE/attached pane marker is excluded even if its argv matches a rule: it
  // is provably not a detached daemon, whatever text its command line quotes.
  const seeds: AgentProcess[] = [];
  for (const p of procs) {
    if (!eligible(p) || ownedByLivePane(p)) continue;
    for (const rule of DETACHED_HELPER_RULES) {
      const spawner = rule.spawnerPid(p.args);
      if (spawner === undefined || isAlive(spawner)) continue;
      seeds.push(p);
      break;
    }
  }
  if (seeds.length > 0) {
    const byPid = new Map(procs.map(p => [p.pid, p]));
    for (const seed of descendantsOf(procs, seeds.map(s => s.pid))) {
      const p = byPid.get(seed);
      if (p && eligible(p)) push(p, 'detached-helper');
    }
  }

  return out;
}

/**
 * Pure. `seeds` plus every process reachable from them through ppid links.
 * Depth is bounded by the table size, so a ppid cycle (which the kernel cannot
 * produce, but a malformed snapshot could) terminates.
 */
export function descendantsOf(procs: AgentProcess[], seeds: number[]): number[] {
  const children = new Map<number, number[]>();
  for (const p of procs) {
    const list = children.get(p.ppid);
    if (list) list.push(p.pid);
    else children.set(p.ppid, [p.pid]);
  }
  const out: number[] = [];
  const seen = new Set<number>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  return out;
}

/** Pure. Parse `ps -A -o pid=,ppid=,args=` output. */
export function parseProcessRows(stdout: string): AgentProcess[] {
  const rows: AgentProcess[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const ppid = parseInt(m[2], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    rows.push({ pid, ppid, args: m[3].trim() });
  }
  return rows;
}

/**
 * Pure. Extract the pane marker from a blob that contains the process
 * environment — a NUL-separated `/proc/<pid>/environ` on Linux, or the
 * space-separated `KEY=VALUE` tail macOS `ps -E` appends after the command.
 * Session names are `[A-Za-z0-9_-]` ({@link ../tmux/session.ts} `VALID_NAME`),
 * so the value ends at the first character outside that set.
 */
export function parseTmuxSessionMarker(blob: string): string | undefined {
  const m = new RegExp(`(?:^|[\\s\\0])${TMUX_SESSION_ENV}=([A-Za-z0-9_-]{1,64})`).exec(blob);
  return m ? m[1] : undefined;
}

/** Pure. Parse `tmux list-panes -a -F '#{session_name}\t#{pane_pid}\t#{session_attached}'`. */
export function parsePaneOwners(stdout: string, isAlive: (pid: number) => boolean = livePid): Map<string, PaneOwner> {
  const owners = new Map<string, PaneOwner>();
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split('\t');
    if (parts.length < 3) continue;
    const name = parts[0];
    if (!name) continue;
    const panePid = parseInt(parts[1], 10);
    const attached = parts[2].trim() !== '0';
    const prev = owners.get(name);
    const agentAlive = Number.isFinite(panePid) && isAlive(panePid);
    owners.set(name, {
      agentAlive: (prev?.agentAlive ?? false) || agentAlive,
      attached: (prev?.attached ?? false) || attached,
    });
  }
  return owners;
}

/**
 * Pure. Every `#{pane_pid}` tmux reports in the same `list-panes -a` output
 * {@link parsePaneOwners} reads — a pid tmux itself says is a pane's leaf
 * process, independent of whether that process's OWN environment is readable.
 *
 * This is the marker-independent half of pane ownership: {@link parsePaneOwners}
 * answers "is SESSION X owned" by aggregating over every pane a session has;
 * this answers "is PID N itself a pane leaf tmux currently tracks" for exactly
 * one candidate pid, with no dependency on {@link TMUX_SESSION_ENV} ever having
 * been readable for it.
 */
export function parsePanePids(stdout: string): Set<number> {
  const pids = new Set<number>();
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split('\t');
    if (parts.length < 2) continue;
    const pid = parseInt(parts[1], 10);
    if (Number.isFinite(pid)) pids.add(pid);
  }
  return pids;
}

/**
 * Snapshot the process table with each process's pane marker.
 *
 * Two readers because no single command works on both platforms: Linux exposes
 * `/proc/<pid>/environ` (one cheap read per pid), while macOS has no `/proc` and
 * instead lets `ps -E` print a process's own-uid environment after its command
 * — though on modern macOS `ps -E` no longer includes it at all (see the
 * "Known platform gap" section in this file's docblock); tier 1 safely no-ops
 * there rather than misattributing anything. Windows has no tmux integration
 * at all, so it returns an empty table rather than pretending to reap.
 *
 * `opts.pids` restricts the `ps` snapshot to an explicit pid allowlist instead
 * of the whole machine (`-A`) — a test-only escape hatch so a reap exercised
 * against real spawned processes can never select or signal a real, unrelated
 * process on a shared box (RUSH-2521 review: the integration tests previously
 * called the machine-wide reap directly, which is safe only by construction of
 * the fixture, not by anything the reaper itself guarantees).
 */
export async function readAgentProcesses(opts: { pids?: number[] } = {}): Promise<AgentProcess[]> {
  if (process.platform === 'win32') return [];
  const scope = opts.pids && opts.pids.length > 0 ? ['-p', opts.pids.join(',')] : ['-A'];
  // Async /proc reads — this runs on the daemon's tmux-reap tick, so a sync scan
  // of the whole process table's environ files would freeze the loop (PHNX-3695).
  const hasProc = await fsp.access('/proc/self/environ').then(() => true, () => false);
  const args = hasProc ? [...scope, '-o', 'pid=,ppid=,args='] : [...scope, '-E', '-o', 'pid=,ppid=,args='];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ps', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: PS_TIMEOUT_MS }));
  } catch {
    return [];
  }
  const rows = parseProcessRows(stdout);
  if (!hasProc) {
    // `ps -E` already appended the environment to the args column.
    for (const row of rows) row.tmuxSession = parseTmuxSessionMarker(row.args);
    return rows;
  }
  for (const row of rows) {
    let blob: string;
    try {
      blob = await fsp.readFile(`/proc/${row.pid}/environ`, 'utf8');
    } catch {
      continue; // exited between ps and the read, or not ours to inspect
    }
    row.tmuxSession = parseTmuxSessionMarker(blob);
  }
  return rows;
}

/** One socket's pane-ownership read. `ok: false` means tmux never actually answered. */
interface PaneOwnersRead {
  /**
   * `true` when tmux completed the query (whatever its exit code — a nonzero
   * exit from `list-panes -a` IS tmux affirmatively answering "no server /
   * no sessions here", a real and trustworthy empty result). `false` means the
   * query never got that far: a thrown error, a timeout, or a missing/wrong
   * tmux — in which case `owners` carries no information and must not be
   * trusted as "no sessions".
   */
  ok: boolean;
  owners: Map<string, PaneOwner>;
  /** Every pane leaf pid tmux reported, marker-independent (see {@link parsePanePids}). */
  panePids: Set<number>;
}

/**
 * Read one tmux socket's session-ownership state.
 *
 * Distinguishes "tmux answered: nothing here" from "tmux did not answer" —
 * the two were previously conflated (`.catch(() => null)` then `!res` folded
 * into the same empty-map return as a clean nonzero exit), which meant a
 * missing/wrong-version tmux, a spawn failure, or a wedged server were
 * indistinguishable from a genuinely empty box. A completed process — even a
 * nonzero exit — is a real answer; a rejected promise is not an answer at all
 * (RUSH-2521 review).
 */
export async function readPaneOwners(socket: string): Promise<PaneOwnersRead> {
  // No socket file at all means no server was ever started here — for the
  // shared agents socket this is reliable (tmux unlinks its own socket on
  // exit), so this is a confident, reliable EMPTY read, not an unknown one.
  if (!(await fsp.access(socket).then(() => true, () => false))) return { ok: true, owners: new Map(), panePids: new Set() };
  const { runTmux } = await import('./binary.js');
  try {
    const res = await runTmux({
      socket,
      args: ['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}\t#{session_attached}'],
      throwOnError: false,
      timeoutMs: TMUX_QUERY_TIMEOUT_MS,
    });
    // A completed run answered, whatever its exit code — tmux itself is
    // telling us there's no server/no sessions on a nonzero exit here.
    if (res.code !== 0) return { ok: true, owners: new Map(), panePids: new Set() };
    return { ok: true, owners: parsePaneOwners(res.stdout), panePids: parsePanePids(res.stdout) };
  } catch {
    // Threw: tmux missing/unsupported version (assertTmuxAvailable), a spawn
    // failure, or the query timed out. We genuinely do not know.
    return { ok: false, owners: new Map(), panePids: new Set() };
  }
}

/**
 * Ownership across every socket that could own a marked process, merged so a
 * session that is live on ANY of them protects its processes. `reliable` is
 * `false` the moment ANY queried socket's read failed — the merged map could
 * then be missing entries for sessions that live there, so a caller MUST NOT
 * treat an absent key in it as proof of anything.
 *
 * The union is load bearing, not defensive: the process table is machine-wide,
 * so a reap driven from a non-default socket (`agents sessions reap --socket`,
 * or a test's temp socket) would otherwise see every real agent's marker with no
 * matching session and classify a whole box's live helpers as orphans.
 */
async function readAllPaneOwners(
  socket: string,
): Promise<{ owners: Map<string, PaneOwner>; panePids: Set<number>; reliable: boolean }> {
  const { getDefaultSocketPath } = await import('./paths.js');
  const merged = new Map<string, PaneOwner>();
  const panePids = new Set<number>();
  let reliable = true;
  for (const sock of new Set([socket, getDefaultSocketPath()].filter(Boolean))) {
    const read = await readPaneOwners(sock);
    reliable = reliable && read.ok;
    for (const pid of read.panePids) panePids.add(pid);
    for (const [name, owner] of read.owners) {
      const prev = merged.get(name);
      merged.set(name, {
        agentAlive: (prev?.agentAlive ?? false) || owner.agentAlive,
        attached: (prev?.attached ?? false) || owner.attached,
      });
    }
  }
  return { owners: merged, panePids, reliable };
}

/** Pids the reaper must never signal: itself and its whole ancestor chain. */
function selfProtectedPids(procs: AgentProcess[]): Set<number> {
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const out = new Set<number>([process.pid]);
  let cursor = process.ppid;
  // Bounded by the table size — an ancestor walk cannot exceed it.
  for (let i = 0; i <= procs.length && cursor > 1; i += 1) {
    out.add(cursor);
    cursor = byPid.get(cursor)?.ppid ?? 0;
  }
  return out;
}

/** SIGTERM every candidate, then SIGKILL whatever ignored it. */
async function terminate(candidates: OrphanCandidate[], graceMs: number): Promise<number> {
  let signalled = 0;
  for (const c of candidates) {
    try {
      process.kill(c.pid, 'SIGTERM');
      signalled += 1;
    } catch { /* already gone */ }
  }
  if (signalled === 0) return 0;
  await new Promise(resolve => setTimeout(resolve, graceMs));
  for (const c of candidates) {
    if (!livePid(c.pid)) continue;
    try { process.kill(c.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  return signalled;
}

function describe(c: OrphanCandidate): string {
  const where = c.tmuxSession ? ` [${c.tmuxSession}]` : '';
  return `pid ${c.pid}${where} (${c.reason}): ${c.args.slice(0, 120)}`;
}

/**
 * Reap every helper process whose owning agent has exited.
 *
 * Called from the daemon's periodic tick and from `agents sessions reap`. Panes
 * are read before processes to take one ownership snapshot. A session absent
 * from that snapshot is unknown and is never sufficient proof for tier 1.
 *
 * `opts.pids` is the test-only process-table scope described on
 * {@link readAgentProcesses} — never set by production callers.
 */
export async function reapOrphanAgentProcesses(
  opts: { socket: string; dryRun?: boolean; graceMs?: number; pids?: number[] } = { socket: '' },
): Promise<OrphanReapResult> {
  const result: OrphanReapResult = { killed: 0, details: [], candidates: [], warnings: [] };
  if (process.platform === 'win32') return result;

  const { owners, panePids, reliable } = await readAllPaneOwners(opts.socket);
  if (!reliable) {
    result.warnings.push('tier 1 (pane-marker) sweep skipped this tick: a tmux session query failed to answer');
  }
  const procs = await readAgentProcesses({ pids: opts.pids });
  if (procs.length === 0) return result;

  const candidates = selectOrphanProcesses(procs, owners, {
    protectedPids: selfProtectedPids(procs),
    ownersReliable: reliable,
    livePanePids: panePids,
  });
  result.candidates = candidates;
  if (candidates.length === 0) return result;

  result.details = candidates.map(describe);
  if (opts.dryRun) return result;
  result.killed = await terminate(candidates, opts.graceMs ?? REAP_GRACE_MS);
  return result;
}

/**
 * Reap the helper processes belonging to ONE tmux session, on the teardown path.
 *
 * `killSession` calls this so an agent's helpers die with the session that owned
 * them instead of waiting for the next daemon tick. The tmux session is being
 * destroyed by the caller, so ownership needs no liveness check — anything still
 * carrying this session's marker is leftover by definition, PROVIDED the name
 * is unique to the socket in play.
 *
 * `socket` narrows that: a session name is only unique WITHIN one tmux server,
 * so the exact same marker value could legitimately belong to a live, unrelated
 * session on a DIFFERENT socket (e.g. the shared agents socket vs. a test's own
 * temp socket). When `socket` names a non-default socket, this checks the
 * default agents socket for a live/attached session of the same name and backs
 * off entirely if one exists — the caller is tearing down one session, not a
 * same-named one it does not own.
 *
 * `opts.pids` is the test-only process-table scope described on
 * {@link readAgentProcesses} — never set by production callers.
 */
export async function reapProcessesForTmuxSession(
  name: string,
  socket?: string,
  opts: { dryRun?: boolean; graceMs?: number; pids?: number[] } = {},
): Promise<OrphanReapResult> {
  const result: OrphanReapResult = { killed: 0, details: [], candidates: [], warnings: [] };
  if (process.platform === 'win32') return result;

  const { getDefaultSocketPath } = await import('./paths.js');
  const defaultSocket = getDefaultSocketPath();
  if (socket && socket !== defaultSocket) {
    const elsewhere = await readPaneOwners(defaultSocket);
    const owner = elsewhere.owners.get(name);
    if (owner && (owner.agentAlive || owner.attached)) {
      result.warnings.push(`skipped: "${name}" is a live session on the agents socket, not the one being torn down`);
      return result;
    }
  }

  const procs = await readAgentProcesses({ pids: opts.pids });
  if (procs.length === 0) return result;

  const protectedPids = selfProtectedPids(procs);
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const owned = procs.filter(p => p.tmuxSession === name);
  // Descendants too: a helper that scrubbed its own environment (so it carries
  // no marker) is still attributable through the marked process that spawned it.
  const candidates: OrphanCandidate[] = [];
  for (const pid of descendantsOf(procs, owned.map(p => p.pid))) {
    const p = byPid.get(pid);
    if (!p || p.pid <= 1 || protectedPids.has(p.pid) || isProtectedAgentsService(p.args)) continue;
    candidates.push({ pid: p.pid, args: p.args, reason: 'tmux-agent-exited', tmuxSession: name });
  }
  result.candidates = candidates;
  if (candidates.length === 0) return result;

  result.details = candidates.map(describe);
  if (opts.dryRun) return result;
  result.killed = await terminate(candidates, opts.graceMs ?? REAP_GRACE_MS);
  return result;
}
