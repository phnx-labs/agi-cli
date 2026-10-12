import type { Command } from 'commander';
import { machineId } from '../lib/machine-id.js';
import { setHelpSections } from '../lib/help.js';
import { watchFleetSessions, watchLocalSessions } from '../lib/session/watch.js';

export function registerSessionsWatchCommand(parent: Command): void {
  const command = parent.command('watch')
    .description('Stream canonical live and recoverable session row changes as NDJSON')
    .option('--json', 'Emit versioned NDJSON envelopes')
    .option('--local', 'Watch only this machine');

  setHelpSections(command, {
    examples: `
      # Subscribe to session changes for a long-lived UI consumer
      agents ps watch --json

      # Subscribe only to this machine
      agents ps watch --json --local
    `,
    notes: `
      - Each line is one versioned reset, upsert, remove, scope, or heartbeat envelope.
      - rowKey is opaque. Order changes by streamId + sequence.
      - An unavailable scope retains its last rows until that scope reconnects.
    `,
  });

  command.action(async (_options: { local?: boolean; json?: boolean }, invoked: Command) => {
    const options = invoked.optsWithGlobals() as { local?: boolean; json?: boolean };
    if (!options.json) invoked.error('error: required option \'--json\' not specified');
    const controller = new AbortController();
    const stop = () => controller.abort();
    const stopOnClosedConsumer = (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') controller.abort();
      else {
        process.exitCode = 1;
        controller.abort(error);
      }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.stdout.on('error', stopOnClosedConsumer);
    try {
      const emit = (event: Parameters<Parameters<typeof watchFleetSessions>[0]['emit']>[0]) =>
        process.stdout.write(`${JSON.stringify(event)}\n`);
      if (options.local) await watchLocalSessions({ scope: machineId(), signal: controller.signal, emit });
      else await watchFleetSessions({ signal: controller.signal, emit });
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      process.stdout.off('error', stopOnClosedConsumer);
    }
  });
}
