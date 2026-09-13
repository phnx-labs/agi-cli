/**
 * `agents sessions trace <selectors...>` (alias: `agents trace <selectors...>`) —
 * render one session as a derived trajectory, or two as a compare.
 *
 * One model (`buildTrajectory`), three renderings, audience auto-selected: a
 * person at a TTY gets the self-contained HTML opened in a browser; a piped or
 * headless caller (an agent) gets the compact text trajectory; `--json` emits the
 * versioned envelope the AGI EXT Fleet panel and triaging agents consume. Explicit
 * `--html/--text/--json` always win.
 *
 * Exactly two resolved selectors turn the single trajectory into a **compare**
 * (`diffTrajectories`, PR2/3) — the same three renderings, laid on a shared axis
 * with a divergence marker. `--tree` turns one selector into a **lineage**
 * (`buildLineage`, PR3/3): the orchestrator and every session it spawned, edges
 * read from the team records. Three or more selectors still fail loud.
 */
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import type { Command } from 'commander';
import { setHelpSections } from '../lib/help.js';
import { showFile } from '../lib/open-url.js';
import { knownSecretValuesFromEnv } from '../lib/redact.js';
import { getCacheDir } from '../lib/state.js';
import { discoverSessions } from '../lib/session/discover.js';
import { parseSession } from '../lib/session/parse.js';
import { foldTimeline, projectSessionFiles, projectTimeline } from '../lib/session/timeline.js';
import { parseTimelineEvents } from '../lib/session/timeline-pass.js';
import type { SessionMeta, SessionStep } from '../lib/session/types.js';
import { buildTrajectory } from '../lib/session/trajectory.js';
import { diffTrajectories } from '../lib/session/trajectory-compare.js';
import { buildLineage } from '../lib/session/trajectory-lineage.js';
import { renderTrajectoryHtml, renderTrajectoryCompareHtml, renderLineageHtml } from '../lib/session/trajectory-html.js';
import { renderTrajectoryText, renderTrajectoryCompareText, renderLineageText } from '../lib/session/trajectory-text.js';
import type { SessionTrajectory } from '../lib/session/trajectory.js';
import type {
  TrajectoryComparison,
  TrajectoryDivergence,
  TrajectorySummary,
} from '../lib/session/trajectory-compare.js';
import type { TrajectoryStep } from '../lib/session/trajectory.js';
import type { LineageEdge, LineageNode, SessionLineage } from '../lib/session/trajectory-lineage.js';
import { parseAgentFilter } from './sessions.js';
import { selectSessions } from './sessions-export.js';

/** Versioned envelope emitted by `--json` — the stable contract for consumers. */
export const SESSIONS_TRACE_SCHEMA_VERSION = 1;

/** The `diff` block of a `layout: 'compare'` envelope — everything but the two full trajectories, which already ride `sessions`. */
interface SessionsTraceDiffEnvelope {
  divergence?: TrajectoryDivergence;
  added: TrajectoryStep[];
  removed: TrajectoryStep[];
  summaryA: TrajectorySummary;
  summaryB: TrajectorySummary;
  truncatedA: number;
  truncatedB: number;
}

/** The `lineage` block of a `layout: 'lineage'` envelope — the delegation graph. */
interface SessionsTraceLineageEnvelope {
  rootId: string;
  nodes: LineageNode[];
  edges: LineageEdge[];
  teams: string[];
  unresolvedParentIds: string[];
}

/** The `--json` envelope: the versioned contract for the ext / triaging agents. */
interface SessionsTraceEnvelope {
  schemaVersion: typeof SESSIONS_TRACE_SCHEMA_VERSION;
  kind: 'sessions-trace';
  layout: 'single' | 'compare' | 'lineage';
  sessions: SessionTrajectory[];
  diff?: SessionsTraceDiffEnvelope;
  lineage?: SessionsTraceLineageEnvelope;
}

/** Build the versioned `--json` envelope for a single-session trajectory. */
export function buildTraceEnvelope(models: SessionTrajectory[]): SessionsTraceEnvelope {
  return {
    schemaVersion: SESSIONS_TRACE_SCHEMA_VERSION,
    kind: 'sessions-trace',
    layout: 'single',
    sessions: models,
  };
}

/** Build the versioned `--json` envelope for a two-session compare. */
export function buildCompareTraceEnvelope(cmp: TrajectoryComparison): SessionsTraceEnvelope {
  return {
    schemaVersion: SESSIONS_TRACE_SCHEMA_VERSION,
    kind: 'sessions-trace',
    layout: 'compare',
    sessions: [cmp.a, cmp.b],
    diff: {
      divergence: cmp.divergence,
      added: cmp.added,
      removed: cmp.removed,
      summaryA: cmp.summaryA,
      summaryB: cmp.summaryB,
      truncatedA: cmp.truncatedA,
      truncatedB: cmp.truncatedB,
    },
  };
}

