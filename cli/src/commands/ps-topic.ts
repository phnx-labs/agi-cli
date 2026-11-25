import type { Command } from 'commander';
import chalk from 'chalk';
import { gatherLiveTargets } from './go.js';
import { resolveOne } from './detach-core.js';
import { sessionProcessHost } from '../lib/session/active.js';
import { runOnPeer } from '../lib/session/remote-list.js';
import { setSessionWorkstreamByUser } from '../lib/session/db.js';
import { sanitizeWorkstream, SESSION_WORKSTREAM_MAX_CHARS, SESSION_WORKSTREAM_MAX_WORDS } from '../lib/session/title.js';
import { setHelpSections } from '../lib/help.js';

// `forwarded`: the owning peer already printed the result (its stdio is ours).
type TopicResult = { ok: true; sessionId: string; topic: string; machine: string } | { ok: false; error: string } | { forwarded: true; ok: boolean };

export function registerPsTopicCommand(program: Command): void {
  const cmd = program
    .command('topic')
    .argument('<id>', 'Short or full id of the live session')
    .argument('<topic>', 'The topic to file it under: 1 to 4 words, at most 32 characters (e.g. "Rush Cloud")')
    .option('--local', 'Only this machine (skip the cross-host sweep)')
    .option('--json', 'Emit the result as JSON')
    .description('File a live session under a topic you choose; the daemon never changes it back')
    .action(async (id: string, topic: string, _opts: unknown, invoked: Command) => {
      // `ps` declares --json and --local itself, so Commander may hand them to the parent.
      const opts = invoked.optsWithGlobals() as { local?: boolean; json?: boolean };
      const result = await setTopicAction(id, topic, opts);
      if (!result.ok) process.exitCode = 1;
      if ('forwarded' in result) return;
      if (opts.json) console.log(JSON.stringify(result));
      else if (result.ok) console.log(chalk.green(`${result.sessionId.slice(0, 8)} is under "${result.topic}" now`) + chalk.gray(` (on ${result.machine})`));
      else console.error(chalk.red(result.error));
    });
  setHelpSections(cmd, {
    examples: `
      # Move a session to another topic (AGI EXT does this when you drag its card)
      agents ps topic 4b2f1a9c "Rush Cloud"

      # Machine-readable, for a UI
      agents ps topic 4b2f1a9c "Rush Cloud" --json
    `,
    notes: `
      A topic is the session's workstream: the name sessions are grouped by in
      \`agents ps watch\` and AGI EXT. The daemon's title job names one for every
      session; a topic set here is yours and the job never overwrites it.

      Only a live session takes a topic: topics group the sessions running now,
      and a session that ended groups by where it ran.

      The topic is stored on the machine that owns the session, so a session
      running on another machine is updated THERE over SSH; your other machines
      pick it up with the next session sync. It stays with that machine: a
      session moved with \`agents ps migrate\` gets its topic from the title job
      again until you set one there.
    `,
  });
}

async function setTopicAction(id: string, raw: string, opts: { local?: boolean; json?: boolean }): Promise<TopicResult> {
  // Refuse rather than shorten: a topic cut to fit is not the one asked for.
  const asked = raw.replace(/\s+/g, ' ').trim();
  const topic = asked.split(' ').length <= SESSION_WORKSTREAM_MAX_WORDS && asked.length <= SESSION_WORKSTREAM_MAX_CHARS ? sanitizeWorkstream(asked) : undefined;
  if (!topic) {
    return { ok: false, error: `Give the topic as 1 to 4 words, at most ${SESSION_WORKSTREAM_MAX_CHARS} characters, e.g. "Rush Cloud".` };
  }
  const { self, activeById } = await gatherLiveTargets(!!opts.local, { selector: id });
  const s = resolveOne(activeById, id);
  if ('error' in s) return { ok: false, error: s.error };
  const sessionId = s.sessionId ?? '';
  if (!sessionId) return { ok: false, error: 'That session has no id yet, so it cannot be filed under a topic.' };
  if (s.context === 'cloud') return { ok: false, error: 'A cloud session has no index on this fleet to store a topic in.' };

  const host = sessionProcessHost(s, self);
  if (host) {
    if (opts.local) return { ok: false, error: `${sessionId.slice(0, 8)} runs on ${host}; drop --local to set it there.` };
    const rc = await runOnPeer(['ps', 'topic', sessionId, topic, '--local', ...(opts.json ? ['--json'] : [])], host);
    if (rc === 'no-target') return { ok: false, error: `Can't reach ${host} to set the topic of ${sessionId.slice(0, 8)}.` };
    return { forwarded: true, ok: rc === 'ok' };
  }
  if (!setSessionWorkstreamByUser(sessionId, topic)) {
    return { ok: false, error: `${sessionId.slice(0, 8)} is not indexed on this machine yet; the daemon indexes a new session within seconds, so try again.` };
  }
  return { ok: true, sessionId, topic, machine: self };
}
