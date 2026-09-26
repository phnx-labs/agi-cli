/**
 * Insights command — one observe verb for "how work looks".
 *
 * Two data paths under one name (do not re-split into peer top-level commands):
 *
 *   agents insights              HOW you work (transcript content: tools, friction,
 *                                rhythm, edits) — split by Claude account by default
 *   agents insights mix          COUNTERS (sessions index + usage.db recipes:
 *                                harness/model mix, token ratios, secrets, browser)
 *   agents insights mix <recipe> One baked mix recipe (harness-mix, tools-per-session, …)
 *   agents insights query        Raw usage.db rows
 *
 * Sibling observe verbs under this same group (different questions):
 *
 *   agents insights cost    what you spent ($ and duration)
 *   agents insights output  what shipped (burn vs PRs and commits)
 *   agents insights perf    latency (hooks, CLI commands, agent.run) — not popularity
 *   agents view             live quota headroom (per account, with auth state)
 *   agents sessions stats   which skills/slash-commands were explicitly invoked
 *
 * Why mix lives here (not a second top-level `trends`): two abstract "analytics"
 * nouns taught agents and humans to guess. One verb, two engines — cheap SQL mix
 * vs transcript facets. `perf` (latency) is also nested here now (PHNX-3391) —
 * performance is an insight, kept a distinct sub-verb so it is never confused with mix.
 *
 * Modelled on Claude Code's `/insights`, with the difference that motivated it: that
 * command reads one account's directory, while `balanced` rotation sprays sessions
 * across every signed-in account. This reads the whole index and reports the accounts
 * apart — see lib/session/claude-accounts.ts for how a transcript is attributed.
 *
 * The deterministic report makes zero network calls. `--narrative` is opt-in and adds
 * the coaching prose by piping the AGGREGATE (never raw transcripts) through a headless
 * `claude -p`.
 *
 * Former top-level `agents trends` is `agents insights mix` (one section:
 * `agents insights mix <recipe>`; `--list` names them).
 */

import type { Command } from 'commander';
import * as fs from 'fs';
import chalk from 'chalk';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { addHostOption } from '../lib/hosts/option.js';
import { setHelpSections } from '../lib/help.js';
import { discoverSessions, parseTimeFilter } from '../lib/session/discover.js';
import {
  querySessions,
  readSessionInsights,
  writeSessionInsights,
  clearSessionInsights,
  type QueryOptions,
} from '../lib/session/db.js';
import { parseSession } from '@phnx-labs/sessions-cli/reader';
import {
  computeInsightFacets,
  mergeFacets,
  newFacetAccumulator,
  detectOverlap,
  percentile,
  bucketGaps,
  topEntries,
  buildInsightActions,
  type InsightFacets,
  type InsightAction,
  type SessionSpan,
} from '@phnx-labs/sessions-cli/reader';
import { formatUsd } from '../lib/pricing/index.js';
import { formatDuration } from '@phnx-labs/sessions-cli/reader';
import { terminalWidth, truncateToWidth, stringWidth, padToWidth } from '../lib/session/width.js';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import { registerMixCommands } from '../lib/analytics/mix-commands.js';
import { registerPerfSubcommand } from './perf.js';
import { registerCostCommand } from './cost.js';
import { registerOutputCommand } from './output.js';

const execFileAsync = promisify(execFile);

interface InsightsOptions {
  json?: boolean;
  since?: string;
  all?: boolean;
  account?: string;
  agent?: string[];
  by?: string;
  refresh?: boolean;
  narrative?: boolean;
  minMessages?: string;
}

function collectAgent(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function agentsFromArgv(argv: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--agent' && argv[i + 1]) values.push(argv[++i]);
    else if (argv[i].startsWith('--agent=')) values.push(argv[i].slice('--agent='.length));
  }
  return values;
}

/** One reported group — an account by default, else an agent/project/day. */
interface GroupReport {
  key: string;
  label: string;
  plan: string | null;
  sessions: number;
  costUsd: number;
  durationMs: number;
  outputTokens: number;
  facets: InsightFacets;
}