/**
 * Build the versioned `--json` envelope for a lineage. `sessions` carries the
 * ROOT's trajectory only: the graph's own numbers come from the indexed session
 * rows, so a consumer pays one transcript parse instead of one per teammate —
 * `agents sessions trace <child>` is how you get a child's full trajectory.
 */
export function buildLineageTraceEnvelope(
  lineage: SessionLineage,
  rootTrajectory: SessionTrajectory,
): SessionsTraceEnvelope {
  return {
    schemaVersion: SESSIONS_TRACE_SCHEMA_VERSION,
    kind: 'sessions-trace',
    layout: 'lineage',
    sessions: [rootTrajectory],
    lineage: {
      rootId: lineage.rootId,
      nodes: lineage.nodes,
      edges: lineage.edges,
      teams: lineage.teams,
      unresolvedParentIds: lineage.unresolvedParentIds,
    },
  };
}

interface TraceOptions {
  html?: boolean;
  text?: boolean;
  json?: boolean;
  output?: string;
  open?: boolean; // --no-open sets this false
  errorsOnly?: boolean;
  steps?: boolean;
  redact?: boolean; // --no-redact sets this false
  all?: boolean;
  since?: string;
  limit?: string;
  agent?: string;
  compare?: boolean;
  tree?: boolean;
}

type RenderFormat = 'html' | 'text' | 'json';

/**
 * Pick the rendering by audience: explicit `--html/--text/--json` win; otherwise
 * a person at a TTY gets the visual HTML and a piped/headless caller (an agent)
 * gets the compact text trajectory.
 */
export function chooseFormat(options: TraceOptions, isTTY: boolean): RenderFormat {
  if (options.json) return 'json';
  if (options.html) return 'html';
  if (options.text) return 'text';
  return isTTY ? 'html' : 'text';
}

/**
 * Decide the trace layout from what the user TYPED (`selectorCount`) vs what
 * those selectors RESOLVED to (`resolvedCount`). Keyed on selector count so a
 * single content-search selector that happens to match two sessions never
 * silently becomes a compare — every unsupported combination fails loud with a
 * clear message. Pure, so the boundaries are unit-tested without the command.
 */
export function decideTraceLayout(
  options: Pick<TraceOptions, 'tree' | 'compare'>,
  selectorCount: number,
  resolvedCount: number,
): 'single' | 'compare' | 'lineage' {
  if (options.tree) {
    if (options.compare) {
      throw new Error('`--tree` (lineage) and `--compare` are different layouts — pass one or the other.');
    }
    if (selectorCount !== 1) {
      throw new Error(
        `Lineage roots at ONE session; you passed ${selectorCount} selectors. ` +
        'Pass the orchestrator session whose team you want to see.',
      );
    }
    if (resolvedCount !== 1) {
      throw new Error(
        `The selector must match exactly one session to root a lineage; it matched ${resolvedCount}. ` +
        'Use a more specific selector (e.g. the full session id).',
      );
    }
    return 'lineage';
  }
  const wantCompare = options.compare === true || selectorCount >= 2;
  if (wantCompare) {
    if (selectorCount !== 2) {
      throw new Error(
        `Comparing needs exactly two selectors; you passed ${selectorCount}. ` +
        'Pass two session selectors (ids or queries), each matching one session.',
      );
    }
    if (resolvedCount !== 2) {
      throw new Error(
        `Each selector must match exactly one session to compare; the two selectors matched ${resolvedCount}. ` +
        'Use more specific selectors (e.g. full session ids).',
      );
    }
    return 'compare';
  }
  if (resolvedCount > 1) {
    throw new Error(
      `${resolvedCount} sessions matched — pass a more specific selector for one trajectory, ` +
      'or two selectors to compare them.',
    );
  }
  return 'single';
}

