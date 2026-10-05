import type { Command } from 'commander';
import chalk from 'chalk';
import { spawn } from 'child_process';
import { die } from '../lib/format.js';
import { parseDuration } from '../lib/hooks/cache.js';
import { getActiveSessions, isSessionIdLiveOnProcessTable, type ActiveSession } from '../lib/session/active.js';
import { getTaskById, updateTaskStatus } from '../lib/cloud/store.js';
import { resolveProvider } from '../lib/cloud/registry.js';
import { mailboxDir, enqueue } from '../lib/mailbox.js';
import { getAgentsInvocation } from '../lib/daemon/daemon.js';
import { resolveTaskRef } from '../lib/hosts/tasks.js';
import { reconcileRunningTasks } from '../lib/hosts/reconcile.js';
import {
  resolveMessageTarget,
  mailboxIdForActiveSession,
  decideHostTaskRoute,
  type HostTaskRoute,
} from '../lib/mailbox-target.js';
import {
  blockIdForSession,
  listBlocks,
  readBlock,
  recordAnswer,
  recordMessageReceipt,
  type OpenBlock,
} from '../lib/feed/feed.js';
import { verifyOperatorIdentity } from '../lib/operator.js';
import {
  resolveAnswerRoute,
  resumeArgv,
  type AnswerRoute,
} from '../lib/answer-router.js';
import { injectIntoTerminal } from '../lib/terminal/index.js';
import { setHelpSections } from '../lib/help.js';

function findOpenBlockForMailbox(mailboxId: string): OpenBlock | undefined {
  const direct = readBlock(blockIdForSession(mailboxId));
  if (direct && direct.mailboxId === mailboxId) return direct;
  return listBlocks().find((b) => b.mailboxId === mailboxId);
}

function findSessionForMailbox(mailboxId: string, sessions: ActiveSession[]): ActiveSession | undefined {
  return sessions.find((s) => mailboxIdForActiveSession(s) === mailboxId);
}

function claimBlockAnswer(
  block: OpenBlock | undefined,
  opts: { from?: string; as?: string; surface?: string },
): void {
  if (!block) return;
  const operatorId = opts.as;
  const verified = verifyOperatorIdentity(operatorId);
  const claim = recordAnswer(block.blockId, {
    answeredBy: opts.from,
    answeredFrom: opts.surface || 'cli',
    operatorId,
    verified,
  });
  if (!claim.ok) {
    if ('unauthorized' in claim) {
      die(`Not authorized: ${claim.reason}`);
    }
    const who = claim.existing.answeredFrom + (claim.existing.answeredBy ? ` (${claim.existing.answeredBy})` : '');
    die(`This question was already answered by ${who}.`);
  }
}

async function deliverViaMailbox(
  mailboxId: string,
  text: string,
  block: OpenBlock | undefined,
  opts: { from?: string; ttlSeconds?: number },
): Promise<void> {
  const msgId = enqueue(mailboxDir(mailboxId), {
    to: mailboxId,
    text,
    from: opts.from,
    blockId: block?.blockId,
    ttlSeconds: opts.ttlSeconds,
  });
  if (block) {
    recordMessageReceipt(block.blockId, {
      msgId,
      status: 'queued',
      at: new Date().toISOString(),
      from: opts.from,
    });
    console.log(
      chalk.green(`Queued message ${msgId} for ${mailboxId}. `) +
        chalk.dim(`Answer tied to ${block.blockId}; the agent will see it at its next tool call.`),
    );
  } else {
    console.log(
      chalk.green(`Queued message ${msgId} for ${mailboxId}. `) +
        chalk.dim('The agent will see it at its next tool call.'),
    );
  }
}

