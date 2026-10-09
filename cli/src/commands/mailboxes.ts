import type { Command } from 'commander';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import { die, humanDuration, relTime, truncate, visibleWidth } from '../lib/format.js';
import { setHelpSections } from '../lib/help.js';
import {
  listBoxes,
  readBox,
  mailboxDir,
  isValidMailboxId,
  watchMessages,
  type StoredMessage,
  type CommsMsg,
} from '../lib/mailbox.js';
import { gcMailbox, type GcResult } from '../lib/mailbox-gc.js';
import {
  GLYPH,
  masthead,
  sparkline,
  aggregate,
  hourlyCounts,
  graphEdges,
} from '../lib/comms-render.js';
import { getMailboxRootDir } from '../lib/state.js';
import { getActiveSessions, type ActiveSession } from '../lib/session/active.js';
import { mailboxIdForActiveSession } from '../lib/mailbox-target.js';

interface BoxView {
  id: string;
  label: string;
  live: boolean;
  messages: StoredMessage[];
}

interface Filters {
  from?: string;
  to?: string;
  sinceMs?: number;
}

function labelForBox(id: string, byMailbox: Map<string, ActiveSession>): { label: string; live: boolean } {
  const s = byMailbox.get(id);
  if (s) {
    const topic = s.name || s.topic || s.label;
    return { label: topic ? truncate(topic, 40) : id.slice(0, 8), live: true };
  }
  return { label: id.slice(0, 8), live: false };
}

async function collectBoxes(root: string): Promise<BoxView[]> {
  let sessions: ActiveSession[] = [];
  try {
    sessions = await getActiveSessions();
  } catch {
  }
  const byMailbox = new Map<string, ActiveSession>();
  for (const s of sessions) {
    const mid = mailboxIdForActiveSession(s);
    if (mid) byMailbox.set(mid, s);
  }
  return listBoxes(root).map((id) => {
    const { label, live } = labelForBox(id, byMailbox);
    return { id, label, live, messages: readBox(mailboxDir(id, root)) };
  });
}

function pending(box: BoxView): number {
  return box.messages.filter((m) => m.state !== 'consumed').length;
}

function senderOf(m: StoredMessage): string {
  return m.from || 'operator';
}

const STATE_TAG: Record<StoredMessage['state'], string> = {
  inbox: chalk.yellow('pending'),
  processing: chalk.cyan('in-flight'),
  consumed: chalk.dim('delivered'),
};

function selfMailboxId(): string | undefined {
  const dir = process.env.AGENTS_MAILBOX_DIR;
  if (!dir) return undefined;
  const id = path.basename(dir.replace(/[/\\]+$/, ''));
  return id || undefined;
}

function parseSinceArg(s: string): number {
  const m = s.match(/^(\d+)([smhdw])$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unitMs: Record<string, number> = {
      s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000,
    };
    return Date.now() - n * unitMs[m[2]];
  }
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) die(`Invalid --since value: ${JSON.stringify(s)} (use e.g. 2h, 7d, or an ISO date).`);
  return ms;
}

function buildFilters(opts: { from?: string; to?: string; since?: string }): Filters {
  return {
    from: opts.from,
    to: opts.to,
    sinceMs: opts.since ? parseSinceArg(opts.since) : undefined,
  };
}

function hasFilters(f: Filters): boolean {
  return Boolean(f.from || f.to || f.sinceMs != null);
}

function matchesFilters(msg: { from: string; ts: string }, toLabel: string, boxId: string, f: Filters): boolean {
  if (f.sinceMs != null) {
    const t = Date.parse(msg.ts);
    if (Number.isNaN(t) || t < f.sinceMs) return false;
  }
  if (f.from && !msg.from.toLowerCase().includes(f.from.toLowerCase())) return false;
  if (f.to && !toLabel.toLowerCase().includes(f.to.toLowerCase()) && !boxId.toLowerCase().includes(f.to.toLowerCase())) return false;
  return true;
}

