/**
 * `agents menubar` — manage the macOS menu-bar helper.
 *
 * The helper is a no-Dock status-bar app that surfaces running sessions, agents
 * needing input, and routines, and launches new sessions. It auto-installs on
 * upgrade (runMigration -> installMenubarLaunchAgentOnUpgrade) for every macOS
 * user; these commands are the manual override.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { setHelpSections } from '../lib/help.js';
import {
  enableMenubarService,
  disableMenubarService,
  getMenubarStatus,
  runMenubarSetup,
  buildMenubarDoctorReport,
  type MenubarStatus,
  type SetupResult,
  type MenubarDoctorReport,
} from '../lib/menubar/install-menubar.js';

function notMac(): boolean {
  if (process.platform !== 'darwin') {
    console.log(chalk.yellow('AGI Menu is macOS only.'));
    return true;
  }
  return false;
}

/** Shared status readout — `status`, bare `menubar`, and `setup --check` all end here. */
function printStatus(s: MenubarStatus, opts: { brief?: boolean } = {}): void {
  const yn = (b: boolean) => (b ? chalk.green('yes') : chalk.gray('no'));
  console.log(chalk.bold('AGI Menu\n'));
  console.log(`  running            ${yn(s.running)}`);
  console.log(`  service installed  ${yn(s.serviceInstalled)}`);
  if (opts.brief) {
    console.log(chalk.gray('\n  setup | enable | disable | status'));
    return;
  }
  console.log(`  app installed      ${s.installedApp ? chalk.gray(s.installedApp) : chalk.gray('no')}`);
  console.log(`  helper installed   ${s.installedVersion ? chalk.gray(s.installedVersion) : chalk.gray('unknown')}`);
  console.log(`  helper available   ${chalk.gray(s.currentVersion)}`);
  console.log(`  CLI version        ${chalk.gray(s.cliVersion)}`);
  console.log(`  bundle source      ${s.source ? chalk.gray(s.source) : chalk.yellow(`not fetched yet — the background sync downloads ${s.currentVersion}; \`agents menubar setup\` fetches it now`)}`);
  console.log(`  disabled by user   ${yn(s.disabledByUser)}`);

  // Two copies of the INSTALLED bundle is the duplicate the user sees as two
  // agents marks in the menu bar. It used to read as a healthy `running: yes`.
  if (s.instances.length > 1) {
    console.log(chalk.yellow(`\n  ${s.instances.length} copies of AGI Menu are running — that is the duplicate menu-bar icon:`));
    for (const p of s.instances) console.log(chalk.gray(`    ${p.pid}  ${p.executable}`));
    console.log(chalk.gray('  Fix it with `agents menubar setup`.'));
  }
  if (s.foreignInstances.length > 0) {
    // RegisterEventHotKey is first-come, so the helper that registered the
    // chord first owns Cmd-Shift-V/O. A process list cannot say which that
    // was — only that a rival exists — so report the conflict, not a winner.
    // The loser has no other symptom: its chords simply never fire.
    const n = s.foreignInstances.length;
    console.log(chalk.yellow(`\n  ${n} other AGI Menu process${n === 1 ? '' : 'es'} running — ${n === 1 ? 'it' : 'they'} may hold Cmd-Shift-V/O instead of the installed one:`));
    for (const p of s.foreignInstances) console.log(chalk.gray(`    ${p.pid}  ${p.executable}`));
    console.log(chalk.gray('  End them with `agents menubar setup`.'));
  }
  if (s.stale) {
    // Not "runs on next startup": the self-heal only reinstalls from the install
    // that owns the helper, or from another one once the takeover cooldown has
    // passed (mayInstallMenubarHelper) — so on a box with several agents-cli
    // copies this can persist for a while. `setup` bypasses the gate and is the
    // immediate fix.
    console.log(chalk.yellow('\n  Installed AGI Menu is stale — `agents menubar setup` updates it now.'));
  } else if (!s.serviceInstalled && !s.disabledByUser) {
    console.log(chalk.gray('\n  Set it up with `agents menubar setup`.'));
  }
}

function printSetupResult(r: SetupResult): void {
  console.log(chalk.bold('AGI Menu setup\n'));
  for (const step of r.steps) {
    const mark = step.outcome === 'failed' ? chalk.red('✗')
      : step.outcome === 'changed' ? chalk.green('+') : chalk.green('✓');
    console.log(`  ${mark} ${step.name.padEnd(15)} ${chalk.gray(step.detail)}`);
  }
  console.log();
  if (r.configured) {
    console.log(chalk.green('AGI Menu configured.') + chalk.gray('  One agents mark, started at login.'));
  } else {
    console.log(chalk.red('AGI Menu not fully configured.') + chalk.gray('  See the failed step above.'));
  }
}

function printDoctorReport(r: MenubarDoctorReport): void {
  console.log(chalk.bold('AGI Menu doctor\n'));
  console.log(`  install path       ${r.installPath ? chalk.gray(r.installPath) : chalk.red('not installed')}`);
  console.log(`  helper installed   ${r.installedVersion ? chalk.gray(r.installedVersion) : chalk.gray('unknown')}`);
  console.log(`  helper available   ${chalk.gray(r.currentVersion)}${r.versionMatches ? '' : chalk.yellow('  (newer helper available — `agents menubar setup` installs it)')}`);
  console.log(`  CLI version        ${chalk.gray(r.cliVersion)}`);

  const identity = r.signingIdentity === 'developer-id'
    ? chalk.green('Developer ID (update-stable)')
    : r.signingIdentity === 'ad-hoc'
      ? chalk.red('ad-hoc (unstable — Accessibility grant breaks on every update)')
      : chalk.gray('unknown (nothing installed)');
  console.log(`  signing identity   ${identity}`);
  console.log(`  running            ${r.running ? chalk.green('yes') : chalk.gray('no')}`);

  if (r.staleRunningProcess.length > 0) {
    for (const p of r.staleRunningProcess) {
      const mark = p.stale
        ? chalk.red('started BEFORE the on-disk bundle — running the OLD binary')
        : chalk.green('matches the on-disk bundle');
      console.log(`  pid ${String(p.pid).padEnd(10)} ${mark}`);
    }
  }

  if (r.accessibilityHintNeeded) {
    console.log(chalk.yellow('\n  Accessibility grant may not be trusted for the current binary.'));
    console.log(chalk.gray('  Run `agents menubar setup` to reinstall + restart the helper, then grant access:'));
    console.log(chalk.gray('  open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"'));
  }
}

export function registerMenubarCommands(program: Command): void {
  const menubar = program
    .command('menubar')
    .description('Manage AGI Menu (running sessions, agents awaiting input, routines)');

  // `setup` is the one command that gets a machine to the intended state:
  // exactly one status item, started at login. `enable` stays the narrow
  // install+start; setup adds duplicate cleanup and verifies the end state.
  const setup = menubar
    .command('setup')
    .description('Configure AGI Menu end-to-end: one instance, started at login')
    .option('--check', 'Report the current state, change nothing')
    .option('--json', 'Emit machine-readable JSON')
    .action(async (options: { check?: boolean; json?: boolean }) => {
      if (options.check) {
        const s = getMenubarStatus();
        if (options.json) {
          process.stdout.write(JSON.stringify(s) + '\n');
          return;
        }
        if (notMac()) return;
        printStatus(s);
        return;
      }
      if (!options.json && notMac()) return;
      const r = await runMenubarSetup();
      if (options.json) {
        process.stdout.write(JSON.stringify(r) + '\n');
      } else {
        printSetupResult(r);
      }
      if (!r.configured) process.exitCode = 1;
    });

  setHelpSections(setup, {
    examples: `
      # Configure AGI Menu end-to-end (idempotent — safe to re-run)
      agents menubar setup

      # Two agents marks in the menu bar? This ends the duplicate.
      agents menubar setup

      # See the current state without changing anything
      agents menubar setup --check
    `,
    notes: `
      Configures, in order: every running helper ended, AGI Menu at
      ~/Library/Application Support/agents-cli/MenubarHelper.app, its code
      signature, the launchd login item (com.phnx-labs.agents-menubar —
      RunAtLoad + KeepAlive), then verifies exactly one helper came back up.

      Every running helper is ended and launchd restarts one, so the survivor is
      always the login-managed copy. Exits nonzero if it cannot reach that state.

      Setup clears a previous \`agents menubar disable\`. To turn AGI Menu off
      again, run \`agents menubar disable\`.
    `,
  });

  menubar
    .command('snapshot', { hidden: true })
    .description('Emit the consolidated AGI Menu polling snapshot.')
    .option('--json', 'Emit machine-readable JSON')
    .action(async () => {
      const { computeMenubarSnapshot } = await import('../lib/menubar/snapshot.js');
      process.stdout.write(`${JSON.stringify(await computeMenubarSnapshot())}\n`);
    });

  menubar
    .command('enable')
    .description('Install and start AGI Menu (launches at login)')
    .action(async () => {
      if (notMac()) return;
      let ok = false;
      try {
        ok = await enableMenubarService({ clearOptOut: true });
      } catch (e) {
        console.log(chalk.red(`Could not enable AGI Menu: ${(e as Error).message}`));
        return;
      }
      if (!ok) {
        console.log(chalk.red('Could not enable: no AGI Menu bundle ships with this install.'));
        console.log(chalk.gray('  This build may predate the helper, or be a non-macOS package.'));
        return;
      }
      console.log(chalk.green('AGI Menu enabled.') + chalk.gray('  Look for the agents mark in your menu bar.'));
    });

  menubar
    .command('disable')
    .description('Stop and remove AGI Menu (stays off across upgrades)')
    .action(() => {
      if (notMac()) return;
      disableMenubarService();
      console.log(chalk.green('AGI Menu disabled.') + chalk.gray('  Re-enable any time with `agents menubar setup`.'));
    });

  menubar
    .command('status')
    .description('Show whether AGI Menu is installed and running')
    .option('--json', 'Emit machine-readable JSON')
    .action((options: { json?: boolean }) => {
      const s = getMenubarStatus();
      if (options.json) {
        process.stdout.write(JSON.stringify(s) + '\n');
        return;
      }
      if (s.platform !== 'darwin') {
        console.log(chalk.yellow('AGI Menu is macOS only.'));
        return;
      }
      printStatus(s);
    });

  const doctor = menubar
    .command('doctor')
    .description('Diagnose AGI Menu: install path, version skew, signing identity, stale process')
    .option('--json', 'Emit machine-readable JSON')
    .action((options: { json?: boolean }) => {
      const r = buildMenubarDoctorReport();
      if (options.json) {
        process.stdout.write(JSON.stringify(r) + '\n');
        return;
      }
      if (r.platform !== 'darwin') {
        console.log(chalk.yellow('AGI Menu is macOS only.'));
        return;
      }
      printDoctorReport(r);
    });

  setHelpSections(doctor, {
    examples: `
      # Why did Accessibility ask again after an update?
      agents menubar doctor
    `,
    notes: `
      Read-only — never installs, restarts, or resets anything. Reports the
      installed bundle's signing identity (ad-hoc signing breaks the
      Accessibility grant on every update; Developer ID is stable across
      updates) and whether a live helper pid started before the on-disk
      bundle's last write — the sign that a running process is still the
      binary an update just replaced. \`agents menubar setup\` is the fix for
      anything this flags.
    `,
  });

  // Bare `agents menubar` -> status.
  menubar.action(() => {
    const s = getMenubarStatus();
    if (s.platform !== 'darwin') {
      console.log(chalk.yellow('AGI Menu is macOS only.'));
      return;
    }
    printStatus(s, { brief: true });
  });
}
