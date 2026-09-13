/**
 * Session rendering: summary, markdown conversation, and JSON output.
 *
 * Provides the display layer for `agents sessions <id>`. The summary renderer
 * produces a chalk-formatted activity overview (modified files, commands,
 * errors, final message). The markdown renderer emits a full conversation
 * transcript. Filtering by role and turn slicing is handled here as well.
 */

import chalk from 'chalk';
import { truncate } from '../format.js';
import type { SessionEvent, SessionMeta, TodoItem } from './types.js';
import { summarizeToolUse } from './parse.js';
import { cleanSessionPrompt, classifyUserPrompt, extractSessionTopic } from './prompt.js';
import { renderMarkdown } from '../markdown.js';
import { redactSecrets } from '../redact.js';
import { classifyFileChanges, changeCounts, toolHistogram, detectTestResult, type FileChange, type FileOp } from './digest.js';
import { classifyBashCommand, unwrapCommand, bucketKey, type BashCategory } from './bash-command.js';
import { extractArtifacts, extractHooks, extractLinks, extractSkills } from './highlights.js';
import { extractTodoProgressFromEvents } from './state.js';

// ── Path helpers ──────────────────────────────────────────────────────────────

/**
 * Return absPath relative to cwd; fall back to ~/… then absolute.
 */
export function relativeToCwd(absPath: string, cwd?: string): string {
  if (cwd && (absPath === cwd || absPath.startsWith(cwd + '/'))) {
    const rel = absPath.slice(cwd.length + 1);
    return rel || '.';
  }
  const home = process.env.HOME || '';
  if (home && (absPath === home || absPath.startsWith(home + '/'))) {
    return '~' + absPath.slice(home.length);
  }
  return absPath;
}

/**
 * Display form for a touched path: cwd-relative first; then collapse any
 * `.agents/worktrees/<slug>` segment (in-cwd OR outside) to `⧉ <slug>/…` so
 * group labels stay on one line instead of `~/src/…/.agents/worktrees/<slug>/…`;
 * else home-collapse.
 */
