/** Strict session resume: identity resolution, source-device routing, and delegation to `agents run
 * --resume`. Registered under `agents sessions resume` (sessions-resume.ts); this module owns the
 * helpers and in-process action. */
import { spawn } from 'child_process';
import chalk from 'chalk';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import { resolveSessionMetadataValue } from './sessions.js';
import { sessionOwnerDevice, consumeResumePinned, RESUME_PINNED_ENV } from '../lib/session/resume-owner.js';
import { machineId } from '../lib/machine-id.js';
import { takeOverDetachedSession } from '../lib/session/detached.js';

const RESUME_SOURCE_ENV = 'AGENTS_RESUME_SOURCE_JSON';

export function resumeLocalFallbackSource(session: SessionMeta, self: string = machineId()): SessionMeta {
  return { ...session, machine: self };
}

export interface StrictResumeOptions {
  agent?: string;
  mode?: string;
  account?: string;
  model?: string;
  interactive?: boolean;
  headless?: boolean;
  cwd?: string;
  quiet?: boolean;
  here?: boolean;
  local?: boolean;
}

/** The argv to re-run this resume on the machine that owns the session. It carries no 'don't route
 * again' flag; that rides the RESUME_PINNED_ENV export, so the hop also works against a peer on an
 * older CLI. Every token exists in the released surface. */
export function buildResumeRemoteArgs(
  sessionId: string,
  prompt: string | undefined,
  options: StrictResumeOptions,
): string[] {
  const args = ['sessions', 'resume', sessionId, ...(prompt === undefined ? [] : [prompt])];
  if (options.agent) args.push('--agent', options.agent);
  if (options.account) args.push('--account', options.account);
  if (options.model) args.push('--model', options.model);
  if (options.mode) args.push('--mode', options.mode);
  if (options.interactive) args.push('--interactive');
  if (options.headless) args.push('--headless');
  if (options.cwd) args.push('--cwd', options.cwd);
  if (options.quiet) args.push('--quiet');
  return args;
}

export function buildResumeRunArgs(
  session: { id: string; agent: string; version?: string },
  prompt: string | undefined,
  options: StrictResumeOptions,
): string[] {
  const spec = session.agent;
  const args = ['run', spec, ...(prompt === undefined ? [] : [prompt]), '--resume', session.id];
  if (options.account) args.push('--account', options.account);
  if (options.model) args.push('--model', options.model);
  if (options.mode) args.push('--mode', options.mode);
  if (options.interactive) args.push('--interactive');
  if (options.headless) args.push('--headless');
  if (options.cwd) args.push('--cwd', options.cwd);
  if (options.quiet) args.push('--quiet');
  return args;
}

function consumeResumeSource(): { id: string; agent: string; version?: string; cwd?: string; filePath?: string } | undefined {
  const raw = process.env[RESUME_SOURCE_ENV];
  delete process.env[RESUME_SOURCE_ENV];
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    if (typeof value?.id === 'string' && typeof value?.agent === 'string') return value;
  } catch {
  }
  return undefined;
}

export function wantsStrictResume(
  prompt: string | undefined,
  options: StrictResumeOptions,
): boolean {
  return (
    prompt !== undefined ||
    !!options.mode ||
    !!options.interactive ||
    !!options.headless ||
    !!options.cwd ||
    !!options.quiet ||
    !!options.here
  );
}

/** Strict single-session resume: resolve id/label across the fleet, hop to the owning device when
 * needed, then delegate to `agents run --resume`. */