async function deliverViaInject(route: AnswerRoute, mailboxId: string): Promise<void> {
  if (!route.inject || route.payload == null) {
    die(`Internal error: inject route missing target/payload for ${mailboxId}.`);
  }
  const result = await injectIntoTerminal(route.inject, route.payload, {
    enter: true,
    combined: false,
  });
  if (!result.ok) {
    die(`Failed to inject answer into ${route.inject.backend}: ${result.error ?? 'unknown error'}`);
  }
  console.log(
    chalk.green(`Answered ${mailboxId} via ${route.inject.backend}. `) +
      chalk.dim(route.reason),
  );
}

async function deliverViaResume(route: AnswerRoute, mailboxId: string): Promise<void> {
  if (route.kind !== 'resume') {
    die(`Internal error: resume route incomplete for ${mailboxId}.`);
  }
  const argv = resumeArgv(route);
  const inv = getAgentsInvocation(argv);
  const child = spawn(inv.command, inv.args, {
    stdio: 'inherit',
    env: process.env,
  });
  const code: number = await new Promise((resolve) => {
    child.on('exit', (c) => resolve(c ?? 1));
    child.on('error', () => resolve(1));
  });
  if (code !== 0) {
    die(`Resume of ${mailboxId} exited with code ${code}. Tried: agents ${argv.join(' ')}`);
  }
  console.log(
    chalk.green(`Resumed ${mailboxId} with answer. `) +
      chalk.dim(route.reason),
  );
}

async function deliverViaHostReroute(
  route: Extract<HostTaskRoute, { kind: 'reroute' }>,
  text: string,
  opts: { from?: string; as?: string; surface?: string; ttl?: string },
): Promise<void> {
  const argv = ['message', route.remoteRef, text, '--device', route.host];
  if (opts.from) argv.push('--from', opts.from);
  if (opts.as) argv.push('--as', opts.as);
  if (opts.surface) argv.push('--surface', opts.surface);
  if (opts.ttl) argv.push('--ttl', opts.ttl);

  const inv = getAgentsInvocation(argv);
  const child = spawn(inv.command, inv.args, { stdio: 'inherit', env: process.env });
  const code: number = await new Promise((resolve) => {
    child.on('exit', (c) => resolve(c ?? 1));
    child.on('error', () => resolve(1));
  });
  if (code !== 0) {
    die(
      `Delivery to '${route.remoteRef}' on host '${route.host}' exited with code ${code}. ` +
        `Tried: agents ${argv.join(' ')}`,
    );
  }
}

const CONTROL_PLANE_NOTES = `
  Planes (do not mix them up):
    message / sessions inject  - CONTROL a running agent (mailbox answer, terminal keystroke, or resume by runtime)
    send                       - DELIVER a message to a human recipient over a channel provider
    feed post                  - RECORD progress / milestones (optional broadcast may call send)

  <text> here is consumed BY THE TARGET AGENT (an answer, a keystroke, or the
  argument to a resume) -- it is not a notification a person reads on their
  phone. To reach the operator instead, use \`agents send --to owner\`
  (or a feed.broadcast \`channel:\` sink).
`;