export function displayPath(absPath: string, cwd?: string): string {
  const rel = relativeToCwd(absPath, cwd);
  const norm = rel.replace(/\\/g, '/');
  const wt = norm.match(/(^|\/)\.agents\/worktrees\/([^/]+)/);
  if (wt) {
    const after = norm.slice(norm.indexOf(wt[0]) + wt[0].length).replace(/^\//, '');
    return after ? `⧉ ${wt[2]}/${after}` : `⧉ ${wt[2]}`;
  }
  return rel;
}

/** One checklist line with a status marker: `[x] done` / `[>] doing` / `[ ] todo`. */
function renderTodoMarker(item: TodoItem): string {
  const text = item.content;
  if (item.status === 'completed') return chalk.green('[x]') + ' ' + chalk.gray(text);
  if (item.status === 'in_progress') return chalk.yellow('[>]') + ' ' + chalk.white(text);
  return chalk.gray('[ ]') + ' ' + chalk.white(text);
}

/** Best-effort feature-detect for OSC 8 hyperlink support in the current TTY. */
function supportsHyperlinks(): boolean {
  return Boolean(
    process.stdout.isTTY &&
      (process.env.TERM_PROGRAM ||
        process.env.WT_SESSION ||
        process.env.KITTY_WINDOW_ID ||
        process.env.WEZTERM_PANE),
  );
}

/** Wrap `label` in an OSC 8 hyperlink to `target`. Callers gate on {@link supportsHyperlinks}. */
function osc8(target: string, label: string): string {
  return `\x1b]8;;${target}\x1b\\${label}\x1b]8;;\x1b\\`;
}

/**
 * Wrap a filesystem path label in an OSC 8 `file://` hyperlink when the terminal
 * supports it. Degrades to the plain label otherwise.
 */
export function linkPath(absPath: string, label: string): string {
  return supportsHyperlinks() ? osc8(`file://${absPath}`, label) : label;
}

/**
 * Wrap a label in an OSC 8 hyperlink to an arbitrary URL (a PR on GitHub, a Linear
 * issue, …) when the terminal supports it. Degrades to the plain label otherwise.
 */
export function linkUrl(url: string, label: string): string {
  return supportsHyperlinks() ? osc8(url, label) : label;
}

// ── Command grouping ──────────────────────────────────────────────────────────

/**
 * Normalize a command so trivial flag/pipe variations collapse to the same key.
 */
export function normalizeForDedup(cmd: string): string {
  let s = cmd.trim();
  s = s.replace(/\s+-[a-zA-Z]+/g, '');
  s = s.replace(/\s+--[a-zA-Z][-a-zA-Z0-9]*(?:=\S+)?/g, '');
  s = s.replace(/\s*\|\s*(head|tail|wc|less|more|cat)(\s+\S+)?.*$/, '');
  s = s.replace(/\s*2>&1\s*$/, '');
  s = s.replace(/\s*;\s*echo\b.*$/, '');
  const home = process.env.HOME ?? '';
  if (home) {
    s = s.replace(new RegExp('^' + home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '~');
  }
  return s.trim();
}

// Re-export the shared classifier/bucketing for callers in this module's surface.
// `bucketKey` is the single source of truth in bash-command.ts (correct subcommand
// scan + `ssh\u2192` remote prefix); render must not keep a divergent copy.
export { unwrapCommand, bucketKey };

const CATEGORY_NAMES: Record<BashCategory, string> = {
  vcs: 'VCS',
  'build-test': 'Build/test',
  install: 'Install',
  remote: 'Remote',
  http: 'HTTP',
  media: 'Media',
  upscaling: 'Upscaling',
  metadata: 'Metadata',
  probe: 'Probes',
  search: 'Search',
  shell: 'Shell',
  wait: 'Wait',
  other: 'Other',
};

function categoryOf(cmd: string): { name: string; signal: 'high' | 'mid' | 'low' } | null {
  const rawFirst = cmd.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  // Remote wrappers: classify as Remote regardless of inner command.
  if (['ssh', 'scp', 'rsync'].includes(rawFirst)) {
    return { name: 'Remote', signal: 'mid' };
  }
  const info = classifyBashCommand(cmd);
  if (info.category === 'other') return null;
  return { name: CATEGORY_NAMES[info.category], signal: info.signal };
}

interface CmdRun {
  normalized: string;
  raw: string;
  firstTs: number;
  lastTs: number;
  count: number;
}

/**
 * Collapse consecutive same-normalized commands within a 60-second window
 * when they appear 3+ times. Fewer than 3 stay as separate entries.
 */
export function collapseRetries(commands: Array<{ cmd: string; ts: number }>): CmdRun[] {
  const groups: CmdRun[] = [];
  for (const { cmd, ts } of commands) {
    const normalized = normalizeForDedup(unwrapCommand(cmd));
    const last = groups[groups.length - 1];
    if (last && last.normalized === normalized && ts - last.lastTs <= 60_000) {
      last.count++;
      last.lastTs = ts;
    } else {
      groups.push({ normalized, raw: cmd, firstTs: ts, lastTs: ts, count: 1 });
    }
  }
  // Expand groups with count < 3 back to individual entries
  const result: CmdRun[] = [];
  for (const g of groups) {
    if (g.count >= 3) {
      result.push(g);
    } else {
      for (let i = 0; i < g.count; i++) {
        result.push({ normalized: g.normalized, raw: g.raw, firstTs: g.firstTs, lastTs: g.lastTs, count: 1 });
      }
    }
  }
  return result;
}

// ── Stats rollup ──────────────────────────────────────────────────────────────

/** Aggregated statistics computed from a session's parsed events. */
export interface SessionStats {
  models: string[];
  userTurns: number;
  assistantTurns: number;
  toolCount: number;
  /** Per-tool call counts (histogram), highest first when rendered. */
  toolCounts: Record<string, number>;
  errorCount: number;
  outputTokens: number;
  cacheReadTokens: number;
  firstTs: number;
  lastTs: number;
}

/** Compute aggregate statistics (turns, tools, tokens, duration) from session events. */
export function computeSummaryStats(events: SessionEvent[]): SessionStats {
  const modelSet = new Set<string>();
  const toolCounts: Record<string, number> = {};
  let userTurns = 0;
  let assistantTurns = 0;
  let toolCount = 0;
  let errorCount = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let firstTs = Infinity;
  let lastTs = -Infinity;

  for (const e of events) {
    const ts = new Date(e.timestamp).getTime();
    if (!isNaN(ts)) {
      if (ts < firstTs) firstTs = ts;
      if (ts > lastTs) lastTs = ts;
    }
    if (e.type === 'message') {
      if (e.role === 'user') userTurns++;
      else if (e.role === 'assistant') assistantTurns++;
    } else if (e.type === 'tool_use' && !e._local) {
      toolCount++;
      if (e.tool) toolCounts[e.tool] = (toolCounts[e.tool] ?? 0) + 1;
    } else if (e.type === 'error') {
      errorCount++;
    } else if (e.type === 'usage') {
      if (e.model) modelSet.add(shortenModel(e.model));
      outputTokens += e.outputTokens ?? 0;
      cacheReadTokens += e.cacheReadTokens ?? 0;
    }
  }

  return {
    models: Array.from(modelSet),
    userTurns,
    assistantTurns,
    toolCount,
    toolCounts,
    errorCount,
    outputTokens,
    cacheReadTokens,
    firstTs: firstTs === Infinity ? 0 : firstTs,
    lastTs: lastTs === -Infinity ? 0 : lastTs,
  };
}

/** Strip the 'claude-' prefix and date suffix from a model identifier. */
export function shortenModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

/** Format a token count as a human-readable string (e.g. 67.5K, 1.2M). */
export function formatTokenCount(n: number): string {
  if (n === 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return (k >= 100 ? Math.round(k) : parseFloat(k.toFixed(1))) + 'K';
  }
  const m = n / 1_000_000;
  return (m >= 100 ? Math.round(m) : parseFloat(m.toFixed(1))) + 'M';
}

/** Format a duration in milliseconds as a human-readable string (e.g. '12 min', '2h 30min'). */
export function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 1) return 'under 1 min';
  if (totalMin < 60) return `${totalMin} min`;
  const hrs = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins > 0 ? `${hrs}h ${mins}min` : `${hrs}h`;
}

/**
 * Return the stats line for a session summary header.
 * e.g. "221 turns · 198 tools (10 errors) · 67.5M cached / 361K out · 12 min"
 */
export function renderSummaryHeader(stats: SessionStats): string {
  const turns = stats.userTurns + stats.assistantTurns;
  const parts: string[] = [];

  parts.push(`${turns} turn${turns !== 1 ? 's' : ''}`);

  if (stats.toolCount > 0) {
    const toolPart = stats.errorCount > 0
      ? `${stats.toolCount} tools (${stats.errorCount} error${stats.errorCount !== 1 ? 's' : ''})`
      : `${stats.toolCount} tools`;
    parts.push(toolPart);
  }

  if (stats.cacheReadTokens > 0 || stats.outputTokens > 0) {
    const tokenPart = stats.cacheReadTokens > 0
      ? `${formatTokenCount(stats.cacheReadTokens)} cached / ${formatTokenCount(stats.outputTokens)} out`
      : `${formatTokenCount(stats.outputTokens)} out`;
    parts.push(tokenPart);
  }

  if (stats.lastTs > stats.firstTs) {
    parts.push(formatDuration(stats.lastTs - stats.firstTs));
  }

  return parts.join(' · ');
}

// ── Prompt reference extraction ───────────────────────────────────────────────

/** Extract @-mentions, slash paths, and ~/... references from a prompt string. */
function extractReferences(text: string): string[] {
  const refs = new Set<string>();
  for (const m of text.matchAll(/@[\w/.-]+/g)) refs.add(m[0]);
  for (const m of text.matchAll(/(?:^|\s)(\/[\w/.-]{3,})/gm)) refs.add(m[1]);
  for (const m of text.matchAll(/~\/[\w/.-]+/g)) refs.add(m[0]);
  return Array.from(refs);
}

// ── Command section renderer ──────────────────────────────────────────────────