type GroupDim = 'account' | 'agent' | 'project' | 'day';

function resolveGroup(by: string | undefined): GroupDim {
  if (by === undefined) return 'account';
  if (by === 'account' || by === 'agent' || by === 'project' || by === 'day') return by;
  console.error(chalk.red('error: --by must be one of: account, agent, project, day'));
  process.exit(1);
}

/**
 * Sessions too short to say anything about how you work.
 *
 * Inspired by the filter `/insights` applies, but NOT identical and deliberately not
 * claimed to be: `/insights` counts USER messages, while `messageCount` on the index
 * counts both roles, so the same threshold is a weaker bar here. Matching it exactly
 * would mean parsing every session just to decide whether to parse it. The dropped
 * count is always reported, never silent.
 */
function isSubstantive(m: SessionMeta, minMessages: number): boolean {
  if ((m.messageCount ?? 0) < minMessages) return false;
  if ((m.durationMs ?? 0) < 60_000) return false;
  return true;
}

function groupKeyFor(m: SessionMeta, dim: GroupDim): string {
  switch (dim) {
    case 'account': return m.accountKey ?? `unattributed:${m.agent}`;
    case 'agent': return m.agent;
    case 'project': return m.project || '(no project)';
    case 'day': return m.timestamp.slice(0, 10);
  }
}

function groupLabelFor(m: SessionMeta, dim: GroupDim, key: string): string {
  if (dim !== 'account') return key;
  if (m.accountOrg && m.account) return `${m.accountOrg} <${m.account}>`;
  return key;
}

/**
 * Load facets for every in-scope session, parsing only what the cache does not
 * already hold. A cold first run parses every transcript once; after that only files
 * whose (mtime, size) changed are re-read.
 */
async function collectFacets(
  rows: SessionMeta[],
  onProgress: (done: number, total: number) => void,
): Promise<{ facets: Map<string, InsightFacets>; unreadable: number }> {
  let unreadable = 0;
  const cached = readSessionInsights<InsightFacets>(rows.map((r) => r.id));
  const stale = rows.filter((r) => !cached.has(r.id) && r.filePath);
  if (stale.length === 0) return { facets: cached, unreadable };

  const fresh: Array<{ id: string; fileMtimeMs: number | null; fileSize: number | null; facets: InsightFacets }> = [];
  let done = 0;
  for (const row of stale) {
    try {
      // Stat BEFORE reading, so the stamp we persist describes bytes no newer than the
      // ones parsed: a rescan landing mid-read then reads as stale, not as a hit.
      const st = fs.statSync(row.filePath!);
      // includeInterrupts: the default event array is a versioned contract, so the
      // marker is opt-in and this is the reader that opts in.
      const events = parseSession(row.filePath!, row.agent, { includeInterrupts: true });
      const facets = computeInsightFacets(events);
      cached.set(row.id, facets);
      fresh.push({ id: row.id, fileMtimeMs: Math.floor(st.mtimeMs), fileSize: st.size, facets });
    } catch {
      // Deleted or corrupt since it was indexed. Counted and reported below, never
      // silently contributing zero.
      unreadable++;
    }
    done++;
    if (done % 25 === 0) onProgress(done, stale.length);
    // Persist in batches so an interrupted cold run does not lose everything.
    if (fresh.length >= 200) {
      writeSessionInsights(fresh.splice(0, fresh.length));
    }
  }
  if (fresh.length > 0) writeSessionInsights(fresh);
  onProgress(stale.length, stale.length);
  return { facets: cached, unreadable };
}