function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function renderOverview(boxes: BoxView[], limit: number, filters: Filters): void {
  const nonEmpty = boxes.filter((b) => b.messages.length > 0);
  if (nonEmpty.length === 0) {
    console.log(chalk.dim('No mailboxes with messages. Boxes are created on the first `agents message`.'));
    return;
  }

  const msgs = aggregate(nonEmpty);
  const live = boxes.filter((b) => b.live).length;
  const awaiting = msgs.filter((m) => m.state !== 'consumed').length;
  console.log(masthead({
    title: 'fleet comms',
    host: os.hostname(),
    accent: 'cyan',
    right: `${live} live · ${boxes.length} boxes`,
    stats: [`${msgs.length} messages`, `${awaiting} awaiting delivery`, `last ${relTime(msgs[0].ts)}`],
  }));
  console.log(`  ${chalk.dim('24h')} ${chalk.cyan(sparkline(hourlyCounts(msgs, 24)))}`);
  console.log();

  const rows = [...nonEmpty].sort((a, b) => lastTs(b) - lastTs(a));
  for (const box of rows) {
    const p = pending(box);
    const dot = box.live ? chalk.green(GLYPH.live) : chalk.dim(GLYPH.idle);
    const counts = [
      p > 0 ? chalk.yellow(`${p} pending`) : null,
      chalk.dim(`${box.messages.length} total`),
    ].filter(Boolean).join(chalk.dim(' · '));
    const last = box.messages.length ? chalk.dim(relTime(newestMessage(box).ts)) : '';
    console.log(`  ${dot} ${chalk.bold(box.label.padEnd(40))} ${counts}  ${last}`);
    console.log(`    ${chalk.dim(box.id)}`);
  }

  const all = msgs
    .filter((m) => matchesFilters(m, m.toLabel, m.box, filters))
    .slice(0, limit);
  console.log();
  console.log(chalk.bold(`Recent messages`) + chalk.dim(` (${all.length})`));
  if (all.length === 0) {
    console.log(chalk.dim('  Nothing matches the current filters.'));
  }
  for (const m of all) {
    const when = chalk.dim(relTime(m.ts).padStart(10));
    const route = `${chalk.magenta(truncate(m.from, 24))} ${chalk.dim(GLYPH.route)} ${chalk.cyan(truncate(m.toLabel, 40))}`;
    console.log(`  ${when}  ${STATE_TAG[m.state]}  ${route}`);
    console.log(`    ${truncate(m.text.replace(/\s+/g, ' ').trim(), 100)}`);
  }
  console.log();
  console.log(chalk.dim('Tip: `agents mailboxes <id>` one box · `--watch` live tail · `--between <a> <b>` thread · `--graph` routes · `--json` machine output'));
}