interface BucketEntry {
  catName: string;
  catSignal: 'high' | 'mid' | 'low';
  key: string;
  count: number;
  samples: string[];
}

/** Render the Commands section of the summary, grouping by category and collapsing retries. */
function renderCommandsSection(
  cmds: Array<{ cmd: string; ts: number }>,
  lines: string[],
): void {
  if (cmds.length === 0) return;

  const runs = collapseRetries(cmds);

  // Group runs by category → key → {count, samples}
  const catMap = new Map<string, { signal: 'high' | 'mid' | 'low'; keys: Map<string, { count: number; samples: string[] }> }>();
  let otherCount = 0;
  const otherKeys = new Map<string, { count: number; samples: string[] }>();

  for (const run of runs) {
    const cat = categoryOf(run.raw);
    const key = bucketKey(run.raw);

    if (cat) {
      let catEntry = catMap.get(cat.name);
      if (!catEntry) {
        catEntry = { signal: cat.signal, keys: new Map() };
        catMap.set(cat.name, catEntry);
      }
      const existing = catEntry.keys.get(key) ?? { count: 0, samples: [] };
      existing.count += run.count;
      if (existing.samples.length < 5 && !existing.samples.some(s => sharesPrefix(s, run.raw, 30))) {
        existing.samples.push(run.raw);
      }
      catEntry.keys.set(key, existing);
    } else {
      otherCount += run.count;
      const existing = otherKeys.get(key) ?? { count: 0, samples: [] };
      existing.count += run.count;
      if (existing.samples.length < 3) existing.samples.push(run.raw);
      otherKeys.set(key, existing);
    }
  }

  // Total command count (sum of all run counts)
  const total = runs.reduce((sum, r) => sum + r.count, 0);
  lines.push(chalk.bold('Commands') + chalk.gray(` (${total})`));

  // Sort categories: high-signal first, then mid, then low, by total count desc. Other last.
  const SIGNAL_ORDER: Record<string, number> = { high: 0, mid: 1, low: 2 };
  const sortedCats = Array.from(catMap.entries()).sort((a, b) => {
    const sigA = SIGNAL_ORDER[a[1].signal] ?? 3;
    const sigB = SIGNAL_ORDER[b[1].signal] ?? 3;
    if (sigA !== sigB) return sigA - sigB;
    const countA = Array.from(a[1].keys.values()).reduce((s, v) => s + v.count, 0);
    const countB = Array.from(b[1].keys.values()).reduce((s, v) => s + v.count, 0);
    return countB - countA;
  });

  for (const [catName, catEntry] of sortedCats) {
    const catTotal = Array.from(catEntry.keys.values()).reduce((s, v) => s + v.count, 0);

    if (catEntry.signal === 'low') {
      // Single inline line: category name + top 5 first tokens
      const topTokens = Array.from(catEntry.keys.keys()).slice(0, 5).join(', ');
      lines.push(`  ${chalk.dim(catName)} ${chalk.gray(`(${catTotal})`)} ${chalk.gray('— ' + topTokens)}`);
    } else {
      lines.push(`  ${chalk.dim(catName)} ${chalk.gray(`(${catTotal})`)}`);
      const keysSorted = Array.from(catEntry.keys.entries()).sort((a, b) => b[1].count - a[1].count);
      const limit = catEntry.signal === 'high' ? Infinity : 3;
      let shown = 0;
      for (const [key, v] of keysSorted) {
        if (shown >= limit) break;
        if (catEntry.signal === 'mid') {
          // Mid signal: display the bucket key (e.g. ssh→openclaw browser) with aggregate count
          const countSuffix = v.count > 1 ? chalk.gray(` × ${v.count}`) : '';
          lines.push(`    ${chalk.cyan(truncate(key, 80))}${countSuffix}`);
        } else {
          // High signal: display distinct raw sample commands
          const distinctSamples = pickDistinct(v.samples, 3);
          for (const sample of distinctSamples) {
            const countSuffix = v.count > 1 ? chalk.gray(` × ${v.count}`) : '';
            lines.push(`    ${chalk.cyan(truncate(sample, 80))}${countSuffix}`);
          }
        }
        shown++;
      }
    }
  }

  if (otherCount > 0) {
    lines.push(`  ${chalk.dim('Other')} ${chalk.gray(`(${otherCount})`)}`);
    for (const [, v] of Array.from(otherKeys.entries()).slice(0, 5)) {
      const countSuffix = v.count > 1 ? chalk.gray(` × ${v.count}`) : '';
      lines.push(`    ${chalk.cyan(truncate(v.samples[0] ?? '', 80))}${countSuffix}`);
    }
  }

  lines.push('');
}

function sharesPrefix(a: string, b: string, len: number): boolean {
  return a.slice(0, len) === b.slice(0, len);
}

function pickDistinct(samples: string[], max: number): string[] {
  const result: string[] = [];
  for (const s of samples) {
    if (result.length >= max) break;
    if (!result.some(r => sharesPrefix(r, s, 30))) result.push(s);
  }
  return result.length > 0 ? result : samples.slice(0, max);
}


// ── File grouping ─────────────────────────────────────────────────────────────

/** Group file paths by their parent directory, in display form (cwd-relative,
 * worktree-collapsed, home-collapsed). */
function groupByParentDir(paths: Iterable<string>, cwd?: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const rel = displayPath(p, cwd);
    const slashIdx = rel.lastIndexOf('/');
    const dir = slashIdx >= 0 ? rel.slice(0, slashIdx) : '.';
    const base = slashIdx >= 0 ? rel.slice(slashIdx + 1) : rel;
    const arr = groups.get(dir) ?? [];
    arr.push(base);
    groups.set(dir, arr);
  }
  return new Map(Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length));
}