export function registerMessageCommand(program: Command): void {
  const messageCmd = program
    .command('message <target> <text>')
    .description('Send a message to a running or parked agent (mailbox / terminal-select / resume by runtime).')
    .option('--from <who>', 'Label recorded as the sender of this message')
    .option('--as <operator>', 'Verified operator id answering a high-consequence block')
    .option('--surface <surface>', 'Surface that is sending this answer (feed, terminal, etc.)', 'cli')
    .option('--ttl <dur>', 'Delivery TTL if the message is not consumed (e.g. 30m, 1h, 24h); 0 disables expiry');

  setHelpSections(messageCmd, { notes: CONTROL_PLANE_NOTES });

  messageCmd.action(async (target: string, text: string, opts: { from?: string; as?: string; surface?: string; ttl?: string }) => {
      if (!target.trim()) {
        die('Target must be a session/agent id or cloud task id. Run `agents sessions --active` to list running agents.');
      }
      let ttlSeconds: number | undefined;
      if (opts.ttl !== undefined) {
        const parsed = parseDuration(opts.ttl);
        if (parsed == null) {
          die(`Invalid --ttl ${JSON.stringify(opts.ttl)}: expected a duration like 30m, 1h, 24h, or 0.`);
        }
        ttlSeconds = parsed;
      }
      const sessions = await getActiveSessions();
      const res = resolveMessageTarget(target, sessions, (id) => getTaskById(id) != null);

      switch (res.kind) {
        case 'cloud': {
          const task = getTaskById(res.id)!;
          const provider = resolveProvider(task.provider);
          try {
            await provider.message(res.id, text);
            updateTaskStatus(res.id, 'running');
            console.log(chalk.green(`Message sent to cloud task ${res.id}. Agent is continuing.`));
          } catch (err) {
            die((err as Error).message);
          }
          return;
        }
        case 'local': {
          try {
            const block = findOpenBlockForMailbox(res.id);
            const session = findSessionForMailbox(res.id, sessions);
            const route = resolveAnswerRoute({
              mailboxId: res.id,
              answer: text,
              block,
              session,
            });

            if (route.kind === 'refuse') {
              die(route.reason);
            }

            claimBlockAnswer(block, opts);

            if (route.kind === 'mailbox') {
              await deliverViaMailbox(res.id, text, block, { from: opts.from, ttlSeconds });
              return;
            }
            if (route.kind === 'tmux' || route.kind === 'iterm') {
              await deliverViaInject(route, res.id);
              if (block) {
                recordMessageReceipt(block.blockId, {
                  msgId: `inject-${Date.now()}`,
                  status: 'queued',
                  at: new Date().toISOString(),
                  from: opts.from,
                });
              }
              return;
            }
            if (route.kind === 'resume') {
              await deliverViaResume(route, res.id);
              return;
            }
            die(`Unknown delivery route: ${(route as AnswerRoute).kind}`);
          } catch (err) {
            die((err as Error).message);
          }
          return;
        }
        case 'ambiguous': {
          const lines = res.candidates.map((c) => `  ${c.id}  ${chalk.dim(c.label)}`).join('\n');
          die(`"${target}" matches ${res.candidates.length} running agents:\n${lines}\nRe-run with a full id.`);
          return;
        }
        case 'none': {
          if (await isSessionIdLiveOnProcessTable(target)) {
            try {
              const block = findOpenBlockForMailbox(target);
              const route = resolveAnswerRoute({
                mailboxId: target,
                answer: text,
                block,
                session: null,
              });
              if (route.kind === 'refuse') die(route.reason);
              claimBlockAnswer(block, opts);
              if (route.kind === 'mailbox') {
                await deliverViaMailbox(target, text, block, { from: opts.from, ttlSeconds });
                return;
              }
              die(
                `Live process carries --session-id ${target} but needs a ${route.kind} rail ` +
                  `that is unavailable without an active-session row. Retry after the session ` +
                  `reappears in \`agents sessions --active\`, or inject into its terminal directly.`,
              );
            } catch (err) {
              die((err as Error).message);
            }
            return;
          }
          const onDisk = resolveTaskRef(target);
          const hostRoute = decideHostTaskRoute(
            onDisk ? reconcileRunningTasks([onDisk])[0] : null,
            target,
          );
          if (hostRoute.kind === 'reroute') {
            await deliverViaHostReroute(hostRoute, text, opts);
            return;
          }
          if (hostRoute.kind === 'finished') {
            die(
              `Task '${target}' on host '${hostRoute.host}' already ${hostRoute.status}` +
                (hostRoute.exitCode !== undefined ? ` (exit ${hostRoute.exitCode})` : '') +
                `. Nothing to message. View its output: \`agents logs ${target}\`.`,
            );
          }
          die(`No running agent or cloud task matches "${target}". List targets with \`agents sessions --active\` or \`agents devices ps\`.`);
        }
      }
    });
}
