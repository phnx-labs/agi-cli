/** Cloud dispatch commands for running agent tasks on remote infrastructure: one CLI to dispatch,
 * monitor and manage tasks across providers (Rush Cloud, Codex Cloud, Factory/Droid), all tracked
 * in a local SQLite database. */
import type { Command } from 'commander';
import chalk from 'chalk';
import { die, relTime, truncate, isJsonMode } from '../lib/format.js';
import { resolveProvider, getAllProviders, getDefaultProviderId } from '../lib/cloud/registry.js';
import { insertTask, updateTaskStatus, getTaskById, listTasks as listStoredTasks, listActiveTasks } from '../lib/cloud/store.js';
import { renderStream } from '../lib/cloud/stream.js';
import type { CloudProviderId, CloudTaskStatus, DispatchOptions } from '../lib/cloud/types.js';
import { MAX_IMAGES_PER_DISPATCH } from '../lib/cloud/types.js';
import { resolveCloudPrompt, executeCloudDispatch } from '../lib/cloud/dispatch.js';
import type { JobConfig, JobTrigger } from '../lib/scheduling/routines.js';
import { normalizeTriggerEvent, validateTrigger, writeJob, setJobEnabled, jobExists, GITHUB_TRIGGER_EVENTS } from '../lib/scheduling/routines.js';
import { emit } from '../lib/feed/events.js';

export function statusColor(status: string): (s: string) => string {
  switch (status) {
    case 'queued':
    case 'allocating': return chalk.blue;
    case 'running': return chalk.yellow;
    case 'idle': return chalk.gray;
    case 'completed': return chalk.green;
    case 'input_required': return chalk.magenta;
    case 'failed': return chalk.red;
    case 'cancelled': return chalk.gray;
    default: return chalk.white;
  }
}