/** Render grouped file paths as indented, clickable terminal lines. */
function renderFileGroup(lines: string[], groups: Map<string, string[]>, absPathMap: Map<string, string>): void {
  if (groups.size === 1) {
    const [dir, files] = Array.from(groups.entries())[0];
    for (const f of files) {
      const abs = absPathMap.get(dir === '.' ? f : `${dir}/${f}`) ?? '';
      const label = dir === '.' ? f : `${dir}/${f}`;
      lines.push('  ' + chalk.cyan(abs ? linkPath(abs, label) : label));
    }
  } else {
    for (const [dir, files] of groups) {
      lines.push(`  ${chalk.dim(dir + '/')}`);
      for (const f of files) {
        const abs = absPathMap.get(dir === '.' ? f : `${dir}/${f}`) ?? '';
        const label = f;
        lines.push('    ' + chalk.cyan(abs ? linkPath(abs, label) : label));
      }
    }
  }
}

// ── Recent activity renderer ──────────────────────────────────────────────────

/** Render a single Recent Activity line as `<kind-tag> <label>`, colored by kind. */
function renderActivityLine(item: {
  kind: 'edit' | 'cmd' | 'agent' | 'error' | 'msg';
  label: string;
  absPath?: string;
}): string {
  const MAX = 90;
  const trim = (s: string): string => (s.length <= MAX ? s : s.slice(0, MAX - 1) + '…');
  switch (item.kind) {
    case 'edit': {
      const linked = item.absPath ? linkPath(item.absPath, item.label) : item.label;
      return chalk.cyan('Edit ') + ' ' + linked;
    }
    case 'cmd':
      return chalk.yellow('Bash ') + ' ' + chalk.gray(trim(item.label));
    case 'agent':
      return chalk.magenta('Agent') + ' ' + trim(item.label);
    case 'error':
      return chalk.red('Error') + ' ' + chalk.gray(trim(item.label));
    case 'msg':
      return chalk.green('Msg  ') + ' ' + chalk.gray('"' + trim(item.label) + '"');
  }
}

// ── Catch-up digest sections ──────────────────────────────────────────────────

const OP_GLYPH: Record<FileOp, (s: string) => string> = {
  created: (s) => chalk.green(s),
  modified: (s) => chalk.yellow(s),
  deleted: (s) => chalk.red(s),
};
const OP_MARK: Record<FileOp, string> = { created: '+', modified: '~', deleted: '−' };

/**
 * Render the Changes section: files grouped by directory, each tagged with its
 * create/modify/delete lifecycle, plus a `+N ~N −N` summary. Replaces the old
 * flat "Modified" list. Returns true if anything was rendered.
 */
function renderChangesSection(lines: string[], allChanges: FileChange[], cwd?: string): boolean {
  // In-project changes only; edits outside cwd (e.g. /tmp) keep their own
  // "External edits" section so they don't clutter the project's changeset.
  const inCwd = (p: string): boolean => !cwd || !p.startsWith('/') || p.startsWith(cwd + '/');
  const changes = allChanges.filter(ch => inCwd(ch.path));
  if (changes.length === 0) return false;
  const c = changeCounts(changes);
  const opByRel = new Map<string, FileOp>();
  for (const ch of changes) opByRel.set(displayPath(ch.path, cwd), ch.op);

  const summary = [
    c.created ? chalk.green(`+${c.created}`) : '',
    c.modified ? chalk.yellow(`~${c.modified}`) : '',
    c.deleted ? chalk.red(`−${c.deleted}`) : '',
  ].filter(Boolean).join(' ');
  lines.push(chalk.bold('Changes') + chalk.gray(` (${changes.length})  `) + summary);

  const groups = groupByParentDir(changes.map(ch => ch.path), cwd);
  const single = groups.size === 1;
  for (const [dir, files] of groups) {
    // Single dir: show the full relative path per file (dir/base). Multiple
    // dirs: a dir header, then bare filenames under it.
    if (!single) lines.push('  ' + chalk.dim(dir + '/'));
    for (const f of files.sort()) {
      const rel = dir === '.' ? f : `${dir}/${f}`;
      const op = opByRel.get(rel) ?? 'modified';
      const shown = single ? rel : f;
      const name = op === 'deleted' ? chalk.strikethrough(chalk.gray(shown)) : shown;
      lines.push((single ? '  ' : '    ') + OP_GLYPH[op](OP_MARK[op]) + ' ' + name);
    }
  }
  lines.push('');
  return true;
}

/** Render the tool histogram: `Edit 61 · Bash 48 · Read 35 …`. */
function renderToolsSection(lines: string[], stats: SessionStats): void {
  const hist = toolHistogram(stats.toolCounts, 8);
  if (hist.length === 0) return;
  const parts = hist.map(h => `${chalk.white(h.tool)} ${chalk.gray(String(h.count))}`);
  lines.push(chalk.bold('Tools') + '  ' + parts.join(chalk.gray(' · ')));
  lines.push('');
}

/** Render the last test/build verdict, e.g. `Tests  tests: 294 pass · 4 fail`. */
function renderTestsLine(lines: string[], events: SessionEvent[]): void {
  const r = detectTestResult(events);
  if (!r || !r.ok) return;
  const bits: string[] = [];
  if (r.passed !== undefined) bits.push(chalk.green(`${r.passed} pass`));
  if (r.failed !== undefined) bits.push(r.failed > 0 ? chalk.red(`${r.failed} fail`) : chalk.gray('0 fail'));
  const verdict = r.failed && r.failed > 0 ? chalk.red('✗') : chalk.green('✓');
  lines.push(chalk.bold('Tests') + `  ${verdict} ${chalk.cyan(r.runner)} ${bits.join(chalk.gray(' · '))}`);
  lines.push('');
}

// ── Main summary renderer ─────────────────────────────────────────────────────

/**
 * Render session as an activity summary.
 * Returns a chalk-formatted string (not markdown) for direct terminal output.
 */
