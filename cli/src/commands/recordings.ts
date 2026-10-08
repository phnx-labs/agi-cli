import * as path from 'node:path';
import chalk from 'chalk';
import type { Command } from 'commander';
import { resolveArtifactsBin } from '../lib/artifacts-client.js';
import { setDaemonServiceEnabled } from '../lib/daemon-services.js';
import { assertDaemonEnabled } from '../lib/device-config.js';
import { setHelpSections } from '../lib/help.js';
import { resolveRecordingDirectory, writeRecordingDirectory } from '../lib/recordings/config.js';
import { RecordingLedger } from '../lib/recordings/ledger.js';
import { RecordingPipeline } from '../lib/recordings/pipeline.js';
import { candidateForFile } from '../lib/recordings/settle.js';
import { resolveFfmpegBin } from '../lib/recordings/transcode.js';

async function applyDaemonState(startIfStopped: boolean): Promise<void> {
  const { ensureDaemonStarted, isDaemonRunning, signalDaemonReload } = await import('../lib/daemon/daemon.js');
  if (isDaemonRunning()) {
    if (!signalDaemonReload()) throw new Error('Could not signal the daemon to reload recording settings.');
    return;
  }
  if (startIfStopped && !ensureDaemonStarted()) {
    throw new Error('The daemon did not start. Run `agents daemon doctor`, then retry.');
  }
}

export function registerRecordingsCommand(program: Command): void {
  const command = program
    .command('recordings')
    .description('Publish finished CleanShot recordings as organization-only artifacts.');

  setHelpSections(command, {
    examples: `# Detect CleanShot's export folder and start the daemon-owned watcher
agents recordings watch

# Watch another folder instead
agents recordings watch --dir ~/Movies/CleanShot

# Inspect queued, failed, and published recordings
agents recordings list

# Publish one existing recording through the same pipeline
agents recordings upload ./demo.mov

# Stop watching; already published artifacts stay published
agents recordings unwatch`,
    notes: `The watcher is opt-in and runs inside the agents daemon. A recording becomes
eligible after its size remains unchanged for 10 seconds. The original file is never
modified: ffmpeg creates a temporary 1080p/30fps upload copy, then artifacts publishes
it with organization-only visibility and no expiry.

Requires ffmpeg and the standalone artifacts CLI. Sign in to artifacts with an
organization email before files arrive; personal inbox identities are refused.`,
  });

  const watch = command.command('watch')
    .description('Enable the daemon-owned CleanShot watcher and persist its folder.')
    .option('--dir <path>', 'Recording folder (default: CleanShot exportPath on macOS)')
    .action(async (options: { dir?: string }) => {
      assertDaemonEnabled();
      resolveFfmpegBin();
      resolveArtifactsBin();
      const directory = await resolveRecordingDirectory(options.dir);
      await writeRecordingDirectory(directory);
      setDaemonServiceEnabled('recordings', true);
      await applyDaemonState(true);
      console.log(chalk.green(`Watching recordings in ${directory}`));
    });
  setHelpSections(watch, {
    examples: `agents recordings watch
agents recordings watch --dir ~/Movies/CleanShot`,
    notes: 'Enables the recordings daemon service on this device. Re-running updates the watched folder.',
  });

  const unwatch = command.command('unwatch')
    .description('Disable the recordings watcher on this device.')
    .action(async () => {
      setDaemonServiceEnabled('recordings', false);
      await applyDaemonState(false);
      console.log(chalk.green('Recording watcher disabled.'));
    });
  setHelpSections(unwatch, {
    examples: 'agents recordings unwatch',
    notes: 'Disables future discovery and cancels an upload currently owned by the watcher.',
  });

  const list = command.command('list')
    .description('List the local recording ledger with upload status and URL.')
    .option('--json', 'Emit ledger rows as JSON')
    .action(async (options: { json?: boolean }, invoked: Command) => {
      const rows = await new RecordingLedger().list();
      if (options.json === true || invoked.optsWithGlobals().json === true) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log(chalk.dim('No recordings have been discovered.'));
        return;
      }
      for (const row of rows) {
        const status = row.status.padEnd(11);
        console.log(`${status} ${path.basename(row.path)}${row.url ? `\n            ${row.url}` : ''}`);
        if (row.error) console.log(chalk.yellow(`            ${row.error}`));
      }
    });
  setHelpSections(list, {
    examples: `agents recordings list
agents recordings list --json`,
    notes: 'The ledger lives at ~/.agents/recordings/ledger.json and is reused after daemon restarts.',
  });

  const upload = command.command('upload <file>')
    .description('Transcode and publish one recording through the watcher pipeline.')
    .action(async (file: string) => {
      resolveFfmpegBin();
      const candidate = await candidateForFile(file);
      const pipeline = new RecordingPipeline();
      const row = await pipeline.upload(candidate);
      console.log(row.url);
    });
  setHelpSections(upload, {
    examples: 'agents recordings upload ./CleanShot\ 2026-10-08\ at\ 4.51.47\ AM.mov',
    notes: 'Runs the same identity check, ffmpeg transcode, metadata, ledger, and artifacts upload path as the daemon.',
  });
}