/** One step's counters, rendered as the sidebar renders them: `6 run · 2 blocked`. */
function stepDetail(step: SessionStep): string {
  const mix = Object.entries(step.mix ?? {})
    .filter(([, count]) => (count ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([verb, count]) => `${count} ${verb}`);
  return [
    ...mix,
    step.failed ? `${step.failed} failed` : '',
    step.blocked ? `${step.blocked} blocked` : '',
    ...(step.marks ?? []),
  ].filter(Boolean).join(' · ');
}

/**
 * Render one session's narration-anchored step list — the same fold the daemon
 * caches and the sidebar renders, computed here from the transcript so the
 * command works for any session, live or closed, cached or not.
 */
export function renderSessionSteps(
  session: SessionMeta,
  options: { redact?: boolean; knownSecrets?: readonly string[] } = {},
): string {
  const state = foldTimeline(parseTimelineEvents(session.filePath, session.agent), undefined, {});
  const timeline = projectTimeline(state, undefined, state.steps.length, options);
  if (!timeline.steps.length) {
    return `No steps folded for ${session.shortId || session.id}` +
      `${timeline.reason ? ` — ${timeline.reason}` : ''}\n`;
  }
  const startMs = state.firstMs ?? Date.parse(timeline.steps[0].at);
  const lines = timeline.steps.map((step, index) => {
    const offsetS = Math.max(0, Math.round((Date.parse(step.at) - startMs) / 1000));
    const detail = stepDetail(step);
    return [
      String(index + 1).padStart(2),
      `+${offsetS}s`.padStart(7),
      step.source.slice(0, 4).padEnd(4),
      step.text,
      detail ? `· ${detail}` : '',
    ].filter(Boolean).join('  ');
  });
  const files = projectSessionFiles(state);
  const footer = [
    `${timeline.steps.length} steps`,
    `${timeline.tools} tools`,
    timeline.failed ? `${timeline.failed} failed` : '',
    timeline.blocked ? `${timeline.blocked} blocked` : '',
    files ? `${files.total} file${files.total === 1 ? '' : 's'} changed` : '',
  ].filter(Boolean).join(' · ');
  return `${lines.join('\n')}\n\n${footer}\n`;
}

/** Attach the trace behaviour to a command node (canonical or top-level alias). */
function configureTraceCommand(cmd: Command): Command {
  cmd
    .description('Visualize a session as a trajectory — a tool-call timeline you can read at a glance. Opens a visual for a person; prints a compact trajectory for an agent.')
    .option('--html', 'Force the HTML rendering (opens in a browser)')
    .option('--text', 'Force the compact text trajectory')
    .option('--json', 'Emit the versioned sessions-trace JSON envelope')
    .option('-o, --output <path>', 'Write the rendering to a path instead of opening/printing')
    .option('--no-open', 'Do not open the HTML; print its path instead')
    .option('--errors-only', 'Collapse the text trajectory to error steps and their neighbours')
    .option('--steps', 'Print the narration-anchored step list the sidebar shows (the same fold as the session row)')
    .option('--compare', 'Force the compare layout for exactly two selectors (this is also the default for two)')
    .option('--tree', 'Render the lineage of one session — it and every session it spawned')
    .option('--no-redact', 'Local-only: skip secret redaction of derived labels (never for a shared file)')
    .option('--all', 'Search every directory and all time, not just this project')
    .option('--since <time>', 'Only sessions newer than this (7d, 4w, an ISO date)')
    .option('--limit <n>', 'Max sessions to scan when resolving the selector (default 100)')
    .option('-a, --agent <agent>', 'Filter by agent type (e.g. claude, codex)');

  setHelpSections(cmd, {
    examples: `# Open one session's trajectory in a browser (a person at a terminal)
agents sessions trace a1b2c3d4

# The compact text trajectory an agent reads in-context
agents sessions trace a1b2c3d4 --text

# Just the failures and their neighbours — for a triaging agent
agents sessions trace a1b2c3d4 --text --errors-only

# What the agent said it was doing, step by step — the sidebar's timeline as text
agents sessions trace a1b2c3d4 --steps

# The stable JSON envelope for the AGI EXT Fleet panel or a tool
agents sessions trace a1b2c3d4 --json

# Write the self-contained HTML to a file without opening it
agents sessions trace a1b2c3d4 --html -o trace.html --no-open

# Two selectors — compare where a passing run and a failing one diverge
agents sessions trace a1b2c3d4 e5f6a7b8

# The compare, as text — for a triaging agent comparing harnesses
agents sessions trace a1b2c3d4 e5f6a7b8 --text

# The team an orchestrator spawned, as a graph (one selector + --tree)
agents sessions trace a1b2c3d4 --tree

# The same lineage as an indented tree an agent can read
agents sessions trace a1b2c3d4 --tree --text`,
    notes: `Audience auto-select: with no --html/--text/--json, HTML opens on a TTY (a person) and
the compact text trajectory prints when piped or headless (an agent). The HTML is self-contained
(no CDN, no external asset) and redacted by default, as safe to share as an 'agents sessions share' page.

One selector renders the single trajectory; exactly two selectors compare them (a shared time axis,
the first divergence point, and the step-level diff); one selector with --tree renders its lineage —
the session and every session it spawned, with the edges read from the teams records
(teamOrigin.parentSessionId), never from an inline Task sub-agent, which is a step inside one transcript
and has no session of its own. --json emits { schemaVersion, kind: 'sessions-trace',
layout: 'single' | 'compare' | 'lineage', sessions: [SessionTrajectory], diff?, lineage? } — the contract
consumers read so nothing re-parses a transcript.

Lineage resolves children from the scanned pool, so a very old team may need a wider --limit or --since.
Three or more selectors, and --tree with more than one selector, fail loud.`,
  });

  cmd.action(async (selectors: string[], _options: TraceOptions, command: Command) => {
    // Merge parent globals: under `agents sessions trace`, the `sessions` command
    // owns `--json`/`--no-redact`/`--all`/`--agent`/`--since` and captures them, so
    // read the merged view (as `render`/`insights` do) — the top-level `agents
    // trace` alias has no such parent and its own options fill the same fields.
    const options = command.optsWithGlobals() as TraceOptions;
    // Lineage resolves its children FROM the scanned pool, and a teammate can sit
    // well below the orchestrator in recency order, so --tree scans wider by
    // default than the single/compare layouts. An explicit --limit still wins.
    const defaultLimit = options.tree ? 500 : 100;
    const limit = Math.max(1, Number.parseInt(options.limit || String(defaultLimit), 10) || defaultLimit);
    const agent = parseAgentFilter(options.agent).agent;
    const pool = await discoverSessions({
      // Default to every directory so an id from any project resolves, matching
      // `agents sessions render` (sessions-render.ts:126).
      all: options.all !== false,
      since: options.since,
      limit,
      agent: agent ?? undefined,
    });
    const sessions = selectSessions(pool, selectors);

    if (sessions.length === 0) {
      process.stderr.write(chalk.yellow('No sessions matched the selection.\n'));
      process.exitCode = 1;
      return;
    }

    // Layout is keyed on what the USER TYPED (selector count), not the resolved
    // count — a single content-search selector matching two sessions must NOT
    // silently become a compare. All the fail-loud boundaries live in the pure
    // decideTraceLayout so they are unit-tested (see sessions-trace.test.ts).
    if (options.steps && selectors.length > 1) {
      throw new Error('--steps renders one session\'s step list; pass a single selector.');
    }
    const layout = decideTraceLayout(options, selectors.length, sessions.length);

    const redact = options.redact !== false;
    const knownSecrets = redact ? knownSecretValuesFromEnv() : undefined;
    const format = chooseFormat(options, Boolean(process.stdout.isTTY));

    const buildOne = (session: (typeof sessions)[number]): SessionTrajectory => {
      const events = parseSession(session.filePath, session.agent);
      return buildTrajectory(events, session, { redact, knownSecrets });
    };

    if (layout === 'lineage') {
      // The pool must keep team-origin rows: they are hidden from the ordinary
      // listing by default (AGENTS.md invariant 7), and they ARE the children.
      // discoverSessions does not apply that presentation filter, so `pool` is
      // already the teams-included set the graph needs.
      const root = sessions[0];
      // An id-shaped selector resolves through the session INDEX, which reaches
      // rows the scanned pool does not hold (selectSessions -> findSessionsById,
      // sessions-export.ts:386). Seed the pool with the resolved root so the
      // graph always roots where the user pointed.
      const pooled = pool.some((s) => s.id === root.id) ? pool : [root, ...pool];
      const lineage = buildLineage(pooled, { rootId: root.id });
      const idPart = root.shortId || root.id;

      if (format === 'json') {
        const out = JSON.stringify(buildLineageTraceEnvelope(lineage, buildOne(root)), null, 2) + '\n';
        if (options.output) {
          fs.writeFileSync(options.output, out, { mode: 0o600 });
          process.stderr.write(chalk.green(`Wrote lineage JSON to ${options.output}\n`));
        } else {
          process.stdout.write(out);
        }
        return;
      }

      if (format === 'text') {
        const out = renderLineageText(lineage);
        if (options.output) {
          fs.writeFileSync(options.output, out, { mode: 0o600 });
          process.stderr.write(chalk.green(`Wrote lineage text to ${options.output}\n`));
        } else {
          process.stdout.write(out);
        }
        return;
      }

      // HTML.
      const html = renderLineageHtml(lineage, redact);
      if (options.output) {
        fs.writeFileSync(options.output, html, { mode: 0o600 });
        process.stdout.write(`${path.resolve(options.output)}\n`);
        return;
      }
      const dir = path.join(getCacheDir(), 'traces');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${idPart}-lineage-${Date.now()}.html`);
      fs.writeFileSync(file, html, { mode: 0o600 });
      if (options.open === false) {
        process.stdout.write(`${file}\n`);
      } else {
        await showFile(file);
        process.stderr.write(chalk.green(`Opened lineage for ${idPart}: ${file}\n`));
      }
      return;
    }

    if (layout === 'compare') {
      const cmp = diffTrajectories(buildOne(sessions[0]), buildOne(sessions[1]));
      const idPart = `${sessions[0].shortId || sessions[0].id}-vs-${sessions[1].shortId || sessions[1].id}`;

      if (format === 'json') {
        const out = JSON.stringify(buildCompareTraceEnvelope(cmp), null, 2) + '\n';
        if (options.output) {
          fs.writeFileSync(options.output, out, { mode: 0o600 });
          process.stderr.write(chalk.green(`Wrote compare JSON to ${options.output}\n`));
        } else {
          process.stdout.write(out);
        }
        return;
      }

      if (format === 'text') {
        const out = renderTrajectoryCompareText(cmp);
        if (options.output) {
          fs.writeFileSync(options.output, out, { mode: 0o600 });
          process.stderr.write(chalk.green(`Wrote compare text to ${options.output}\n`));
        } else {
          process.stdout.write(out);
        }
        return;
      }

      // HTML.
      const html = renderTrajectoryCompareHtml(cmp);
      if (options.output) {
        fs.writeFileSync(options.output, html, { mode: 0o600 });
        process.stdout.write(`${path.resolve(options.output)}\n`);
        return;
      }
      const dir = path.join(getCacheDir(), 'traces');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${idPart}-${Date.now()}.html`);
      fs.writeFileSync(file, html, { mode: 0o600 });
      if (options.open === false) {
        process.stdout.write(`${file}\n`);
      } else {
        await showFile(file);
        process.stderr.write(chalk.green(`Opened compare for ${idPart}: ${file}\n`));
      }
      return;
    }

    // One selector — the single-session trajectory.
    const session = sessions[0];

    // --steps is the CLI door to the timeline fold the sidebar renders, so an
    // agent can read what a session DID without the extension (PHNX-3939). It is
    // a different model from the trajectory (narration beats, not tool steps),
    // so it short-circuits before buildTrajectory rather than reshaping it.
    if (options.steps) {
      const out = renderSessionSteps(session, { redact, knownSecrets });
      if (options.output) {
        fs.writeFileSync(options.output, out, { mode: 0o600 });
        process.stderr.write(chalk.green(`Wrote step list to ${options.output}\n`));
      } else {
        process.stdout.write(out);
      }
      return;
    }

    const model = buildOne(session);

    if (format === 'json') {
      const out = JSON.stringify(buildTraceEnvelope([model]), null, 2) + '\n';
      if (options.output) {
        fs.writeFileSync(options.output, out, { mode: 0o600 });
        process.stderr.write(chalk.green(`Wrote trajectory JSON to ${options.output}\n`));
      } else {
        process.stdout.write(out);
      }
      return;
    }

    if (format === 'text') {
      const out = renderTrajectoryText(model, { errorsOnly: options.errorsOnly === true });
      if (options.output) {
        fs.writeFileSync(options.output, out, { mode: 0o600 });
        process.stderr.write(chalk.green(`Wrote text trajectory to ${options.output}\n`));
      } else {
        process.stdout.write(out);
      }
      return;
    }

    // HTML.
    const html = renderTrajectoryHtml(model);
    if (options.output) {
      fs.writeFileSync(options.output, html, { mode: 0o600 });
      process.stdout.write(`${path.resolve(options.output)}\n`);
      return;
    }
    const dir = path.join(getCacheDir(), 'traces');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${session.shortId || session.id}-${Date.now()}.html`);
    fs.writeFileSync(file, html, { mode: 0o600 });
    if (options.open === false) {
      process.stdout.write(`${file}\n`);
    } else {
      await showFile(file);
      process.stderr.write(chalk.green(`Opened trajectory for ${session.shortId || session.id}: ${file}\n`));
    }
  });

  return cmd;
}

/** Canonical `agents sessions trace <selectors...>`. */
export function registerSessionsTraceCommand(sessionsCmd: Command): void {
  configureTraceCommand(sessionsCmd.command('trace <selectors...>'));
}

/** Top-level alias `agents trace <selectors...>` (mirrors `agents insights`). */
export function registerTraceCommand(program: Command): void {
  configureTraceCommand(program.command('trace <selectors...>'));
}