function buildGroups(
  rows: SessionMeta[],
  facetsById: Map<string, InsightFacets>,
  dim: GroupDim,
): GroupReport[] {
  const byKey = new Map<string, GroupReport>();
  for (const m of rows) {
    const key = groupKeyFor(m, dim);
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        label: groupLabelFor(m, dim, key),
        plan: null,
        sessions: 0,
        costUsd: 0,
        durationMs: 0,
        outputTokens: 0,
        facets: newFacetAccumulator(),
      };
      byKey.set(key, g);
    }
    g.sessions++;
    g.costUsd += m.costUsd ?? 0;
    g.durationMs += m.durationMs ?? 0;
    g.outputTokens += m.outputTokens ?? 0;
    const f = facetsById.get(m.id);
    if (f) mergeFacets(g.facets, f);
  }
  return [...byKey.values()].sort((a, b) => b.sessions - a.sessions || a.key.localeCompare(b.key));
}

/** A compact bar for a count relative to the row maximum. */
function bar(count: number, max: number, width: number): string {
  if (max <= 0) return '';
  const filled = Math.max(1, Math.round((count / max) * width));
  return '█'.repeat(filled);
}

function renderCounts(
  title: string,
  entries: Array<{ name: string; count: number }>,
  out: string[],
): void {
  if (entries.length === 0) return;
  out.push('');
  out.push(chalk.bold(title));
  const nameW = Math.max(...entries.map((e) => stringWidth(e.name)));
  const countW = Math.max(...entries.map((e) => String(e.count).length));
  const max = Math.max(...entries.map((e) => e.count));
  const barW = Math.max(6, Math.min(28, terminalWidth() - nameW - countW - 8));
  for (const e of entries) {
    out.push(
      `  ${padToWidth(e.name, nameW)}  ${chalk.cyan(String(e.count).padStart(countW))}  ` +
      chalk.gray(bar(e.count, max, barW)),
    );
  }
}

function renderHours(hours: number[], out: string[]): void {
  const total = hours.reduce((a, b) => a + b, 0);
  if (total === 0) return;
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const max = Math.max(...hours);
  const spark = hours
    .map((h) => (h === 0 ? ' ' : blocks[Math.min(blocks.length - 1, Math.floor((h / max) * (blocks.length - 1)))]))
    .join('');
  out.push('');
  out.push(chalk.bold('When you work') + chalk.gray('  (local time)'));
  out.push(`  ${chalk.cyan(spark)}`);
  out.push(`  ${chalk.gray('0h'.padEnd(6))}${chalk.gray('6h'.padEnd(6))}${chalk.gray('12h'.padEnd(6))}${chalk.gray('18h'.padEnd(5))}${chalk.gray('23h')}`);
}