export async function runStrictResume(
  sessionId: string,
  prompt: string | undefined,
  options: StrictResumeOptions,
): Promise<void> {
  const routedHop = consumeResumePinned();
  const pinnedHere = routedHop || !!options.here;
  const routedSource = routedHop ? consumeResumeSource() : undefined;
  if (routedSource && routedSource.id !== sessionId.trim()) {
    console.error(chalk.red(
      `Resume routing metadata names session ${routedSource.id}, not requested session ${sessionId.trim()}.`,
    ));
    process.exitCode = 1;
    return;
  }
  const outcome = await resolveSessionMetadataValue(sessionId.trim(), { agent: options.agent, local: pinnedHere || options.local });
  if (outcome.kind === 'partial') {
    // RUSH-2492: an unreachable peer is a warning, not a failure; the resolver already handles an
    // id found on the reachable fleet (SES-9a), so the session was not found on any reachable
    // device and may live on one we could not check.
    const offline = outcome.failedPeers;
    console.error(chalk.yellow(`Warning: ${offline.length} device(s) unreachable, not checked: ${offline.join(', ')}`));
    console.error(chalk.red(`No session matching "${sessionId}" on any reachable device (${offline.length} unreachable, not checked).`));
    console.error(chalk.gray('  If it lives on an offline box, wake it (agents devices) or run there: agents ssh <device>'));
    process.exitCode = 1;
    return;
  }
  if (outcome.kind === 'not-found') {
    console.error(chalk.red(`No session matching "${sessionId}".`));
    process.exitCode = 1;
    return;
  }
  if (outcome.kind === 'ambiguous') {
    console.error(chalk.red(`"${sessionId}" matches ${outcome.candidates.length} sessions. Pass the full session id.`));
    process.exitCode = 1;
    return;
  }

  // The harness keeps conversation state on the machine that produced the session, so a peer-owned
  // session must resume there. Running it here starts the agent against state this box lacks,
  // silently, since a synced mirror looks local (RUSH-2022).
  const owner = pinnedHere ? undefined : sessionOwnerDevice(outcome.session);
  if (owner) {
    if (!options.quiet) {
      process.stderr.write(chalk.gray(`[agents] session ${outcome.session.shortId} belongs to ${owner} → resuming there\n`));
    }
    // `runOnPeer` is the existing transport for 'this session's transcript and agent binary are on
    // that box' (lib/session/remote-list.ts). Not `--host` passthrough: it re-discovers locally
    // and marks the run AGENTS_FLEET_REMOTE, which a resumed session must not inherit.
    const { runOnPeer } = await import('../lib/session/remote-list.js');
    const rc = await runOnPeer(
      buildResumeRemoteArgs(outcome.session.id, prompt, options),
      owner,
      {
        tty: !!process.stdout.isTTY,
        env: {
          [RESUME_PINNED_ENV]: '1',
          [RESUME_SOURCE_ENV]: JSON.stringify(outcome.session),
        },
        sessionId: outcome.session.id,
      },
    );
    if (rc === 'no-target' || rc === 'unreachable') {
      if (!options.quiet) {
        process.stderr.write(chalk.yellow(
          `[agents] session ${outcome.session.shortId} belongs to ${owner}, which is unreachable; checking for local transcript content before offering replay\n`,
        ));
      }
      process.exitCode = await delegateLocalResume(resumeLocalFallbackSource(outcome.session), prompt, options);
    }
    return;
  }

  const localSession = pinnedHere ? resumeLocalFallbackSource(outcome.session) : outcome.session;
  await takeOverDetachedSession(localSession.id);
  process.exitCode = await delegateLocalResume(localSession, prompt, options);
}

/** Spawn the delegated local `agents run --resume` for a session this box owns (or falls back to).
 * The run command stays the sole executor and resolves recovery (native vs `/continue`); returns
 * the child's exit code. */
async function delegateLocalResume(
  session: SessionMeta,
  prompt: string | undefined,
  options: StrictResumeOptions,
): Promise<number> {
  const args = buildResumeRunArgs(session, prompt, options);
  const child = spawn(process.execPath, [process.argv[1], ...args], {
    stdio: 'inherit',
    env: {
      ...process.env,
      [RESUME_SOURCE_ENV]: JSON.stringify(session),
    },
  });
  return new Promise<number>((resolve) => {
    child.once('error', () => resolve(127));
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