export function renderSummary(events: SessionEvent[], cwd?: string): string {
  // ── Collect data in a single chronological pass ───────────────────────────

  let firstUserMessage = '';
  const attachments: Array<{ mediaType: string }> = [];
  let lastAssistantMessage = '';

  // File paths (absolute) for grouping — split by whether they're inside cwd
  const filesModifiedAbs = new Set<string>();
  const filesReadAbs = new Set<string>();
  const filesModifiedExternal = new Set<string>();

  // Commands with timestamps
  const cmdList: Array<{ cmd: string; ts: number }> = [];

  // Plan items (checklist entries keep their status for [x]/[>]/[ ] markers)
  const todoItems = extractTodoProgressFromEvents(events)?.items ?? [];
  let exitPlanContent: string | null = null;
  let planFilePath: string | null = null;

  // Subagent spawns
  const subagents: Array<{ description: string; subagentType: string }> = [];

  // Errors
  const errors: Array<{ tool: string; cmd?: string; content?: string }> = [];

  // Recent activity: chronological timeline of interesting events (edits, commands,
  // subagent spawns, errors, assistant messages). Rendered as the first content
  // section so the top of the recap reflects what happened most recently.
  type ActivityKind = 'edit' | 'cmd' | 'agent' | 'error' | 'msg';
  const recentActivity: Array<{ kind: ActivityKind; label: string; ts: number; absPath?: string }> = [];

  // Assistant message count (used to decide whether the session produced any narration)
  let assistantCount = 0;

  const isInsideCwd = (p: string): boolean => !!(cwd && p.startsWith(cwd + '/'));

  for (const event of events) {
    const ts = new Date(event.timestamp).getTime() || 0;

    if (event.type === 'tool_use') {
      if (event._local) continue;

      const tool = event.tool || '';
      const args = event.args || {};
      const p = event.path || args.file_path || args.path || '';

      if (['Read', 'read_file', 'view_file', 'cat_file', 'get_file'].includes(tool)) {
        if (p) filesReadAbs.add(p);
      } else if (['Write', 'Edit', 'Create', 'write_file', 'edit_file', 'create_file', 'replace', 'patch'].includes(tool)) {
        if (p) {
          if (p.includes('.claude/plans/') && p.endsWith('.md')) {
            planFilePath = p;
          } else {
            (isInsideCwd(p) || !cwd ? filesModifiedAbs : filesModifiedExternal).add(p);
            recentActivity.push({ kind: 'edit', label: displayPath(p, cwd), ts, absPath: p });
          }
        }
      }

      if (event.command) {
        const cmd = event.command.replace(/\n/g, ' ').trim();
        if (cmd) {
          cmdList.push({ cmd, ts });
          recentActivity.push({ kind: 'cmd', label: cmd, ts });
        }
      }

      if (tool === 'ExitPlanMode') {
        exitPlanContent = args.result || args.plan || args.content || null;
      }

      // Subagent spawns
      if ((tool === 'Agent' || tool === 'Task') && (args.description || args.prompt)) {
        const description = String(args.description || args.prompt || '').slice(0, 120);
        const subagentType = String(args.subagent_type || '');
        subagents.push({ description, subagentType });
        const typeSuffix = subagentType ? ` (${subagentType})` : '';
        recentActivity.push({ kind: 'agent', label: description + typeSuffix, ts });
      }

    } else if (event.type === 'error') {
      const err = {
        tool: event.tool || 'unknown',
        cmd: event.args?.command ? String(event.args.command).slice(0, 80) : undefined,
        content: event.content?.slice(0, 120),
      };
      errors.push(err);
      const errLabel = err.cmd
        ? `${err.tool} "${err.cmd.slice(0, 60)}"`
        : err.content
          ? `${err.tool}: ${err.content.slice(0, 60)}`
          : err.tool;
      recentActivity.push({ kind: 'error', label: errLabel, ts });

    } else if (event.type === 'message') {
      if (event.role === 'user') {
        if (!firstUserMessage) {
          const content = event.content || '';
          if (!/^\s*<local-command-caveat>/i.test(content)) {
            const topic = extractSessionTopic(content);
            if (topic) firstUserMessage = content;
          }
        }
      } else if (event.role === 'assistant' && event.content) {
        lastAssistantMessage = event.content;
        assistantCount++;
        const preview = event.content.replace(/\s+/g, ' ').trim().slice(0, 100);
        if (preview) recentActivity.push({ kind: 'msg', label: preview, ts });
      }

    } else if (event.type === 'attachment') {
      attachments.push({ mediaType: event.mediaType || 'image/png' });
    }
  }

  // Dedupe: files in Modified should not appear in Read
  for (const p of filesModifiedAbs) filesReadAbs.delete(p);
  for (const p of filesModifiedExternal) filesReadAbs.delete(p);

  // Build abs→display mapping for linkPath
  const buildAbsMap = (absSet: Set<string>): Map<string, string> => {
    const m = new Map<string, string>();
    for (const abs of absSet) {
      const rel = displayPath(abs, cwd);
      m.set(rel, abs);
    }
    return m;
  };

  const readAbsMap = buildAbsMap(filesReadAbs);

  // ── Render sections ───────────────────────────────────────────────────────

  const lines: string[] = [''];

  // 1. Prompt
  if (firstUserMessage) {
    const cleaned = cleanSessionPrompt(firstUserMessage);
    // Show the classified prompt (a screenshot path folds to `[image]`, a
    // pasted `$ cmd` to the command, a skill install path to `/<name>`) so the
    // recap's first line is intent, never path noise (RUSH-3011).
    const { clean } = classifyUserPrompt(firstUserMessage, { hasImageAttachment: attachments.length > 0 });
    if (clean || cleaned) {
      lines.push(chalk.bold('Prompt:') + ' ' + (clean || cleaned.split('\n')[0]));
      const secondLine = cleaned.split('\n')[1]?.trim();
      if (secondLine) lines.push('  ' + secondLine);

      const refs = extractReferences(cleaned);
      if (refs.length > 0) {
        lines.push(chalk.gray('  Referenced: ' + refs.join(', ')));
      }
    }
  }

  // Attachments (images/documents in the first user turn)
  if (attachments.length > 0) {
    const mediaTypes = [...new Set(attachments.map(a => a.mediaType))].join(', ');
    lines.push(chalk.gray(`  + ${attachments.length} screenshot${attachments.length !== 1 ? 's' : ''} (${mediaTypes})`));
  }

  if (firstUserMessage || attachments.length > 0) lines.push('');

  // 2. Recent Activity (first content section — chronological tail of the
  // session so the top of the recap reflects what happened most recently).
  if (recentActivity.length > 0) {
    const RECENT_LIMIT = 7;
    const tail = recentActivity.slice(-RECENT_LIMIT);
    lines.push(chalk.bold('Recent Activity') + chalk.gray(` (last ${tail.length} of ${recentActivity.length})`));
    for (const item of tail) {
      lines.push('  ' + renderActivityLine(item));
    }
    lines.push('');
  }

  // 3. Plan — the plan document (ExitPlanMode text / plan file) AND the live
  // checklist. Both render: the checklist used to be hidden whenever plan text
  // existed, which read as "this session had no todos".
  if (todoItems.length > 0 || exitPlanContent || planFilePath) {
    lines.push(chalk.bold('Plan'));
    if (planFilePath) {
      const home = process.env.HOME ?? '';
      const planPathDisplay = home && planFilePath.startsWith(home) ? planFilePath.replace(home, '~') : planFilePath;
      lines.push('  ' + chalk.cyan(planPathDisplay));
    }
    if (exitPlanContent) {
      const planLines = exitPlanContent.split('\n').slice(0, 10);
      for (const l of planLines) lines.push('  ' + l);
    }
    if (todoItems.length > 0) {
      for (const item of todoItems.slice(0, 20)) {
        lines.push('  ' + renderTodoMarker(item));
      }
      if (todoItems.length > 20) {
        lines.push('  ' + chalk.gray(`… (${todoItems.length - 20} more)`));
      }
    }
    lines.push('');
  }

  // 4. Subagents (describe attempts — grouped with Plan and Errors above the
  // file/command deltas because they speak to *what was tried*, not the final state).
  if (subagents.length > 0) {
    lines.push(chalk.bold('Subagents') + chalk.gray(` (${subagents.length})`));
    for (const s of subagents) {
      const typeSuffix = s.subagentType ? chalk.gray(` (${s.subagentType})`) : '';
      lines.push('  Task: ' + s.description + typeSuffix);
    }
    lines.push('');
  }

  // 4b. Highlights — what the session USED (skills, hooks) and the references
  // it mentioned (links). Shared extraction with the picker preview so the two
  // renders never disagree.
  const skills = extractSkills(events);
  if (skills.length > 0) {
    const shown = skills.map(s => chalk.white(s.name) + (s.count > 1 ? chalk.gray(` ×${s.count}`) : ''));
    lines.push(chalk.bold('Skills') + chalk.gray(` (${skills.length})`) + '  ' + shown.join(chalk.gray(' · ')));
    lines.push('');
  }
  const hooks = extractHooks(events);
  if (hooks.length > 0) {
    const shown = hooks.map(h =>
      chalk.white(h.name) + (h.count > 1 ? chalk.gray(` ×${h.count}`) : '') + (h.failed ? chalk.red(` (${h.failed} failed)`) : ''));
    lines.push(chalk.bold('Hooks') + chalk.gray(` (${hooks.length})`) + '  ' + shown.join(chalk.gray(' · ')));
    lines.push('');
  }
  const links = extractLinks(events);
  if (links.length > 0) {
    // Width-capped like the picker's Dirs line: a link-heavy session must not
    // wrap the summary pane.
    const shown = links.slice(0, 6).map(l => chalk.blue(linkUrl(l.url, l.label)));
    const more = links.length > 6 ? chalk.gray(` · +${links.length - 6} more`) : '';
    lines.push(chalk.bold('Links') + chalk.gray(` (${links.length})`) + '  ' + shown.join(chalk.gray(' · ')) + more);
    lines.push('');
  }

  // 5. Errors (moved up from the bottom: it describes failed attempts, not the
  // session's final state. Sitting at the bottom previously made early errors
  // look recent, which confused readers.)
  if (errors.length > 0) {
    const first = errors[0];
    const firstDesc = first.cmd
      ? `${first.tool} "${first.cmd.slice(0, 60)}"`
      : first.content
        ? `${first.tool}: ${first.content.slice(0, 60)}`
        : first.tool;
    lines.push(
      chalk.red(chalk.bold('Errors')) +
      chalk.gray(`: ${errors.length} failure${errors.length !== 1 ? 's' : ''} — first: ${firstDesc}`)
    );
    lines.push('');
  }

  // 6. Changes — files grouped by directory with create/modify/delete lifecycle
  // (replaces the old flat "Modified" + "External edits" lists). Classified
  // once here and shared with the Artifacts section below.
  const allChanges = classifyFileChanges(events);
  renderChangesSection(lines, allChanges, cwd);

  // 6a. Artifacts — documents the session PRODUCED (`.agents/artifacts|plans|
  // reports`, other *.md/*.html creations), named and clickable. These drown in
  // the Changeset's source churn, so they get their own section.
  const artifacts = extractArtifacts(allChanges);
  if (artifacts.length > 0) {
    lines.push(chalk.bold('Artifacts') + chalk.gray(` (${artifacts.length})`));
    for (const a of artifacts) {
      const tag = a.bucket === 'docs' ? '' : chalk.gray(` (${a.bucket})`);
      lines.push('  ' + chalk.green('+') + ' ' + chalk.cyan(linkPath(a.path, a.basename)) + tag);
    }
    lines.push('');
  }

  // 6b. Catch-up signals: last test/build verdict, then the tool histogram.
  renderTestsLine(lines, events);
  renderToolsSection(lines, computeSummaryStats(events));

  // 6c. External edits (files edited outside the project root — typically /tmp).
  // Filter out plan files (already shown in Plan section).
  const externalNonPlan = [...filesModifiedExternal].filter(p => !(p.includes('.claude/plans/') && p.endsWith('.md')));
  if (externalNonPlan.length > 0) {
    const externalList = externalNonPlan.sort();
    const home = process.env.HOME ?? '';
    const display = externalList.slice(0, 3).map(p => home && p.startsWith(home) ? p.replace(home, '~') : p);
    const more = externalList.length > 3 ? chalk.gray(` +${externalList.length - 3} more`) : '';
    lines.push(chalk.gray(`External edits (${externalList.length}): ${display.join(', ')}${more}`));
    lines.push('');
  }

  // 7. Read files
  if (filesReadAbs.size > 0) {
    if (filesReadAbs.size <= 5) {
      lines.push(chalk.bold('Read') + chalk.gray(` (${filesReadAbs.size})`));
      const groups = groupByParentDir(filesReadAbs, cwd);
      renderFileGroup(lines, groups, readAbsMap);
    } else {
      lines.push(chalk.bold('Read') + chalk.gray(` ${filesReadAbs.size} other files`));
    }
    lines.push('');
  }

  // 8. Commands
  renderCommandsSection(cmdList, lines);

  // 9. Final message
  if (lastAssistantMessage) {
    const hasActivity = filesModifiedAbs.size > 0 || filesReadAbs.size > 0 || cmdList.length > 0;
    if (hasActivity || errors.length > 0) lines.push(chalk.gray('─'.repeat(60)));
    lines.push('');
    const truncated = lastAssistantMessage.length > 3000
      ? lastAssistantMessage.slice(0, 2997) + '...'
      : lastAssistantMessage;
    lines.push(renderMarkdown(truncated).trimEnd());
    lines.push('');
  } else if (
    filesModifiedAbs.size === 0 &&
    filesReadAbs.size === 0 &&
    cmdList.length === 0 &&
    assistantCount === 0
  ) {
    lines.push(chalk.gray('No activity recorded in this session.'));
    lines.push('');
  }

  return lines.join('\n');
}