async function runWatch(root: string, opts: { json?: boolean; filters: Filters }): Promise<void> {
  const boxes = await collectBoxes(root);
  const labels = new Map(boxes.map((b) => [b.id, b.label]));
  const self = selfMailboxId();

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on('SIGINT', onSigint);
  try {
    if (!opts.json) {
      console.log(masthead({
        title: 'fleet comms',
        host: os.hostname(),
        accent: 'cyan',
        right: chalk.green(GLYPH.live) + chalk.dim(' live'),
        stats: ['watching — ⌃C to stop'],
      }));
    }
    for await (const m of watchMessages(root, {
      signal: controller.signal,
      backfill: opts.filters.sinceMs != null,
    })) {
      const toLabel = labels.get(m.box) ?? m.toLabel;
      if (!matchesFilters(m, toLabel, m.box, opts.filters)) continue;
      const msg: CommsMsg = { ...m, toLabel };
      if (opts.json) {
        console.log(JSON.stringify(msg));
        continue;
      }
      const addressedToYou = self != null && m.to === self;
      const to = addressedToYou
        ? chalk.yellow(`${GLYPH.ask} you`)
        : chalk.cyan(truncate(toLabel, 24));
      const text = truncate(m.text.replace(/\s+/g, ' ').trim(), 100);
      console.log(`${chalk.dim(clockTime(m.ts))}  ${chalk.magenta(truncate(m.from, 24))} ${chalk.dim(GLYPH.stream)} ${to}   ${text}`);
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

function senderIsBox(from: string, box: BoxView): boolean {
  if (from === box.id) return true;
  if (from.length >= 4 && box.id.startsWith(from)) return true;
  return from.toLowerCase() === box.label.toLowerCase();
}

function renderBetween(boxes: BoxView[], a: string, b: string, json?: boolean): void {
  const resolveBox = (q: string): BoxView => {
    const found = boxes.find((x) => x.id === q)
      ?? boxes.find((x) => x.id.startsWith(q))
      ?? boxes.find((x) => x.label.toLowerCase().includes(q.toLowerCase()));
    if (!found) die(`No mailbox matching ${JSON.stringify(q)}. Run \`agents mailboxes\` to list boxes.`);
    return found;
  };
  const boxA = resolveBox(a);
  const boxB = resolveBox(b);
  if (boxA.id === boxB.id) die('--between needs two different boxes.');

  const thread: CommsMsg[] = [
    ...boxB.messages.filter((m) => senderIsBox(senderOf(m), boxA)).map((m) => ({
      from: senderOf(m), to: boxB.id, toLabel: boxB.label, ts: m.ts, text: m.text, state: m.state, box: boxB.id,
    })),
    ...boxA.messages.filter((m) => senderIsBox(senderOf(m), boxB)).map((m) => ({
      from: senderOf(m), to: boxA.id, toLabel: boxA.label, ts: m.ts, text: m.text, state: m.state, box: boxA.id,
    })),
  ].sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0));

  if (json) {
    console.log(JSON.stringify({
      a: { id: boxA.id, label: boxA.label },
      b: { id: boxB.id, label: boxB.label },
      count: thread.length,
      messages: thread,
    }, null, 2));
    return;
  }

  const span = thread.length >= 2
    ? humanDuration(Math.max(0, Date.parse(thread[thread.length - 1].ts) - Date.parse(thread[0].ts)))
    : '0s';
  console.log(
    `  ${chalk.magenta(boxA.label)} ${chalk.dim(GLYPH.thread)} ${chalk.cyan(boxB.label)}` +
    chalk.dim(`   ${thread.length} message${thread.length === 1 ? '' : 's'} · ${span}`),
  );
  if (thread.length === 0) {
    console.log(chalk.dim('  No messages between these boxes yet. Sender stamps match on box id or label.'));
    return;
  }
  console.log();
  for (const m of thread) {
    const when = chalk.dim(relTime(m.ts).padStart(10));
    const route = `${chalk.magenta(truncate(m.from, 24))} ${chalk.dim(GLYPH.route)} ${chalk.cyan(truncate(m.toLabel, 24))}`;
    console.log(`  ${when}  ${STATE_TAG[m.state]}  ${route}`);
    console.log(`    ${truncate(m.text.replace(/\s+/g, ' ').trim(), 100)}`);
  }
}

async function runGcCommand(opts: { json?: boolean }): Promise<void> {
  const sessions = await getActiveSessions();
  const activeBoxIds = new Set(
    sessions.map(mailboxIdForActiveSession).filter((id): id is string => !!id),
  );
  const result = gcMailbox(activeBoxIds);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.messagesDroppedDead === 0 && result.messagesDroppedExpired === 0) {
    console.log(chalk.dim(`gc: ${result.boxesScanned} boxes scanned, no pending messages dropped.`));
    return;
  }
  console.log(
    chalk.yellow(
      `gc: ${result.messagesDroppedDead} dead-box messages, ${result.messagesDroppedExpired} expired messages dropped ` +
        `(${result.boxesScanned} boxes scanned, ${result.deadBoxes} dead boxes).`,
    ),
  );
}

function renderGraph(boxes: BoxView[], filters: Filters, json?: boolean): void {
  const nonEmpty = boxes.filter((b) => b.messages.length > 0);
  const msgs = aggregate(nonEmpty).filter((m) => matchesFilters(m, m.toLabel, m.box, filters));
  const edges = graphEdges(msgs);
  if (json) {
    console.log(JSON.stringify(edges, null, 2));
    return;
  }
  console.log(masthead({
    title: 'fleet comms',
    host: os.hostname(),
    accent: 'cyan',
    right: `${edges.length} route${edges.length === 1 ? '' : 's'}`,
    stats: [`${msgs.length} messages`],
  }));
  console.log();
  if (edges.length === 0) {
    console.log(chalk.dim('  No cross-box routes yet.'));
    return;
  }
  for (const e of edges) {
    const route = `  ${chalk.magenta(truncate(e.from, 28))} ${chalk.dim('└─▶')} ${chalk.cyan(truncate(e.to, 40))}`;
    const dots = '.'.repeat(Math.max(2, 76 - visibleWidth(route)));
    console.log(`${route} ${chalk.dim(dots)} ${e.count}`);
  }
}

function renderBox(box: BoxView): void {
  const dot = box.live ? chalk.green(`${GLYPH.live} live`) : chalk.dim(`${GLYPH.idle} not running`);
  console.log(chalk.bold(box.label) + '  ' + dot);
  console.log(chalk.dim(box.id));
  if (box.messages.length === 0) {
    console.log(chalk.dim('  (empty)'));
    return;
  }
  console.log();
  for (const m of box.messages) {
    const when = chalk.dim(relTime(m.ts));
    console.log(`  ${STATE_TAG[m.state]}  ${chalk.magenta(senderOf(m))}  ${when}${m.blockId ? chalk.dim(`  block ${m.blockId.slice(0, 12)}`) : ''}`);
    console.log(`    ${truncate(m.text.replace(/\s+/g, ' ').trim(), 200)}`);
  }
}

