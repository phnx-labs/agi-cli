import type { Command } from 'commander';
import { setHelpSections } from '../lib/help.js';
import { type FeedWatchEnvelope } from '../lib/feed/watch.js';
import { streamFeedFromHub, waitForHub } from '../lib/feed/hub-server.js';
import { ensureDaemonStarted } from '../lib/daemon/daemon.js';

/**
 * Attach to the daemon's shared collector, starting the daemon if it is not up.
 *
 * There is deliberately no in-process fallback: running `watchFleetFeed` here
 * would give this reader its own ssh child per peer, which is exactly the
 * per-caller fan-out the hub exists to collapse (see `lib/feed/hub.ts`). So a
 * missing hub is answered by starting its owner and WAITING for it.
 *
 * The wait is what makes that honest. `ensureDaemonStarted()` returns once the
 * process is spawned, long before it has loaded its services and bound the
 * socket, so retrying immediately raced the bind and reported a daemon that was
 * about to be perfectly healthy as unavailable. The final error is the one from
 * the last real attempt, not the first.
 */
async function attachToHub(signal: AbortSignal, emit: (event: FeedWatchEnvelope) => void, scope: 'fleet' | 'local'): Promise<void> {
  try { await streamFeedFromHub({ signal, emit, scope }); return; }
  catch (first) {
    if (signal.aborted) return;
    ensureDaemonStarted();
    if (!await waitForHub()) {
      throw new Error(`the shared feed stream did not come up: ${(first as Error).message}\n`
        + 'Next: agents daemon status, then agents daemon services enable feed-stream');
    }
    try { await streamFeedFromHub({ signal, emit, scope }); }
    catch (second) {
      throw new Error(`the shared feed stream is unavailable: ${(second as Error).message}\n`
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
      // BOTH scopes go through the daemon's shared collectors. `--local` used to
      // run its own `watchLocalFeed`, so every observing box's ssh subscription
      // built a separate activity cursor set, tool watcher and setup subscription
      // on the SAME peer. The local collector is a distinct hub from the fleet one
      // (`feed-stream-service.ts`) and its watcher dials no peer at all, so a
      // local reader can never trigger a fan-out, recursively or otherwise.
      await attachToHub(controller.signal, emit, opts.local ? 'local' : 'fleet');
    }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  });
}
