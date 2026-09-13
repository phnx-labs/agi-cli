/**
 * Session highlight extractors.
 *
 * Pure derivations over a session's `SessionEvent[]` that power the "what did
 * this session use and produce" sections of both renders of a session — the
 * picker quick preview (`sessions-picker.ts`) and the full summary
 * (`render.ts`). One module, two consumers, so the panes never drift.
 *
 * Skills/hooks/links are no-I/O. `extractRepos` touches the filesystem (a
 * bounded `.git` walk over a handful of candidate dirs) and is the only
 * non-pure function here.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionAgentId, SessionEvent } from './types.js';
import { isNoisePath, type FileChange } from './digest.js';

// ── Skills ────────────────────────────────────────────────────────────────────

export interface SkillUse {
  name: string;
  count: number;
}

/**
 * The tool name a harness uses to invoke a skill, keyed by `SessionAgentId` —
 * a registry, not a single hardcoded string, so a harness whose transcript
 * names the tool differently is one table row away from support instead of a
 * near-identical `if` arm (see CLAUDE.md's registry-over-if-chain convention).
 *
 * Verified entries only: Claude and Kimi both empirically name the tool
 * `Skill` (a plugin-provided skill rides the same tool). No other harness has
 * a confirmed skill-invocation tool name in this codebase's fixtures — an
 * absent entry means "we don't know yet", not "this harness has no skills";
 * extractSkills yields `[]` for it rather than guessing a name and silently
 * mismatching (or worse, matching a coincidental tool with the same name).
 */
const SKILL_TOOL_NAME_BY_AGENT: Partial<Record<SessionAgentId, string>> = {
  claude: 'Skill',
  kimi: 'Skill',
};

/**
 * True for a tool_use event that is that harness's skill-invocation call (see
 * {@link SKILL_TOOL_NAME_BY_AGENT}). Exported so an INCREMENTAL parser
 * (discover.ts's ClaudeParseState/foldDerivedToolState) can select matching
 * events into a small held array as it streams, then run {@link extractSkills}
 * over just that subset at finalize — without re-parsing the whole transcript.
 */
export function isSkillInvocation(e: SessionEvent): boolean {
  if (e.type !== 'tool_use' || e._local) return false;
  const skillTool = SKILL_TOOL_NAME_BY_AGENT[e.agent];
  return !!skillTool && e.tool === skillTool;
}

/**
 * Skills invoked during the session, from that harness's skill-invocation
 * tool calls (see {@link SKILL_TOOL_NAME_BY_AGENT}). Carries the skill id in
 * `args.skill` (or `args.name`). Sorted by count desc, then name.
 */