export function registerCloudCommands(program: Command): void {
  const cloud = program
    .command('cloud', { hidden: true })
    .description('Dispatch and manage cloud agent tasks across providers (Rush, Codex, Cursor, Factory, Antigravity, Host).')
    .addHelpText('after', `
Each agent runs in its own cloud. Pass --agent and the provider is auto-selected
(claude→rush, codex→codex, cursor→cursor, droid→factory, antigravity→antigravity); --provider overrides.

Providers:
  rush         Rush Cloud — Claude against a GitHub repo + branch → PR
  codex        Codex Cloud — runs in a pre-built Codex environment (--env)
  cursor       Cursor Cloud Agents — v1 REST API, with optional GitHub repos
  factory      Factory Droid Computer — droid exec on a cloud VM (--computer)
  antigravity  Gemini Managed Agents — Antigravity harness in a remote sandbox

Examples:
  # Dispatch a quick fix to Rush Cloud and stream the output
  agents cloud run "fix the flaky e2e in apps/web/tests/checkout.spec.ts" --provider rush --repo acme/example --branch main

  # Fire-and-forget (returns the task id, no streaming)
  agents cloud run "bump tailwind to v4 and fix the breaks" --provider rush --repo acme/example --no-follow

  # Multi-repo dispatch: touch both rush and rush-extension in one task
  agents cloud run "rename POST /v1/charge -> /v2/charge across server + extension" --provider rush --repo acme/example --repo acme/example-extension

  # Codex Cloud against a saved environment
  agents cloud run "add pytest fixtures for the new billing module" --provider codex --env env_a1b2c3 --agent codex --timeout 30m

  # Cursor Cloud Agents against a GitHub repository
  agents cloud run "fix the flaky parser test" --agent cursor --repo acme/example

  # Factory pod targeting a specific computer (Droid)
  agents cloud run "QA the new onboarding flow end-to-end" --provider factory --computer linux-vm-1 --agent droid

  # See every cloud task you've dispatched (most recent first)
  agents cloud list

  # Inspect a specific task
  agents cloud status tsk_4f2a91

  # Live-tail logs for a running task
  agents cloud logs tsk_4f2a91

  # Send a follow-up while the task is in needs-review
  agents cloud message tsk_4f2a91 "Looks good — also update the OpenAPI spec"

  # Cancel a runaway task
  agents cloud cancel tsk_4f2a91

  # See which providers are signed in and ready
  agents cloud providers
`);

  cloud
    .command('run [prompt]')
    .description('Dispatch a task to a cloud agent.')
    .option('--provider <id>', 'Cloud backend: rush, codex, cursor, factory, antigravity, host (overrides agent auto-routing)')
    .option('--agent <name>', 'Agent to run: claude, codex, cursor, droid, antigravity (auto-routes to its native cloud)')
    .option(
      '--repo <owner/repo>',
      'GitHub repository. Repeatable for multi-repo dispatch (Rush or Cursor Cloud).',
      (value: string, previous: string[] | undefined) => {
        const acc = Array.isArray(previous) ? previous : [];
        acc.push(value);
        return acc;
      },
    )
    .option('--branch <name>', 'Target git branch')
    .option(
      '--on <event>',
      'Register this run as an event trigger instead of dispatching now: pull_request (pr), push, issue_comment, workflow_run. Persists a trigger-bound routine.',
    )
    .option('--action <name>', 'GitHub webhook action filter for --on triggers (e.g. labeled)')
    .option('--label <name>', 'GitHub label filter for --on triggers')
    .option('--name <name>', 'Routine name to register under (with --on). Defaults to a generated name.')
    .option('-p, --prompt <text>', 'Inline prompt (alternative to positional argument)')
    .option('--timeout <duration>', 'Kill after duration (e.g., 30m, 2h)')
    .option('--model <model>', 'Model override')
    .option('--env <id>', 'Codex Cloud environment ID')
    .option('--computer <name>', 'Factory/Droid computer target')
    .option('--device <name>', 'One of your machines as the target (a registered device, capability tag, or user@host). Implies --provider host.')
    .option('--remote-cwd <dir>', 'Working directory on the device (--provider host only)')
    .option('--any', 'With --device <cap> (a capability tag), pick any matching device instead of erroring when several match')
    .option('--autonomy <level>', 'Factory/Droid autonomy: low, medium, high (default high)')
    .option('--mode <mode>', 'Execution mode (e.g., plan, edit, full)')
    .option(
      '--image <path>',
      `Attach an image (.png/.jpg/.webp) for vision dispatch. Repeatable, up to ${MAX_IMAGES_PER_DISPATCH} (Rush Cloud only).`,
      (value: string, previous: string[] | undefined) => {
        const acc = Array.isArray(previous) ? previous : [];
        acc.push(value);
        return acc;
      },
    )
    .option(
      '--skill <id>',
      'Ride-along skill by id (or id@version). Repeatable (Rush Cloud only).',
      (value: string, previous: string[] | undefined) => {
        const acc = Array.isArray(previous) ? previous : [];
        acc.push(value);
        return acc;
      },
    )
    .option(
      '-b, --balanced',
      'Shortcut for --strategy balanced. Route the factory run across all healthy accounts.',
    )
    .option(
      '--strategy <strategy>',
      'Account selection strategy for the factory: balanced. Sends all healthy accounts so the factory pod rotates between them on rate-limit.',
    )
    .option('--json', 'Structured JSON output')
    .option('--no-follow', 'Dispatch and exit without streaming output')
    .addHelpText('after', `
Examples:
  # Rush Cloud
  agents cloud run "fix the flaky test" --provider rush --repo user/repo
  agents cloud run task.md --provider rush --repo org/project --agent codex

  # Rush Cloud — multi-repo (clones each into /workspace/<owner>/<name>/)
  agents cloud run "refactor shared logger" --provider rush --repo user/rush --repo user/agents

  # Codex Cloud
  agents cloud run "add auth tests" --provider codex --env env_abc123

  # One of your own machines (agents hosts / agents devices), over SSH
  agents cloud run "run the nightly benchmark" --device gpu-box --agent claude
  agents cloud run "rebuild the index" --device gpu --any --remote-cwd ~/proj

  # Default provider (set in ~/.agents/agents.yaml)
  agents cloud run "refactor auth module" --repo user/repo

  # Same dispatch as a run placement: agents run <agent> "<task>" --cloud
`)
    .action(async (positionalPrompt: string | undefined, options: Record<string, unknown>) => {
      const json = isJsonMode(options as { json?: boolean });

      const prompt = resolveCloudPrompt((options.prompt as string) || positionalPrompt, {
        json,
        hint: 'agents cloud run "<task>" --repo <owner/repo>',
      });

      if (options.device && options.provider && options.provider !== 'host') {
        die(`--device targets your own machines (--provider host), not ${options.provider}. Drop --device, or use --provider host.`, 1, { json });
      }
      const explicitProvider = (options.provider as string | undefined) ?? (options.device ? 'host' : undefined);

      const provider = resolveProvider(explicitProvider, options.agent as string | undefined);

      // --repo is repeatable: commander gives an array via our collector. A single value arrives
      // as a one-element array; keep the legacy singular `repo` field in sync for providers that
      // only know it.
      const repoValues = Array.isArray(options.repo)
        ? (options.repo as string[])
        : options.repo
          ? [options.repo as string]
          : [];

      const dispatchOptions: DispatchOptions = {
        prompt,
        agent: options.agent as string | undefined,
        repo: repoValues[0],
        repos: repoValues.length > 0 ? repoValues : undefined,
        branch: options.branch as string | undefined,
        timeout: options.timeout as string | undefined,
        model: options.model as string | undefined,
        providerOptions: {},
      };
      if (options.env) dispatchOptions.providerOptions!.env = options.env as string;
      if (options.computer) dispatchOptions.providerOptions!.computer = options.computer as string;
      if (options.device) dispatchOptions.providerOptions!.host = options.device as string;
      if (options.remoteCwd) dispatchOptions.providerOptions!.remoteCwd = options.remoteCwd as string;
      if (options.any) dispatchOptions.providerOptions!.any = true;
      if (options.autonomy) dispatchOptions.providerOptions!.autonomy = options.autonomy as string;
      if (options.mode) dispatchOptions.providerOptions!.mode = options.mode as string;
      if (options.balanced || (options.strategy as string) === 'balanced') {
        dispatchOptions.providerOptions!.strategy = 'balanced';
      }

      // --on <event>: register this run as an event trigger instead of dispatching now. Parse and
      // validate the event, attach it to dispatchOptions.trigger, and persist a trigger-bound
      // routine for the local webhook receiver. Remote firing is a follow-up.
      if (options.on) {
        const event = normalizeTriggerEvent(options.on as string);
        if (!event) {
          die(`Unknown --on event "${options.on}". Use one of: ${GITHUB_TRIGGER_EVENTS.join(', ')} (aliases: pr, comment, workflow).`, 1, { json });
        }
        const trigger: JobTrigger = { type: 'github_event', event: event! };
        if (repoValues[0]) trigger.repo = repoValues[0];
        if (options.branch) trigger.branch = options.branch as string;
        if (options.action) trigger.action = options.action as string;
        if (options.label) trigger.label = options.label as string;

        const triggerErrors = validateTrigger(trigger);
        if (triggerErrors.length > 0) die(`Invalid trigger: ${triggerErrors.join(', ')}`, 1, { json });

        dispatchOptions.trigger = trigger;

        const routineName = (options.name as string | undefined)
          || `cloud-${event}-${(repoValues[0] || 'any').replace(/[^a-z0-9]+/gi, '-')}`.toLowerCase();
        if (jobExists(routineName)) {
          die(`A routine named "${routineName}" already exists. Pass --name to register under a different name.`, 1, { json });
        }

        const routine: JobConfig = {
          name: routineName,
          trigger,
          agent: (options.agent as string as JobConfig['agent']) || 'claude',
          mode: 'plan',
          effort: 'auto',
          timeout: (options.timeout as string) || '10m',
          enabled: true,
          prompt,
        };
        if (repoValues[0]) routine.repo = repoValues[0];
        if (options.device) {
          routine.host = options.device as string;
          if (options.remoteCwd) routine.remoteCwd = options.remoteCwd as string;
        }
        writeJob(routine);
        setJobEnabled(routine.name, true);

        if (json) {
          console.log(JSON.stringify({ ok: true, registered: routineName, trigger }, null, 2));
        } else {
          console.log(chalk.green(`Registered trigger routine "${routineName}"`));
          console.log(`  ${chalk.dim('on:')}    ${event}${trigger.repo ? ` (${trigger.repo}${trigger.branch ? `@${trigger.branch}` : ''})` : ''}`);
          console.log(`  ${chalk.dim('agent:')} ${routine.agent}`);
          console.log(chalk.dim(`\nFires when a matching GitHub webhook is delivered to the local receiver. Remote firing is a follow-up.`));
        }
        return;
      }

      await executeCloudDispatch({
        provider,
        dispatchOptions,
        imagePaths: Array.isArray(options.image) ? (options.image as string[]) : [],
        skillIds: Array.isArray(options.skill) ? (options.skill as string[]) : [],
        follow: options.follow !== false,
        json,
      });
    });

  cloud
    .command('list')
    .description('List cloud tasks.')
    .option('--provider <id>', 'Filter by provider')
    .option('--status <status>', 'Filter by status')
    .option('--limit <n>', 'Max results', '20')
    .option('--json', 'JSON output')
    .action(async (options: Record<string, unknown>) => {
      const json = isJsonMode(options as { json?: boolean });
      const providerId = options.provider as CloudProviderId | undefined;
      const status = options.status as CloudTaskStatus | undefined;
      const limit = parseInt(options.limit as string, 10) || 20;

      const activeTasks = listActiveTasks();
      if (activeTasks.length > 0) {
        const byProvider = new Map<CloudProviderId, string[]>();
        for (const t of activeTasks) {
          if (providerId && t.provider !== providerId) continue;
          let ids = byProvider.get(t.provider);
          if (!ids) { ids = []; byProvider.set(t.provider, ids); }
          ids.push(t.id);
        }

        const refreshJobs: Promise<void>[] = [];
        for (const [pid, ids] of byProvider) {
          try {
            const provider = resolveProvider(pid);
            for (const id of ids) {
              refreshJobs.push(
                provider.status(id)
                  .then((fresh) => { insertTask(fresh); })
                  .catch(() => {}),
              );
            }
          } catch {
          }
        }

        if (refreshJobs.length > 0) {
          await Promise.allSettled(refreshJobs);
        }
      }

      const tasks = listStoredTasks({ provider: providerId, status, limit });

      if (json) {
        process.stdout.write(JSON.stringify(tasks, null, 2) + '\n');
        return;
      }

      if (tasks.length === 0) {
        console.log(chalk.dim('No cloud tasks found.'));
        return;
      }

      const header = [
        chalk.dim('ID'.padEnd(14)),
        chalk.dim('Provider'.padEnd(10)),
        chalk.dim('Status'.padEnd(16)),
        chalk.dim('Agent'.padEnd(8)),
        chalk.dim('Prompt'.padEnd(40)),
        chalk.dim('When'),
      ].join('  ');
      console.log(header);
      console.log(chalk.dim('-'.repeat(100)));

      for (const t of tasks) {
        const row = [
          t.id.slice(0, 12).padEnd(14),
          t.provider.padEnd(10),
          statusColor(t.status)(t.status.padEnd(16)),
          (t.agent ?? '-').padEnd(8),
          truncate(t.prompt.replace(/\n/g, ' '), 40).padEnd(40),
          chalk.dim(relTime(t.createdAt)),
        ].join('  ');
        console.log(row);
      }
    });

  cloud
    .command('status <id>')
    .description('Show task detail and latest status.')
    .option('--json', 'JSON output')
    .action(async (id: string, options: Record<string, unknown>) => {
      const json = isJsonMode(options as { json?: boolean });

      let task = getTaskById(id);
      const providerId = task?.provider;

      if (providerId) {
        try {
          const provider = resolveProvider(providerId);
          task = await provider.status(id);
          insertTask(task);
        } catch {
        }
      }

      if (!task) die(`Task ${id} not found.`);

      if (json) {
        process.stdout.write(JSON.stringify(task, null, 2) + '\n');
        return;
      }

      console.log(`${chalk.bold('Task')} ${task.id}`);
      console.log(`  ${chalk.dim('Provider:')}  ${task.provider}`);
      console.log(`  ${chalk.dim('Status:')}    ${statusColor(task.status)(task.status)}`);
      if (task.agent) console.log(`  ${chalk.dim('Agent:')}     ${task.agent}`);
      if (task.repo) console.log(`  ${chalk.dim('Repo:')}      ${task.repo}`);
      if (task.branch) console.log(`  ${chalk.dim('Branch:')}    ${task.branch}`);
      if (task.prUrl) console.log(`  ${chalk.dim('PR:')}        ${task.prUrl}`);
      console.log(`  ${chalk.dim('Prompt:')}    ${truncate(task.prompt.replace(/\n/g, ' '), 80)}`);
      console.log(`  ${chalk.dim('Created:')}   ${relTime(task.createdAt)}`);
      if (task.summary) {
        console.log(`  ${chalk.dim('Summary:')}   ${truncate(task.summary.replace(/\n/g, ' '), 120)}`);
      }
    });

  cloud
    .command('logs <id>')
    .description('Stream live output from a cloud task.')
    .option('-f, --follow', 'Follow output (default for running tasks)', true)
    .option('--json', 'JSON event stream')
    .action(async (id: string, options: Record<string, unknown>) => {
      const json = isJsonMode(options as { json?: boolean });

      const task = getTaskById(id);
      if (!task) die(`Task ${id} not found locally. Run 'agents cloud list' first.`);

      const provider = resolveProvider(task.provider);

      try {
        const { wrapStreamWithBudgetGate } = await import('../lib/budget/live-cloud.js');
        const gated = wrapStreamWithBudgetGate({
          provider,
          taskId: id,
          project: task.repo ?? task.repos?.[0] ?? process.cwd(),
          agent: task.agent ?? 'cloud',
          cwd: process.cwd(),
        });
        const eventSource = gated ? gated.wrap(provider.stream(id)) : provider.stream(id);
        const result = await renderStream(eventSource, { json });
        updateTaskStatus(id, result.status as CloudTaskStatus, {
          summary: result.summary,
          prUrl: result.prUrl,
        });
        emit('cloud.complete', { module: 'cloud', taskId: id, status: result.status, prUrl: result.prUrl });
        if (gated?.gate.breached()) {
          process.exitCode = 7;
        }
      } catch (err) {
        process.stderr.write(chalk.dim(`\nStream ended. ${(err as Error).message}\n`));
      }
    });

  cloud
    .command('cancel <id>')
    .description('Cancel a running cloud task.')
    .action(async (id: string) => {
      const task = getTaskById(id);
      if (!task) die(`Task ${id} not found.`);

      const provider = resolveProvider(task.provider);

      try {
        await provider.cancel(id);
        updateTaskStatus(id, 'cancelled');
        emit('cloud.cancel', { module: 'cloud', taskId: id, provider: task.provider });
        console.log(chalk.green(`Task ${id} cancelled.`));
      } catch (err) {
        die((err as Error).message);
      }
    });

  cloud
    .command('message <id> <text>')
    .description('Send a follow-up message to a finished or needs-review task.')
    .action(async (id: string, text: string) => {
      const task = getTaskById(id);
      if (!task) die(`Task ${id} not found.`);

      const provider = resolveProvider(task.provider);

      try {
        await provider.message(id, text);
        updateTaskStatus(id, 'running');
        emit('cloud.message', { module: 'cloud', taskId: id });
        console.log(chalk.green(`Message sent to task ${id}. Agent is continuing.`));
      } catch (err) {
        die((err as Error).message);
      }
    });

  cloud
    .command('providers')
    .description('List available cloud providers and their status.')
    .option('--json', 'JSON output')
    .action((options: Record<string, unknown>) => {
      const json = isJsonMode(options as { json?: boolean });
      const providers = getAllProviders();
      const defaultId = getDefaultProviderId();

      if (json) {
        const data = providers.map((p) => ({
          id: p.id,
          name: p.name,
          available: p.capabilities().available,
          default: p.id === defaultId,
        }));
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      console.log(chalk.bold('Cloud Providers\n'));
      for (const p of providers) {
        const available = p.capabilities().available;
        const isDefault = p.id === defaultId;
        const status = available ? chalk.green('ready') : chalk.dim('not configured');
        const defaultTag = isDefault ? chalk.cyan(' (default)') : '';
        console.log(`  ${p.id.padEnd(12)} ${p.name.padEnd(20)} ${status}${defaultTag}`);
      }
    });

  // agents cloud envs: discover the pre-provisioned targets a provider runs inside (Codex
  // environments, Factory Droid Computers) so users don't copy opaque IDs out of a web UI.
  cloud
    .command('envs')
    .alias('targets')
    .description('List the pre-provisioned targets (Codex environments / Droid Computers) you can dispatch into.')
    .option('--provider <id>', 'Only this provider (codex, factory, ...)')
    .option('--json', 'JSON output')
    .action(async (options: Record<string, unknown>) => {
      const json = isJsonMode(options as { json?: boolean });
      const only = options.provider as CloudProviderId | undefined;

      const providers = getAllProviders().filter((p) => p.targetKind && (!only || p.id === only));
      if (only && providers.length === 0) {
        die(`Provider '${only}' has no pre-provisioned targets (or is unknown). Targets apply to: codex, factory.`);
      }

      const results: Array<{ provider: CloudProviderId; kind: string; targets: { id: string; label?: string }[]; note?: string }> = [];
      for (const p of providers) {
        const kind = p.targetKind!;
        if (!p.listTargets) {
          const guidance = kind === 'env'
            ? 'Codex environments are not listable from the CLI. Browse/create them with `codex cloud` (interactive), then use --env <id>.'
            : 'Not enumerable from the CLI.';
          results.push({ provider: p.id, kind, targets: [], note: guidance });
          continue;
        }
        try {
          const targets = await p.listTargets();
          results.push({ provider: p.id, kind, targets: targets.map((t) => ({ id: t.id, label: t.label })) });
        } catch (err) {
          results.push({ provider: p.id, kind, targets: [], note: (err as Error).message });
        }
      }

      if (json) {
        process.stdout.write(JSON.stringify(results, null, 2) + '\n');
        return;
      }

      for (const r of results) {
        console.log(chalk.bold(`\n${r.provider}`) + chalk.dim(` (${r.kind})`));
        if (r.targets.length > 0) {
          for (const t of r.targets) {
            console.log(`  ${t.id}${t.label ? '  ' + chalk.dim(t.label) : ''}`);
          }
        } else {
          console.log(chalk.dim(`  ${r.note ?? 'none'}`));
        }
      }
    });
}