function lastTs(box: BoxView): number {
  if (box.messages.length === 0) return 0;
  const t = Date.parse(newestMessage(box).ts);
  return Number.isNaN(t) ? 0 : t;
}

function newestMessage(box: BoxView): StoredMessage {
  return box.messages.reduce((a, b) => (a.ts >= b.ts ? a : b));
}

interface MailboxesOpts {
  json?: boolean;
  limit?: string;
  watch?: boolean;
  between?: string[];
  from?: string;
  to?: string;
  since?: string;
  graph?: boolean;
}

export function registerMailboxesCommand(program: Command): void {
  const cmd = program
    .command('mailboxes')
    .alias('mailbox')
    .argument('[id]', 'A mailbox id (session UUID / teams agentId) to inspect in full')
    .description('Fleet comms — boxes, live cross-box traffic, threads, and routes across the agent mailbox spool')
    .option('--json', 'Output as JSON (NDJSON stream with --watch)')
    .option('-n, --limit <n>', 'Max recent messages in the overview log', '20')
    .option('-f, --watch', 'Live tail: stream new cross-box messages until Ctrl-C')
    .option('--between <boxes...>', 'Thread view: every message between two boxes (id or label), either direction')
    .option('--from <agent>', 'Only messages whose sender contains <agent>')
    .option('--to <agent>', 'Only messages to boxes whose id or label contains <agent>')
    .option('--since <dur>', 'Only messages newer than <dur> (30s/5m/2h/7d or ISO date); with --watch, backfills the window')
    .option('--graph', 'Who-talks-to-whom adjacency, busiest first')
    .action(async (id: string | undefined, opts: MailboxesOpts) => {
      const root = getMailboxRootDir();
      const limit = Math.max(1, Number.parseInt(opts.limit ?? '20', 10) || 20);
      const filters = buildFilters(opts);

      if (opts.between && opts.between.length !== 2) {
        die(`--between takes exactly two boxes: \`agents mailboxes --between <a> <b>\`.`);
      }

      const viewCount = (id ? 1 : 0) + (opts.between ? 1 : 0) + (opts.graph ? 1 : 0);
      if (opts.watch && viewCount > 0) {
        die('--watch streams the whole fleet and combines with no other view. Drop <id>/--between/--graph, or use --from/--to/--since to filter the stream.');
      }
      if (!opts.watch && viewCount > 1) {
        die('Pick one view: <id>, --between, or --graph.');
      }

      if (opts.watch) {
        await runWatch(root, { json: opts.json, filters });
        return;
      }

      const boxes = await collectBoxes(root);

      if (opts.between) {
        renderBetween(boxes, opts.between[0], opts.between[1], opts.json);
        return;
      }

      if (opts.graph) {
        renderGraph(boxes, filters, opts.json);
        return;
      }

      if (id) {
        if (!isValidMailboxId(id)) die(`Invalid mailbox id ${JSON.stringify(id)}.`);
        const box = boxes.find((b) => b.id === id) ?? boxes.find((b) => b.id.startsWith(id));
        if (!box) die(`No mailbox ${JSON.stringify(id)} under ${root}.`);
        if (opts.json) {
          console.log(JSON.stringify(box, null, 2));
          return;
        }
        renderBox(box);
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(
          boxes.map((b) => {
            const messages = hasFilters(filters)
              ? b.messages.filter((m) => matchesFilters({ from: senderOf(m), ts: m.ts }, b.label, b.id, filters))
              : b.messages;
            return {
              id: b.id,
              label: b.label,
              live: b.live,
              pending: messages.filter((m) => m.state !== 'consumed').length,
              total: messages.length,
              messages,
            };
          }),
          null,
          2,
        ));
        return;
      }
      renderOverview(boxes, limit, filters);
    });

  const gcCmd = cmd
    .command('prune')
    .alias('gc')
    .description('Run a liveness sweep: archive pending messages in dead boxes and prune stale consumed mail.')
    .option('--json', 'Emit the GC result as JSON')
    .action(async (_opts: { json?: boolean }, command) => runGcCommand({ json: command.optsWithGlobals().json === true }));

  setHelpSections(gcCmd, {
    examples: `
      # One-shot sweep using the live session set as the liveness source
      agents mailboxes prune

      # Machine-readable summary (for scripts)
      agents mailboxes prune --json
    `,
    notes: `
      A box is considered dead when no live session (the same source
      \`agents ps\` uses) owns it. Pending messages in dead boxes
      are archived as \`dropped: dead\`; expired messages in live boxes are
      archived as \`dropped: expired\'. Both surfaces a failure receipt back to
      the feed store when the message carried a blockId.
    `,
  });
}