export function extractSkills(events: SessionEvent[]): SkillUse[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (!isSkillInvocation(e)) continue;
    const name = e.args?.skill ?? e.args?.name;
    if (typeof name !== 'string' || !name.trim()) continue;
    const key = name.trim();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// ── Slash commands ────────────────────────────────────────────────────────────

interface SlashCommandUse {
  /** WITH the leading slash, e.g. `/recap`, `/code:commit` — matches SessionEvent.slashCommand's shape. */
  name: string;
  count: number;
}

/**
 * Slash commands invoked during the session — either the user typing one
 * (Claude's `<command-name>` wrapper) or the model invoking one via the
 * `SlashCommand` tool (`SessionEvent.slashCommand`, populated by
 * `parseClaudeContent` for both sources — see session/prompt.ts). Sorted by
 * count desc, then name.
 */
export function extractSlashCommands(events: SessionEvent[]): SlashCommandUse[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (!e.slashCommand) continue;
    counts.set(e.slashCommand, (counts.get(e.slashCommand) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

interface HookUse {
  /** Hook name as configured, e.g. `SessionStart:startup`. */
  name: string;
  /** Lifecycle event, e.g. `SessionStart`. */
  event?: string;
  /** How many times it fired. */
  count: number;
  /** How many firings failed (non-`hook_success` records). */
  failed: number;
}

/**
 * Hooks that fired during the session, folded from `hook` events (parsed from
 * Claude's `hook_success`/`hook_error`/… attachment records; other harnesses
 * don't record firings in their transcripts, so they yield an empty list).
 * Sorted by count desc, then name.
 */
export function extractHooks(events: SessionEvent[]): HookUse[] {
  const byName = new Map<string, HookUse>();
  for (const e of events) {
    if (e.type !== 'hook') continue;
    const name = e.hookName?.trim() || e.hookEvent?.trim() || 'hook';
    const existing = byName.get(name);
    if (existing) {
      existing.count++;
      if (e.success === false) existing.failed++;
    } else {
      byName.set(name, {
        name,
        event: e.hookEvent,
        count: 1,
        failed: e.success === false ? 1 : 0,
      });
    }
  }
  return [...byName.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// ── Links ─────────────────────────────────────────────────────────────────────

type LinkKind = 'linear' | 'jira' | 'github' | 'gitlab' | 'other';
interface SessionLink {
  kind: LinkKind;
  url: string;
  /** Short display label: `RUSH-2076`, `PR#1755`, `owner/repo#123`, host. */
  label: string;
}

/** Bare URL scan over message text; trailing punctuation stripped. Backticks
 * and ellipses excluded so markdown-wrapped or truncated URLs don't leak in. */
const URL_RE = /https?:\/\/[^\s"'`()<>\]\\…]+/g;

/** A routable host: dotted domain (optionally :port). localhost/IPs-of-one-segment
 * and markdown garbage (`…`) are not Links-section material. */
const HOST_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(:\d+)?$/i;

function classifyLink(url: string): SessionLink | undefined {
  let m: RegExpMatchArray | null;
  // Linear: https://linear.app/<workspace>/issue/RUSH-2076/slug
  if ((m = url.match(/https?:\/\/linear\.app\/[\w-]+\/issue\/([A-Z]{2,6}-\d+)/))) {
    return { kind: 'linear', url, label: m[1] };
  }
  // Jira: https://<host>.atlassian.net/browse/PROJ-123 (or /jira/browse/)
  if ((m = url.match(/https?:\/\/[\w.-]*(?:atlassian\.net|jira[\w.-]*)\/browse\/([A-Z]{2,10}-\d+)/))) {
    return { kind: 'jira', url, label: m[1] };
  }
  // GitHub: PR / issue / repo
  if ((m = url.match(/https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/))) {
    return { kind: 'github', url, label: `PR#${m[2]}` };
  }
  if ((m = url.match(/https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/))) {
    return { kind: 'github', url, label: `${m[1]}#${m[2]}` };
  }
  if ((m = url.match(/https?:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/))) {
    return { kind: 'github', url, label: m[1] };
  }
  // GitLab: MR / issue
  if ((m = url.match(/https?:\/\/(gitlab\.com|[\w.-]*gitlab[\w.-]*)\/(.+?)\/-\/merge_requests\/(\d+)/))) {
    return { kind: 'gitlab', url, label: `${m[2]}!${m[3]}` };
  }
  if ((m = url.match(/https?:\/\/(gitlab\.com|[\w.-]*gitlab[\w.-]*)\/(.+?)\/-\/issues\/(\d+)/))) {
    return { kind: 'gitlab', url, label: `${m[2]}#${m[3]}` };
  }
  const host = url.match(/^https?:\/\/([^/?]+)/)?.[1];
  if (!host || !HOST_RE.test(host)) return undefined;
  return { kind: 'other', url, label: host };
}

const MAX_LINKS = 12;

/**
 * Links mentioned in user/assistant messages, classified (Linear/Jira/GitHub/
 * GitLab), deduped by URL AND by label (a session that quotes the same PR in
 * five messages shows it once), first-seen order. Capped so a link-heavy
 * session can't flood the pane.
 */
export function extractLinks(events: SessionEvent[]): SessionLink[] {
  const seenUrl = new Set<string>();
  const seenLabel = new Set<string>();
  const out: SessionLink[] = [];
  for (const e of events) {
    if (e.type !== 'message' || !e.content) continue;
    // Harness-injected scaffolding (bash wrappers, system reminders) carries
    // URLs that aren't conversation references — same exclusion the rest of
    // the pipeline applies.
    if (e._synthetic) continue;
    for (const raw of e.content.match(URL_RE) ?? []) {
      const url = raw.replace(/[.,;:)\]`]+$/, '');
      if (seenUrl.has(url)) continue;
      seenUrl.add(url);
      const link = classifyLink(url);
      if (!link || seenLabel.has(link.label)) continue;
      seenLabel.add(link.label);
      out.push(link);
      if (out.length >= MAX_LINKS) return out;
    }
  }
  return out;
}

// ── Artifacts (docs/files produced) ───────────────────────────────────────────

export type ArtifactBucket = 'artifacts' | 'plans' | 'reports' | 'docs';
export interface ProducedArtifact {
  /** Absolute (or session-relative) path of the created file. */
  path: string;
  basename: string;
  bucket: ArtifactBucket;
}

const ARTIFACT_EXT_RE = /\.(md|markdown|html?)$/i;
const MAX_ARTIFACTS = 12;

/**
 * Documents/files the session CREATED, from the already-classified changes
 * (callers classify once — this never re-derives). Keeps the ones a human
 * browses later: anything under `.agents/artifacts|plans|reports/`, plus other
 * `*.md`/`*.html` creations. Source/config churn (the bulk of `+N`) stays in
 * the Changes line.
 */
export function extractArtifacts(changes: FileChange[]): ProducedArtifact[] {
  const out: ProducedArtifact[] = [];
  for (const ch of changes) {
    if (ch.op !== 'created') continue;
    const p = ch.path;
    if (isNoisePath(p)) continue;
    const norm = p.replace(/\\/g, '/');
    let bucket: ArtifactBucket | undefined;
    if (/\/\.agents\/artifacts\//.test(norm)) bucket = 'artifacts';
    else if (/\/\.agents\/plans\//.test(norm) || /\/plans\/[^/]+\.md$/i.test(norm)) bucket = 'plans';
    else if (/\/\.agents\/reports\//.test(norm)) bucket = 'reports';
    else if (ARTIFACT_EXT_RE.test(norm)) bucket = 'docs';
    if (!bucket) continue;
    out.push({ path: p, basename: path.posix.basename(norm), bucket });
    if (out.length >= MAX_ARTIFACTS) break;
  }
  return out;
}

// ── Repos ─────────────────────────────────────────────────────────────────────

/** Candidate dirs to probe for a `.git` root, and the walk depth per dir. */
const MAX_REPO_PROBES = 12;
const REPO_WALK_DEPTH = 6;

/** A walk-up that lands here overshot the workspace — never a "repo worked in". */
function isOvershotRoot(dir: string): boolean {
  return dir === '/' || dir === os.tmpdir() || dir === os.homedir();
}

function repoRootFrom(dir: string): string | undefined {
  let cur = dir;
  for (let i = 0; i < REPO_WALK_DEPTH; i++) {
    try {
      if (fs.existsSync(path.join(cur, '.git'))) {
        return isOvershotRoot(cur) ? undefined : cur;
      }
    } catch {
      return undefined;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
  return undefined;
}

/**
 * Repos the session worked in, from the directories its file paths live under
 * (a bounded `.git` walk-up; a `.git` FILE counts too — that's the worktree
 * layout). Names are repo dir basenames, first-seen order, capped.
 *
 * Relative paths resolve against the SESSION's cwd only — when it is unknown
 * (e.g. kimi rows carry no cwd today) they are skipped: resolving them against
 * the viewer's process cwd attributes the session to whatever repo the CLI
 * happens to run in, which is a wrong answer, not a degraded one.
 */
export function extractRepos(events: SessionEvent[], cwd?: string): string[] {
  const candidates: string[] = [];
  const seenCand = new Set<string>();
  const addCandidate = (p: string) => {
    if (!p || isNoisePath(p)) return;
    // DotAgents internals (the `.system` registry repo, run archives) are
    // infrastructure, not "repos the user works in".
    if (p.includes('/.agents/.system/') || p.includes('/.agents/.history/')) return;
    if (!path.isAbsolute(p) && !cwd) return;
    const abs = path.isAbsolute(p) ? p : path.resolve(cwd!, p);
    const dir = path.dirname(abs);
    if (seenCand.has(dir)) return;
    seenCand.add(dir);
    candidates.push(dir);
  };

  for (const e of events) {
    if (e.type !== 'tool_use' || e._local) continue;
    const p = e.path || e.args?.file_path || e.args?.path || '';
    if (typeof p === 'string' && p) addCandidate(p);
    if (candidates.length >= MAX_REPO_PROBES) break;
  }

  const repos: string[] = [];
  const seenRoot = new Set<string>();
  for (const dir of candidates) {
    const root = repoRootFrom(dir);
    if (!root || seenRoot.has(root)) continue;
    seenRoot.add(root);
    repos.push(path.basename(root));
  }
  return repos;
}

// ── Background shells ─────────────────────────────────────────────────────────

/**
 * Per-harness shape of "start this shell command in the background", keyed the
 * same way {@link SKILL_TOOL_NAME_BY_AGENT} is: one table entry per harness that
 * has the capability, so adding a harness is a row and never another `else if`.
 *
 * An absent entry means "this harness cannot report it", which the renders must
 * show as ABSENCE, never as a count of zero. Every absence below was probed
 * against that harness's real transcripts on this fleet rather than assumed:
 *
 *   codex        0 of 176 session files carry any background marker; its `exec` /
 *                `exec_command` record only `cmd` + `workdir`, no shell handle.
 *   droid        0 of 126 session files.
 *   antigravity  0 of 54 session files.
 *   opencode     0 of 79 session files.
 *   cursor       stores no tool calls locally at all — only `meta.json` and
 *                `prompt_history.json`; the calls live server-side.
 *
 * Not probed, because no version home is installed on this fleet to probe:
 * `muse`, `rush`, `hermes`, `openclaw`, `gemini`. They are absent for lack of
 * evidence, NOT on a verified negative — add a row once one is confirmed, and
 * until then absence renders as "unknown", which is the safe direction.
 */
const BACKGROUND_SHELL_BY_AGENT: Partial<Record<SessionAgentId, { tool: string; flag: string }>> = {
  claude: { tool: 'Bash', flag: 'run_in_background' },
  kimi: { tool: 'Bash', flag: 'run_in_background' },
  grok: { tool: 'run_terminal_command', flag: 'background' },
};

/**
 * True when this harness records backgrounded shells at all. Callers MUST gate
 * on this before rendering a count: for a harness that cannot report it, "0" is
 * a lie ("none running") where the truth is "unknown", so the segment is omitted
 * entirely — the same way the Hooks line renders for Claude only.
 */
export function harnessTracksBackgroundShells(agent: SessionAgentId): boolean {
  return BACKGROUND_SHELL_BY_AGENT[agent] !== undefined;
}

/**
 * True for a tool_use event that starts a background shell. Exported for the
 * same reason {@link isSkillInvocation} is: the incremental parser can select
 * matching events while streaming instead of re-reading the transcript.
 */
export function isBackgroundShellStart(e: SessionEvent): boolean {
  if (e.type !== 'tool_use' || e._local) return false;
  const spec = BACKGROUND_SHELL_BY_AGENT[e.agent];
  return !!spec && e.tool === spec.tool && e.args?.[spec.flag] === true;
}

interface BackgroundShell {
  /** The command line as invoked, trimmed for display. */
  command: string;
  timestamp: string;
}

/**
 * Shells the session started in the background, oldest first.
 *
 * This is "started", NOT "still running". A transcript records the start and
 * never the death, and inferring liveness from its absence is the same trap
 * `agents devices ps` documents — a killed process leaves no marker, so a naive
 * reader reports "running" forever. Live status belongs to `sessions --active`,
 * which resolves real pids.
 */
export function extractBackgroundShells(events: SessionEvent[]): BackgroundShell[] {
  const out: BackgroundShell[] = [];
  for (const e of events) {
    if (!isBackgroundShellStart(e)) continue;
    const raw = e.command ?? e.args?.command;
    out.push({
      command: typeof raw === 'string' ? raw.trim() : '',
      timestamp: e.timestamp,
    });
  }
  return out;
}

// ── Sub-agents ────────────────────────────────────────────────────────────────

/**
 * True for a tool call that spawns another agent. Deliberately counts BOTH
 * shapes, because both are fan-out the operator needs to see:
 *
 *   in-process   an `Agent` / `Task` tool call inside this transcript
 *   shelled-out  a Bash command that invokes `agents run`, `agents cloud run`,
 *                or `agents teams add|start`
 *
 * Moved here from `commands/sessions-picker.ts` so BOTH preview body paths (the
 * digest body and `formatMetaOnlyBody`) share one definition instead of
 * drifting apart. Semantics are unchanged: session f045b577 counts 23
 * in-process + 30 shelled-out = 53.
 *
 * The full summary's `Subagents (N)` section (`render.ts`) deliberately does NOT
 * use this. It builds a described ROSTER, so it needs `args.description` /
 * `args.prompt` and is necessarily limited to in-process `Agent`/`Task` calls —
 * a shelled-out `agents run` carries no such description. Different question,
 * different answer; do not "unify" them.
 */
export function isSubAgentTool(tool: string, command: string): boolean {
  if (/^(Agent|Task)$/i.test(tool)) return true;
  return /\b(?:agents|ag)\b[^\n;&|]*\b(?:run|cloud\s+run|teams\s+(?:add|start))\b/.test(command);
}