function renderReport(groups: GroupReport[], dim: GroupDim, meta: ReportMeta, actions: InsightAction[], harnesses: Array<{ name: string; count: number }>): void {
  const out: string[] = [];
  const scope = meta.since ? `last ${meta.since}` : 'all time';
  out.push(chalk.bold('Insights') + chalk.gray(`  ${scope} · ${meta.analyzed} of ${meta.scanned} sessions`));

  if (groups.length === 0) {
    out.push('');
    out.push(chalk.gray('  No sessions in scope. Try a wider --since, or run `agents sessions --all` to index.'));
    console.log(out.join('\n'));
    return;
  }

  // Per-group table — the headline, and the thing no sibling command produces.
  // Includes silent-stall counts so harness/account laziness is visible without --json.
  out.push('');
  out.push(chalk.bold(`By ${dim}`));
  const labelW = Math.min(
    Math.max(...groups.map((g) => stringWidth(g.label)), 5),
    Math.max(16, terminalWidth() - 58),
  );
  const sessW = Math.max(...groups.map((g) => String(g.sessions).length), 3);
  const stallOf = (g: GroupReport): number =>
    Object.entries(g.facets.frictionSignals)
      .filter(([k]) => k.startsWith('silent stall:'))
      .reduce((n, [, c]) => n + c, 0);
  const resumeOf = (g: GroupReport): number =>
    g.facets.correctionSignals['resume after silent stall'] ?? 0;
  const stallW = Math.max(...groups.map((g) => String(stallOf(g)).length), 5);
  out.push(chalk.gray(
    `  ${padToWidth('', labelW)}  ${''.padStart(sessW)}       ` +
    `${''.padStart(9)}  ${''.padStart(8)}  ${'stalls'.padStart(stallW)}  resume`,
  ));
  for (const g of groups) {
    const cost = g.costUsd > 0 ? formatUsd(g.costUsd) : '—';
    const dur = g.durationMs > 0 ? formatDuration(g.durationMs) : '—';
    const stalls = String(stallOf(g));
    const resumes = String(resumeOf(g));
    out.push(
      `  ${padToWidth(truncateToWidth(g.label, labelW), labelW)}  ` +
      `${chalk.gray(String(g.sessions).padStart(sessW))} ${chalk.gray('sess')}  ` +
      `${chalk.green(padToWidth(cost, 9))}  ${chalk.gray(padToWidth(dur, 8))}  ` +
      `${chalk.cyan(stalls.padStart(stallW))}  ${chalk.cyan(resumes)}`,
    );
  }

  // Everything below is the whole scope folded together; per-group detail is in --json.
  const all = newFacetAccumulator();
  for (const g of groups) mergeFacets(all, g.facets);

  renderCounts('Top tools', topEntries(all.toolCounts, 8), out);
  // The `Bash`/`exec` bar above says a shell ran; this says WHICH binary — git, gh,
  // agents, find, ssh→git — so the tool mix is actionable rather than one lump.
  renderCounts('Shell commands', topEntries(all.bashCommands, 12), out);
  renderCounts('Languages', topEntries(all.languages, 6), out);
  renderCounts('Models', topEntries(all.models, 6), out);

  // Friction — the section that earns the command.
  renderCounts('Silent stalls by model', topEntries(all.silentStallsByModel ?? {}, 8), out);
  const gaps = all.responseGaps;
  const silentStalls = Object.entries(all.frictionSignals)
    .filter(([k]) => k.startsWith('silent stall:'))
    .reduce((n, [, c]) => n + c, 0);
  const resumeNudges = all.correctionSignals['resume after silent stall'] ?? 0;
  out.push('');
  out.push(chalk.bold('Friction'));
  out.push(`  ${padToWidth('interruptions', 18)}  ${chalk.cyan(String(all.interruptions))}` +
    chalk.gray('   turns you cut short'));
  out.push(`  ${padToWidth('tool errors', 18)}  ${chalk.cyan(String(all.errorCount))}`);
  if (gaps.length > 0) {
    // Same timestamps as silent stalls; this line is the distribution. Silent
    // stalls (below) are the agent-attributed long gaps after the model stopped.
    out.push(`  ${padToWidth('gap until next msg', 18)}  ` +
      chalk.cyan(`p50 ${Math.round(percentile(gaps, 50))}s`) + chalk.gray(` · p90 ${Math.round(percentile(gaps, 90))}s`) +
      chalk.gray('   after assistant last spoke'));
  }
  if (silentStalls > 0) {
    out.push(`  ${padToWidth('silent stalls', 18)}  ${chalk.cyan(String(silentStalls))}` +
      chalk.gray('   agent idle ≥5m until you resumed (also in By ' + dim + ' table)'));
  }
  if (resumeNudges > 0) {
    out.push(`  ${padToWidth('resume nudges', 18)}  ${chalk.cyan(String(resumeNudges))}` +
      chalk.gray('   "continue"/"keep going" after a silent stall'));
  }
  const errs = topEntries(all.errorCategories, 6);
  if (errs.length > 0) {
    for (const e of errs) out.push(`    ${chalk.gray('·')} ${padToWidth(e.name, 16)} ${chalk.gray(String(e.count))}`);
  }

  renderCounts('Friction / thrash', topEntries(all.frictionSignals, 10), out);
  // Which shell binary was failing when a `failed tool loop: Bash` fired — makes the
  // loop attributable (`git reconcile`, `find`, `gh`) instead of a bare tool name.
  renderCounts('Shell command failures', topEntries(all.bashCommandFailures, 8), out);
  renderCounts('Dissatisfaction / corrections', topEntries(all.correctionSignals, 10), out);
  renderCounts('Automatable repeats', topEntries(all.automationSignals, 10), out);
  renderCounts('Harness split', harnesses, out);

  // Actions are built from frictionSignals/correctionSignals/automationSignals
  // together (buildInsightActions).
  out.push('');
  out.push(chalk.bold('Actions'));
  if (actions.length === 0) {
    out.push(chalk.gray('  No repeated action pattern met the evidence threshold in this window.'));
  } else {
    out.push(chalk.gray('  pri     category    evidence  sample sessions  action'));
    for (const action of actions.slice(0, 12)) {
      out.push(`  ${padToWidth(action.priority, 7)} ${padToWidth(action.category, 11)} ` +
        `${String(action.evidenceCount).padStart(8)}  ${padToWidth(action.sampleSessionIds.join(', '), 25)} ${action.action}`);
    }
    // This report is aggregate by contract (SES-IF-4c); a sample id above drills into
    // one session's timeline via the per-session surface, not a single-session mode here.
    out.push(chalk.gray('  drill into a sample session:  agents sessions trace <id>'));
  }

  // Output
  out.push('');
  out.push(chalk.bold('What you changed'));
  // Gate on whether anything was actually measured, not on whether an edit-shaped call
  // was seen. Codex patches through `exec`, so it can log edit-class calls and still
  // expose no line arguments to count — rendering that as "0 lines" would read as "wrote
  // nothing" for a harness that wrote plenty.
  if (all.linesTouchedAfter > 0 || all.linesTouchedBefore > 0) {
    // "touched", not "+/-": these are the before/after line counts of each edit, so an
    // Edit with unchanged context lines counts them on both sides. Not a diffstat, and
    // labelled so nobody reads it as one.
    out.push(`  ${chalk.cyan(String(all.linesTouchedAfter))} ${chalk.gray('lines written,')} ` +
      `${chalk.cyan(String(all.linesTouchedBefore))} ${chalk.gray('replaced')}  ` +
      chalk.gray('(lines touched, not a diff)'));
  } else {
    out.push(`  ${chalk.gray('lines touched  —  not measurable for this harness (edits go through the shell)')}`);
  }
  out.push(`  ${chalk.gray(`${all.filesCreated} created, ${all.filesModified} modified, ${all.filesDeleted} deleted`)}`);
  // Same not-measurable rule as the lines above. These are substring-matched from
  // shell command TEXT, and not every harness exposes it — the codex parser populates
  // `command` for `exec_command` but not plain `exec`, its dominant tool — so gate on
  // whether we had anything to search rather than on seeing a shell-shaped tool call.
  // When we did, the count is real, and still disagrees with `agents insights output`, which
  // counts deduped SHAs from git log.
  if (all.shellCommandsSeen > 0) {
    out.push(`  ${chalk.gray(`${all.gitCommits} commits · ${all.gitPushes} pushes (seen in shell commands)`)}`);
  } else {
    out.push(`  ${chalk.gray('commits  —  not measurable for this harness')}`);
  }

  renderHours(all.messageHours, out);

  // Concurrency — direct evidence that a single-account view would be wrong.
  if (meta.overlap.overlappingPairs > 0) {
    out.push('');
    out.push(chalk.bold('Parallel sessions'));
    out.push(`  ${chalk.cyan(String(meta.overlap.sessionsInvolved))} ${chalk.gray('sessions ran alongside another')}`);
    // Pairs, not sessions — stated as pairs so the two numbers are not read as a
    // subset of each other.
    const crossNote = meta.overlap.crossAccountPairs > 0
      ? `, ${meta.overlap.crossAccountPairs} of them across two different accounts`
      : '';
    out.push(chalk.gray(`  ${meta.overlap.overlappingPairs} overlapping pairs${crossNote}`));
  }

  if (meta.filteredOut > 0) {
    out.push('');
    out.push(chalk.gray(`  ${meta.filteredOut} sessions excluded as too short (under ${meta.minMessages} messages or 1 minute).`));
  }
  if (meta.unreadable > 0) {
    if (meta.filteredOut === 0) out.push('');
    out.push(chalk.yellow(`  ${meta.unreadable} transcripts could not be read; their behaviour is missing from these totals.`));
  }
  if (all.gapsOverCeiling > 0) {
    out.push(chalk.gray(
      `  ${all.gapsOverCeiling} gaps over an hour excluded from p50/p90 (still counted as silent stall: 1h+ when the assistant last spoke).`,
    ));
  }
  out.push('');
  out.push(chalk.gray('  `agents insights --by project` to see it per repo'));
  out.push(chalk.gray('  `agents insights --narrative` for a written read on what to change'));
  console.log(out.join('\n'));
}