// ── Event filters ─────────────────────────────────────────────────────────────

/** Allowed values for --include/--exclude role filters. */
const VALID_ROLE_VALUES = ['user', 'assistant', 'thinking', 'tools'] as const;
/** A single role filter value derived from VALID_ROLE_VALUES. */
export type RoleFilter = typeof VALID_ROLE_VALUES[number];

/** Options for filtering session events by role and turn range. */
export interface FilterOptions {
  include?: RoleFilter[];
  exclude?: RoleFilter[];
  first?: number;
  last?: number;
}

/**
 * Parse a comma-separated role list (e.g. "user,assistant") into typed values.
 * Throws with a clear message listing valid values on any unknown entry.
 */
export function parseRoleList(raw: string, flag: string): RoleFilter[] {
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`${flag} requires at least one role. Valid values: ${VALID_ROLE_VALUES.join(', ')}`);
  }
  for (const p of parts) {
    if (!VALID_ROLE_VALUES.includes(p as RoleFilter)) {
      throw new Error(`Invalid value "${p}" for ${flag}. Valid values: ${VALID_ROLE_VALUES.join(', ')}`);
    }
  }
  return parts as RoleFilter[];
}

function roleOfEvent(e: SessionEvent): RoleFilter | null {
  // Synthetic scaffolding still maps to 'user' here so `--exclude user` drops it
  // like any other user-role event (pre-flag behavior). `--include user`'s
  // "genuine intent only" carve-out lives in applyRoleFilter, not here.
  if (e.type === 'message' && e.role === 'user') return 'user';
  if (e.type === 'message' && e.role === 'assistant') return 'assistant';
  if (e.type === 'thinking') return 'thinking';
  if (e.type === 'tool_use' || e.type === 'tool_result') return 'tools';
  return null;
}

