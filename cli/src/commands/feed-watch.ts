import type { Command } from 'commander';
import { machineId } from '../lib/machine-id.js';
import { setHelpSections } from '../lib/help.js';
import { watchLocalFeed, type FeedWatchEnvelope } from '../lib/feed/watch.js';
import { streamFeedFromHub } from '../lib/feed/hub-server.js';
import { ensureDaemonStarted } from '../lib/daemon/daemon.js';

/**
 * Attach to the daemon's shared collector, starting the daemon if it is not up.
 *
 * There is deliberately no in-process fallback: running `watchFleetFeed` here
 * would give this reader its own ssh child per peer, which is exactly the
 * per-caller fan-out the hub exists to collapse (see `lib/feed/hub.ts`). So a
 * missing hub is answered by starting its owner, once, and retrying — and a
 * second failure is reported rather than papered over.
 */
async function attachToHub(signal: AbortSignal, emit: (event: FeedWatchEnvelope) => void): Promise<void> {
  try { await streamFeedFromHub({ signal, emit }); return; }
  catch (error) {
    if (signal.aborted) return;
    ensureDaemonStarted();
    try { await streamFeedFromHub({ signal, emit }); }
    catch {
      throw new Error(`the shared feed stream is unavailable: ${(error as Error).message}\n`
        + 'Next: agents daemon status, then agents daemon services enable feed-stream');
    }
  }
}

export function registerFeedWatchCommand(parent: Command): void {
  const command = parent.command('watch').description('Stream the canonical agent, attention, tool, and activity projection as NDJSON')
    .option('--json', 'Emit versioned NDJSON envelopes').option('--local', 'Watch only this machine');
  setHelpSections(command, {
    examples: `agents feed watch --json\nagents feed watch --json --local`,
    notes: 'Order by streamId + sequence. Unavailable scopes retain their last rows until reset on reconnect. '
      + 'The fleet stream is served by the daemon\'s shared collector, so several readers cost one connection per peer; '
      + '--local is the per-machine stream the collector itself subscribes to over ssh.',
  });
  command.action(async (_opts, invoked) => {
    const opts = invoked.optsWithGlobals() as { local?: boolean; json?: boolean };
    if (!opts.json) invoked.error("error: required option '--json' not specified");
    const controller = new AbortController();
    const stop = () => controller.abort();
    const emit = (event: FeedWatchEnvelope) => process.stdout.write(`${JSON.stringify(event)}\n`);
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      if (opts.local) await watchLocalFeed({ scope: machineId(), signal: controller.signal, emit });
      else await attachToHub(controller.signal, emit);
    }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  });
}