interface ReportMeta {
  since?: string;
  scanned: number;
  analyzed: number;
  filteredOut: number;
  /** Transcripts that could not be read; reported, never silently zeroed. */
  unreadable: number;
  minMessages: number;
  overlap: ReturnType<typeof detectOverlap>;
}

/**
 * The opt-in coaching layer. Pipes the AGGREGATE through a headless `claude -p` — never
 * raw transcripts, unlike `/insights`, which ships session text to the API. Reuses
 * whatever account the shim resolves, so there is no API key handling here.
 */
async function renderNarrative(payload: unknown): Promise<void> {
  const prompt = [
    'You are reading a developer\'s own coding-session telemetry, already aggregated.',
    'Write a short, direct read for them. Four sections, 2-3 sentences each:',
    '1. What is working — the patterns worth keeping.',
    '2. What is costing you — split into the assistant\'s fault vs your own workflow.',
    '3. Quick wins — concrete, tied to a number in the data.',
    '4. Worth trying — one more ambitious workflow change.',
    '',
    'Silent stalls (required): if frictionSignals contain "silent stall: …" or',
    'correctionSignals contain "resume after silent stall" / "continue / keep going",',
    'call that out explicitly in section 2 or 3 with the counts. Those mean the model',
    'stopped mid-session and sat idle until the human pinged it (timestamps: last',
    'assistant event → next user message ≥ 5 minutes). Do not reframe them as the',
    'user being slow unless the data only shows short reply gaps.',
    'Be specific and cite the numbers. No preamble, no flattery, no bullet padding.',
    '',
    JSON.stringify(payload),
  ].join('\n');

  try {
    const { stdout } = await execFileAsync('claude', ['-p', prompt], {
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    // stderr, always. Under --json stdout is a machine contract, and prose appended
    // after the closing brace makes the payload unparseable; on a TTY stderr renders
    // identically, so there is nothing to special-case.
    process.stderr.write('\n' + chalk.bold('Narrative') + '\n');
    process.stderr.write(stdout.trim().split('\n').map((l) => `  ${l}`).join('\n') + '\n');
  } catch (err) {
    const msg = (err as { code?: string }).code === 'ENOENT'
      ? 'claude is not on PATH'
      : ((err as Error).message ?? 'unknown error');
    console.error('');
    console.error(chalk.red(`✗ narrative unavailable: ${msg}`));
    console.error(chalk.gray('  The report above is complete; only the written section was skipped.'));
    // A scripted caller asked for this section and did not get it. Say so in the exit
    // code rather than reporting success for a partial result.
    process.exitCode = 1;
  }
}

async function insightsAction(options: InsightsOptions): Promise<void> {
  const dim = resolveGroup(options.by);
  const minMessages = Number.parseInt(options.minMessages ?? '2', 10);
  if (!Number.isFinite(minMessages) || minMessages < 0) {
    console.error(chalk.red('error: --min-messages must be a non-negative integer'));
    process.exit(1);
  }
  // `--all` is the spelling people reach for; `--since all` is what the window parser
  // speaks. Accept both rather than failing on an unknown option, and let an explicit
  // --since win so `--all --since 7d` is not silently contradictory.
  const since = options.since ?? (options.all ? 'all' : '30d');
  const sinceMs = since === 'all' ? undefined : parseTimeFilter(since);

  // Refresh the index first, exactly as `agents insights cost` does, so a report never silently
  // describes a stale picture of disk.
  await discoverSessions({ all: true, since: since === 'all' ? undefined : since, limit: 1 });
  if (options.refresh) clearSessionInsights();

  const filter: QueryOptions = { sinceMs };
  const scanned = querySessions(filter);

  const wanted = options.account?.toLowerCase();
  const inScope = scanned.filter((m) => {
    if (options.agent?.length && !options.agent.includes(m.agent)) return false;
    if (!wanted) return true;
    return [m.accountKey, m.account, m.accountOrg]
      .some((v) => v?.toLowerCase().includes(wanted));
  });

  const substantive = inScope.filter((m) => isSubstantive(m, minMessages));
  const filteredOut = inScope.length - substantive.length;

  const isTty = process.stdout.isTTY && !options.json;
  const { facets: facetsById, unreadable } = await collectFacets(substantive, (done, total) => {
    if (isTty && done < total) process.stderr.write(`\rReading transcripts ${done}/${total}…`);
    else if (isTty) process.stderr.write('\r'.padEnd(40) + '\r');
  });

  const spans: SessionSpan[] = substantive.map((m) => {
    const start = new Date(m.timestamp).getTime();
    return {
      id: m.id,
      accountKey: m.accountKey ?? `unattributed:${m.agent}`,
      startMs: start,
      endMs: start + (m.durationMs ?? 0),
    };
  });
  const overlap = detectOverlap(spans);
  const groups = buildGroups(substantive, facetsById, dim);
  const evidence = substantive.flatMap((m) => {
    const facets = facetsById.get(m.id);
    return facets ? [{ id: m.id, facets }] : [];
  });
  const actions = buildInsightActions(evidence);
  const harnesses = topEntries(substantive.reduce<Record<string, number>>((counts, row) => {
    counts[row.agent] = (counts[row.agent] ?? 0) + 1;
    return counts;
  }, {}), 20);

  if (options.json) {
    const payload = {
      generatedAt: new Date().toISOString(),
      window: { since: since === 'all' ? null : since },
      scanned: inScope.length,
      analyzed: substantive.length,
      filteredOut,
      unreadable,
      minMessages,
      by: dim,
      overlap,
      // Built from frictionSignals/correctionSignals/automationSignals together
      // (buildInsightActions) — same paid friction/correction data as above.
      actions,
      harnesses,
      groups: groups.map((g) => ({
        key: g.key,
        label: g.label,
        sessions: g.sessions,
        costUsd: g.costUsd,
        durationMs: g.durationMs,
        outputTokens: g.outputTokens,
        ...{
          ...g.facets,
          responseGapP50: Math.round(percentile(g.facets.responseGaps, 50)),
          responseGapP90: Math.round(percentile(g.facets.responseGaps, 90)),
          responseGapBuckets: bucketGaps(g.facets.responseGaps),
          // The raw sample is large and uninteresting once bucketed.
          responseGaps: undefined,
        },
      })),
    };
    console.log(JSON.stringify(payload, null, 2));
    if (options.narrative) await renderNarrative(payload);
    return;
  }

  renderReport(groups, dim, {
    since: since === 'all' ? undefined : since,
    scanned: inScope.length,
    analyzed: substantive.length,
    filteredOut,
    unreadable,
    minMessages,
    overlap,
  }, actions, harnesses);

  if (options.narrative) {
    await renderNarrative(groups.map((g) => ({
        account: g.label, sessions: g.sessions, costUsd: g.costUsd,
        topTools: topEntries(g.facets.toolCounts, 8),
        languages: topEntries(g.facets.languages, 6),
        errorCategories: topEntries(g.facets.errorCategories, 6),
        interruptions: g.facets.interruptions,
        linesTouchedAfter: g.facets.linesTouchedAfter, linesTouchedBefore: g.facets.linesTouchedBefore,
        gitCommits: g.facets.gitCommits,
        replyP50s: Math.round(percentile(g.facets.responseGaps, 50)),
      })));
  }
}

function configureInsightsCommand(cmd: Command): void {
  addHostOption(cmd)
    .description('How work looks — behavioural report (default) or counter mix (`mix`, recipes)')
    .option('--json', 'Output the full report as JSON')
    .option('--since <time>', 'Window: 7d, 4w, 3mo, an ISO date, or "all" (default 30d)')
    .option('--all', 'Every session ever indexed. Alias for --since all')
    .option('--by <dimension>', 'Group by: account (default), agent, project, or day')
    .option('--account <match>', 'Only sessions whose account key, email, or org contains this')
    .option('--agent <id>', 'Only these harnesses; repeat for more than one', collectAgent, [])
    .option('--min-messages <n>', 'Skip sessions under this many messages, both roles counted (default 2)')
    .option('--refresh', 'Discard cached facets and re-read every transcript')
    .option('--narrative', 'Add a written read on the numbers via a headless `claude -p`')
    .action(async (options: InsightsOptions) => {
      const inherited = cmd.parent?.name() === 'sessions'
        ? cmd.parent.opts() as Record<string, unknown>
        : {};
      const inheritedAgent = typeof inherited.agent === 'string' ? [inherited.agent] : [];
      const rawAgents = agentsFromArgv(process.argv.slice(2));
      await insightsAction({
        ...inherited,
        ...options,
        agent: rawAgents.length > 0 ? rawAgents : [...inheritedAgent, ...(options.agent ?? [])],
        json: options.json ?? inherited.json as boolean | undefined,
        since: options.since ?? inherited.since as string | undefined,
      });
    });

  // Cheap counter recipes (former top-level `agents trends`) — same parent, no peer verb.
  registerMixCommands(cmd);

  setHelpSections(cmd, {
    examples: `
      # Behavioural report — last 30 days, split by Claude account (default)
      agents insights

      # Which repo is eating the time
      agents insights --by project --since 90d

      # Counter mix board (harness/model/token/secrets recipes) — former agents trends
      agents insights mix
      agents insights mix --days 30
      agents insights mix harness-mix --json
      agents insights query --kind secret --days 7

      # One account only, all of its history
      agents insights --account "Turing Labs" --all

      # Machine-readable, for a dashboard or a slash command
      agents sessions insights --agent claude --agent codex --json

      # Add a written read on what to change
      agents insights --narrative
    `,
    notes: `
      Two paths under one verb:
        bare \`agents insights\`     — transcript behaviour (tools, friction, rhythm, by account)
        \`agents insights mix\`      — cheap counters from sessions.db + usage.db
      Latency is \`agents insights perf\` (not mix). Quota is \`agents view\`. Spend is
      \`agents insights cost\`; shipped output is \`agents insights output\`. Skill/slash popularity
      is \`agents sessions stats\`. Former top-level \`agents trends\` is \`agents insights mix\`.
      One recipe is \`agents insights mix <recipe>\` (e.g. \`harness-mix\`); \`--list\` names them.

      The behavioural report parses in-scope transcripts once and caches facets; later runs
      re-read only files that changed. \`--refresh\` forces a full re-read.

      \`agents insights\` is the top-level alias of \`agents sessions insights\`.
      Repeat \`--agent\` to compare several harnesses in one report.

      Everything except \`--narrative\` is local and makes no network calls.
    `,
  });
}

export function registerInsightsCommand(program: Command): void {
  const cmd = program.command('insights');
  configureInsightsCommand(cmd);
  registerCostCommand(cmd);
  registerOutputCommand(cmd);
  // Latency rollups (former top-level `agents perf` → `agents insights perf`,
  // PHNX-3391). A sibling observe verb of cost/output, so it lives on the
  // top-level insights group beside them, not under `sessions insights`.
  registerPerfSubcommand(cmd);
}

export function registerSessionsInsightsCommand(sessions: Command): void {
  configureInsightsCommand(sessions.command('insights'));
}