/**
 * Keep events whose role is in `include` (whitelist) or whose role is not in
 * `exclude` (blacklist). Non-role events (errors, usage, attachments, init,
 * result) are preserved unless explicitly constrained by `include` — that
 * matches the user model: "include user" means "only user".
 */
function applyRoleFilter(events: SessionEvent[], opts: FilterOptions): SessionEvent[] {
  if (opts.include && opts.include.length > 0) {
    const set = new Set(opts.include);
    return events.filter(e => {
      const role = roleOfEvent(e);
      if (role === null) return false;
      // `--include user` means genuine user intent, so drop harness-injected
      // `_synthetic` scaffolding (bash-input, system-reminder) even though it
      // carries role=user. `--exclude user` still drops it via roleOfEvent.
      if (role === 'user' && e._synthetic) return false;
      return set.has(role);
    });
  }
  if (opts.exclude && opts.exclude.length > 0) {
    const set = new Set(opts.exclude);
    return events.filter(e => {
      const role = roleOfEvent(e);
      return role === null || !set.has(role);
    });
  }
  return events;
}

/**
 * A "turn" starts at each user message. `--first N` keeps events through the
 * end of the Nth user turn; `--last N` keeps events from the start of the
 * (M-N+1)th user turn to the end. If the session has no user messages, every
 * assistant message counts as a turn instead.
 */
function applyTurnSlice(events: SessionEvent[], opts: FilterOptions): SessionEvent[] {
  if (opts.first === undefined && opts.last === undefined) return events;
  if (opts.first !== undefined && opts.last !== undefined) {
    throw new Error('--first and --last are mutually exclusive');
  }
  const n = (opts.first ?? opts.last)!;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Turn count must be a positive integer, got ${n}`);
  }

  // A turn starts at a GENUINE user message — harness-injected `_synthetic`
  // scaffolding (`<bash-input>`/`<bash-stdout>`, etc.) does not start a turn,
  // so `--first N` / `--last N` count real asks, not the jump command that
  // opened the session and its shell output.
  const isTurnStart = (e: SessionEvent): boolean =>
    e.type === 'message' && e.role === 'user' && !e._synthetic;
  const turnStartIdx: number[] = [];
  for (let i = 0; i < events.length; i++) if (isTurnStart(events[i])) turnStartIdx.push(i);

  // Fallback: no user messages — treat assistant messages as turn boundaries.
  if (turnStartIdx.length === 0) {
    for (let i = 0; i < events.length; i++) {
      if (events[i].type === 'message' && events[i].role === 'assistant') turnStartIdx.push(i);
    }
  }
  if (turnStartIdx.length === 0) return events;

  if (opts.first !== undefined) {
    if (n >= turnStartIdx.length) return events;
    const endIdx = turnStartIdx[n]; // exclusive
    return events.slice(0, endIdx);
  }
  // --last
  if (n >= turnStartIdx.length) return events;
  const startIdx = turnStartIdx[turnStartIdx.length - n];
  return events.slice(startIdx);
}

/**
 * Apply include/exclude/first/last. Turn slicing runs first so role filters
 * operate on the sliced window (natural semantics: "last 3 turns, user only").
 */
export function filterEvents(events: SessionEvent[], opts: FilterOptions): SessionEvent[] {
  if (opts.include && opts.include.length > 0 && opts.exclude && opts.exclude.length > 0) {
    throw new Error('--include and --exclude are mutually exclusive');
  }
  const sliced = applyTurnSlice(events, opts);
  return applyRoleFilter(sliced, opts);
}

// ── Conversation renderers ────────────────────────────────────────────────────

/**
 * Build the conversation as a single markdown string: user / assistant
 * messages, inline thinking blocks, tool calls, and errors. Emitted in event
 * order so reasoning sits where it actually occurred relative to the assistant
 * reply.
 */
interface RenderConversationMarkdownOptions {
  redact?: boolean;
  knownSecrets?: readonly string[];
  reasoning?: 'omit' | 'fold' | 'include';
  maxToolOutputChars?: number;
}

function markdownFence(content: string, language = ''): string {
  const fence = content.includes('```') ? '````' : '```';
  return `${fence}${language}\n${content}\n${fence}`;
}

function truncateToolOutput(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n\n[Output truncated: ${content.length - maxChars} characters omitted.]`;
}

