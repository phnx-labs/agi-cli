/** `agents cli` manages declarative CLI binary installs: each <repo>/cli/<name>.yaml declares a
 * tool for the host PATH, and `agents cli install` runs the first method whose package manager is
 * available. A sibling to `agents mcp`, one layer down: manifests are global to the user. */
import type { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';

import {
  listCliManifests,
  listCliStatus,
  resolveCliManifest,
  installCli,
  describeMethod,
  describeCheck,
  selectInstallMethod,
  isCliInstalled,
  type CliManifest,
} from '../lib/cli-resources.js';
import { getUserAgentsDir } from '../lib/state.js';
import { isPromptCancelled } from './utils.js';

function userCliDir(): string {
  return path.join(getUserAgentsDir(), 'clis');
}

/** Render the status table — one row per declared CLI. */
function printStatus(rows: { manifest: CliManifest; installed: boolean }[]): void {
  if (rows.length === 0) {
    console.log(chalk.gray('No CLIs declared.'));
    console.log(chalk.gray(`Create one with: agents clis add <name>`));
    return;
  }
  const nameWidth = Math.max(4, ...rows.map((r) => r.manifest.name.length));
  for (const row of rows) {
    const status = row.installed
      ? chalk.green('installed')
      : chalk.yellow('missing');
    const name = row.manifest.name.padEnd(nameWidth);
    const source = chalk.gray(`[${row.manifest.source}]`);
    const desc = row.manifest.description ? '  ' + chalk.gray(row.manifest.description) : '';
    console.log(`  ${name}  ${status}  ${source}${desc}`);
  }
}

export function registerCliCommands(program: Command): void {
  const cliCmd = program
    .command('clis')
    .description('Declare and install host CLI binaries (gh, higgsfield, glab, ...)')
    .addHelpText('after', `
CLI manifests live in <repo>/clis/<name>.yaml and declare how to install a
binary on the host. On a fresh machine, 'agents clis install' runs the first
compatible method (npm > brew > script > binary) for every declared entry.

Examples:
  # See which declared CLIs are installed on this host
  agents clis list

  # Install everything that's missing
  agents clis install

  # Install one
  agents clis install higgsfield

  # Show the manifest detail
  agents clis view higgsfield

  # Exit 0 if all declared CLIs are installed (use in CI / setup scripts)
  agents clis check

When to use:
  - After 'agents sync' on a new machine, to materialize host binaries
  - In a team setup: commit clis/ entries so teammates get the same toolchain
`);

  cliCmd
    .command('list')
    .description('Show all declared CLIs and whether each is installed on this host')
    .action(() => {
      const { statuses, errors } = listCliStatus(process.cwd());
      printStatus(statuses);
      for (const err of errors) {
        console.log(chalk.red(`  parse error: ${err.file}: ${err.reason}`));
      }
    });

  cliCmd
    .command('check')
    .description('Exit 0 if every declared CLI is installed, 1 otherwise')
    .action(() => {
      const { statuses, errors } = listCliStatus(process.cwd());
      const missing = statuses.filter((s) => !s.installed);
      if (errors.length > 0) {
        for (const err of errors) {
          console.error(chalk.red(`parse error: ${err.file}: ${err.reason}`));
        }
        process.exit(1);
      }
      if (missing.length === 0) {
        console.log(chalk.green(`All ${statuses.length} declared CLI(s) installed.`));
        return;
      }
      console.log(chalk.yellow(`Missing: ${missing.map((s) => s.manifest.name).join(', ')}`));
      process.exit(1);
    });

  cliCmd
    .command('install [name]')
    .description('Install one (by name) or all missing declared CLIs')
    .option('-y, --yes', 'skip the confirmation prompt')
    .option('--dry-run', 'print install commands without executing them')
    .option('--force', 'reinstall even when the check command currently passes')
    .action(async (nameArg: string | undefined, opts: { yes?: boolean; dryRun?: boolean; force?: boolean }) => {
      let targets: CliManifest[];
      if (nameArg) {
        const manifest = resolveCliManifest(nameArg, process.cwd());
        if (!manifest) {
          console.error(chalk.red(`No CLI manifest named "${nameArg}".`));
          console.error(chalk.gray(`Looked in: ${userCliDir()}`));
          process.exit(1);
        }
        targets = [manifest];
      } else {
        const { manifests, errors } = listCliManifests(process.cwd());
        for (const err of errors) {
          console.error(chalk.red(`parse error: ${err.file}: ${err.reason}`));
        }
        if (manifests.length === 0) {
          console.log(chalk.gray('No CLIs declared. Nothing to install.'));
          return;
        }
        targets = manifests;
      }

      // Filter out already-installed unless --force
      const work = targets.filter((m) => opts.force || !isCliInstalled(m));
      if (work.length === 0) {
        console.log(chalk.green(`All ${targets.length} declared CLI(s) already installed.`));
        return;
      }

      // Preview + confirm
      console.log(chalk.bold('\nWill install:'));
      for (const m of work) {
        const method = selectInstallMethod(m);
        const action = method ? describeMethod(method) : chalk.red('no compatible install method');
        console.log(`  ${chalk.cyan(m.name.padEnd(20))} ${chalk.gray(action)}`);
      }
      console.log('');

      if (!opts.yes && !opts.dryRun) {
        try {
          const proceed = await confirm({ message: 'Proceed?', default: true });
          if (!proceed) {
            console.log(chalk.gray('Cancelled.'));
            return;
          }
        } catch (err) {
          if (isPromptCancelled(err)) {
            console.log(chalk.gray('Cancelled.'));
            return;
          }
          throw err;
        }
      }

      // Execute
      let failures = 0;
      for (const m of work) {
        console.log(chalk.bold(`\n→ ${m.name}`));
        const result = installCli(m, { dryRun: opts.dryRun });
        if (result.output) console.log(chalk.gray(result.output));
        if (result.error) {
          console.log(chalk.red(`  ${result.error}`));
          failures++;
          continue;
        }
        if (opts.dryRun) continue;
        if (result.installed) {
          console.log(chalk.green(`  installed (${describeMethod(result.method!)})`));
          if (m.postInstall) {
            console.log(chalk.gray(m.postInstall.trim().split('\n').map((l) => '  ' + l).join('\n')));
          }
        } else {
          console.log(chalk.yellow(`  install command ran but \`${describeCheck(m.check)}\` still fails — check the output above`));
          failures++;
        }
      }
      if (failures > 0) process.exit(1);
    });

  cliCmd
    .command('view <name>')
    .description('Show the parsed manifest detail')
    .action((name: string) => {
      const manifest = resolveCliManifest(name, process.cwd());
      if (!manifest) {
        console.error(chalk.red(`No CLI manifest named "${name}".`));
        process.exit(1);
      }
      console.log(chalk.bold.cyan(manifest.name));
      if (manifest.description) console.log('  ' + chalk.gray(manifest.description));
      if (manifest.homepage) console.log('  ' + chalk.gray(manifest.homepage));
      console.log('  ' + chalk.gray(`source: ${manifest.source}`));
      console.log('  ' + chalk.gray(`file: ${manifest.path}`));
      console.log('');
      console.log(chalk.bold('  check'));
      console.log('    ' + describeCheck(manifest.check));
      console.log('');
      console.log(chalk.bold('  install methods'));
      for (const method of manifest.install) {
        console.log('    ' + describeMethod(method));
      }
      if (manifest.postInstall) {
        console.log('');
        console.log(chalk.bold('  post_install'));
        for (const line of manifest.postInstall.trim().split('\n')) {
          console.log('    ' + line);
        }
      }
      console.log('');
      console.log(`  status: ${isCliInstalled(manifest) ? chalk.green('installed') : chalk.yellow('missing')}`);
    });

  cliCmd
    .command('add <name>')
    .description('Scaffold a new manifest at ~/.agents/clis/<name>.yaml')
    .option('--npm <pkg>', 'declare an npm install method')
    .option('--brew <formula>', 'declare a brew install method')
    .option('--script <url>', 'declare a curl|sh install method')
    .option('--description <text>', 'one-line description')
    .option('--homepage <url>', 'project homepage')
    .action((name: string, opts: { npm?: string; brew?: string; script?: string; description?: string; homepage?: string }) => {
      const dir = userCliDir();
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `${name}.yaml`);
      if (fs.existsSync(target)) {
        console.error(chalk.red(`Already exists: ${target}`));
        process.exit(1);
      }
      const methods: string[] = [];
      if (opts.npm) methods.push(`  - npm: "${opts.npm}"`);
      if (opts.brew) methods.push(`  - brew: ${opts.brew}`);
      if (opts.script) methods.push(`  - script: ${opts.script}`);
      if (methods.length === 0) {
        methods.push(`  - npm: "${name}"`);
      }
      const lines = [
        `name: ${name}`,
        ...(opts.description ? [`description: ${opts.description}`] : []),
        ...(opts.homepage ? [`homepage: ${opts.homepage}`] : []),
        `check: ${name} --version`,
        `install:`,
        ...methods,
      ];
      fs.writeFileSync(target, lines.join('\n') + '\n');
      console.log(chalk.green(`Created ${target}`));
    });
}