export function renderConversationMarkdown(
  events: SessionEvent[],
  opts: RenderConversationMarkdownOptions = {},
): string {
  const parts: string[] = [];
  const shouldRedact = opts.redact !== false;
  const sanitize = (text: string): string => shouldRedact ? redactSecrets(text, opts.knownSecrets) : text;
  // Preserve the long-standing `sessions <id> --markdown` full-fidelity default.
  // The shareable `sessions render` surface passes `omit` explicitly.
  const reasoning = opts.reasoning ?? 'include';
  const maxToolOutputChars = opts.maxToolOutputChars ?? 4000;

  for (const event of events) {
    if (event.type === 'message') {
      if (event.role === 'user') {
        parts.push(`## User\n\n${sanitize(event.content ?? '')}`);
      } else if (event.role === 'assistant') {
        parts.push(`## Assistant\n\n${sanitize(event.content ?? '')}`);
      }
    } else if (event.type === 'thinking') {
      if (event.content && reasoning === 'include') {
        parts.push(`### Reasoning\n\n${sanitize(event.content)}`);
      } else if (event.content && reasoning === 'fold') {
        parts.push(`<details>\n<summary>Reasoning</summary>\n\n${sanitize(event.content)}\n\n</details>`);
      }
    } else if (event.type === 'tool_use') {
      const tool = event.tool || 'unknown';
      if (event.command) {
        const args = event.args && Object.keys(event.args).length > 0
          ? `\n\nArguments:\n\n${markdownFence(sanitize(JSON.stringify(event.args, null, 2)), 'json')}`
          : '';
        parts.push(`### Tool: ${tool}\n\n${markdownFence(sanitize(event.command), 'bash')}${args}`);
      } else if (event.args && Object.keys(event.args).length > 0) {
        parts.push(`### Tool: ${tool}\n\nArguments:\n\n${markdownFence(sanitize(JSON.stringify(event.args, null, 2)), 'json')}`);
      } else if (event.path) {
        parts.push(`### Tool: ${tool}\n\n\`${sanitize(shortenPathTrace(event.path))}\``);
      } else {
        const summary = summarizeToolUse(tool, event.args);
        parts.push(`### Tool: ${tool}\n\n${sanitize(summary)}`);
      }
    } else if (event.type === 'tool_result') {
      const output = event.content || event.output;
      if (output) {
        const body = sanitize(truncateToolOutput(output, maxToolOutputChars));
        parts.push(`### Tool Result${event.tool ? `: ${event.tool}` : ''}\n\n${markdownFence(body)}`);
      }
    } else if (event.type === 'error') {
      parts.push(`### Error\n\n${event.content ? sanitize(event.content) : (event.tool || 'Unknown error')}`);
    }
  }

  return parts.join('\n\n');
}

/**
 * Deep-redact every string reachable from a JSON value, preserving structure.
 * `redactSecrets` only rewrites secret-shaped substrings, so non-secret strings
 * (paths, URLs, ids) and non-strings (numbers, booleans) pass through unchanged.
 * Applied to the whole `--json` payload so every free-text field — event
 * `content`/`command`/`output`/`args`, and meta `topic`/`label`/`plan`/`todos`
 * — is covered, including fields added later.
 */
function redactDeep<T>(value: T, sanitize: (text: string) => string): T {
  if (typeof value === 'string') return sanitize(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, sanitize)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = redactDeep(val, sanitize);
    return out as T;
  }
  return value;
}

/**
 * Render one session's JSON output — the shape `agents sessions <id> --json`
 * emits. When `meta` is provided (the standard path), returns a
 * `{ session, events }` wrapper so top-level fields (`plan`, `prUrl`, …) that
 * live on `SessionMeta` are visible without re-parsing events. Legacy
 * callers that pass no meta still get a bare `SessionEvent[]` array.
 *
 * Secrets are redacted by default (`opts.redact !== false`), matching
 * `renderConversationMarkdown` — the JSON path must not be the one output
 * format that leaks credentials. Redaction covers both events AND the session
 * meta (e.g. `topic`, a verbatim first-message excerpt). Pass `{ redact: false }`
 * for `--no-redact`.
 */
export function renderJson(
  events: SessionEvent[],
  meta?: SessionMeta,
  opts: { redact?: boolean } = {},
): string {
  const redact = opts.redact !== false;
  const sanitize = (text: string): string => redactSecrets(text);
  const safeEvents = redact ? events.map((event) => redactDeep(event, sanitize)) : events;
  if (!meta) return JSON.stringify(safeEvents, null, 2);
  // Strip internal-only bookkeeping fields the listing --json path also strips.
  const { _matchedTerms, _bm25Score, _remote, ...rest } = meta;
  const session = redact ? redactDeep(rest, sanitize) : rest;
  return JSON.stringify({ session, events: safeEvents }, null, 2);
}

/** Replace the home directory prefix with ~ for trace display. */
function shortenPathTrace(p: string): string {
  const home = process.env.HOME || '';
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}
