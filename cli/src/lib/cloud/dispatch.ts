/**
 * Shared cloud dispatch core — the ONE path every cloud dispatch goes through.
 *
 * Both `agents cloud run` (commands/cloud.ts) and `agents run <agent> --cloud`
 * (commands/run-cloud.ts) build a DispatchOptions + resolve a provider, then
 * call executeCloudDispatch here. Behavior — capability checks, the missing-
 * target picker, local persistence, event emission, streaming, and the live
 * budget kill-switch — must not diverge between the two surfaces.
 */
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import ora from 'ora';
import { die } from '../format.js';
import { insertTask, updateTaskStatus } from './store.js';
import { renderStream } from './stream.js';
import type { CloudProvider, CloudProviderId, CloudTarget, CloudTaskStatus, DispatchOptions, ImageAttachment, SkillRef } from './types.js';
import { MissingTargetError, MAX_IMAGES_PER_DISPATCH } from './types.js';
import { emit } from '../feed/events.js';
import { shareRuntimeEnv } from '../share/config.js';

/** Map a supported image file extension to its wire mimeType. Rejects anything else. */
function imageMimeFromPath(file: string): ImageAttachment['mimeType'] {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  die(`Unsupported image type ${JSON.stringify(ext || file)}. Use .png, .jpg/.jpeg, or .webp.`);
}

/** Read one image file into a base64 ImageAttachment, dying with a clear error if it's missing. */
function readImageAttachment(file: string): ImageAttachment {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    die(`Image not found: ${file}`);
  }
  const mimeType = imageMimeFromPath(file);
  return { data: fs.readFileSync(file).toString('base64'), mimeType };
}

/** Parse a `--skill <id>` value (`id` or `id@version`) into a SkillRef. */
function parseSkillRef(raw: string): SkillRef {
  const at = raw.lastIndexOf('@');
  if (at > 0) {
    return { id: raw.slice(0, at), version: raw.slice(at + 1) };
  }
  return { id: raw };
}

/**
 * Resolve the prompt for a cloud dispatch: the raw value, or the contents of
 * the file it points at (with a dim note on TTY). Dies when empty.
 */
export function resolveCloudPrompt(raw: string | undefined, opts: { json: boolean; hint: string }): string {
  let prompt = raw;
  if (!prompt) die('Prompt is required. Pass it as an argument or with --prompt.', 1, { json: opts.json, hint: opts.hint });

  // If prompt is a file path, read it and tell the user
  if (fs.existsSync(prompt) && fs.statSync(prompt).isFile()) {
    const filePath = prompt;
    const stat = fs.statSync(filePath);
    const sizeKB = (stat.size / 1024).toFixed(1);
    prompt = fs.readFileSync(filePath, 'utf-8').trim();
    if (process.stderr.isTTY) {
      process.stderr.write(chalk.dim(`Reading prompt from ${filePath} (${sizeKB} KB)\n`));
    }
  }
  return prompt;
}

/**
 * After a `MissingTargetError`, try to resolve the target interactively.
 * Returns the chosen id, or undefined when no interactive resolution is
 * possible (non-TTY/JSON, provider can't enumerate, or user cancels) — the
 * caller then prints the error's guidance.
 *
 * Codex has no `listTargets` (no list-environments CLI), so it always returns
 * undefined here and the user sees the `codex cloud` guidance. Factory lists
 * Droid Computers; if listing fails (not signed in) or parses to nothing, we
 * fall back to a free-text prompt so a dispatch is never hard-blocked.
 */
async function pickMissingTarget(
  provider: CloudProvider,
  err: MissingTargetError,
  json: boolean,
): Promise<string | undefined> {
  if (json || !process.stdout.isTTY) return undefined;
  if (!provider.listTargets) return undefined;

  const { select, input } = await import('@inquirer/prompts');
  const promptName = err.kind === 'env' ? 'environment' : 'computer';

  let targets: CloudTarget[];
  try {
    targets = await provider.listTargets();
  } catch (listErr) {
    process.stderr.write(chalk.dim(`Could not list ${promptName}s: ${(listErr as Error).message}\n`));
    targets = [];
  }

  try {
    if (targets.length > 0) {
      return await select({
        message: `Select a ${promptName}`,
        choices: targets.map((t) => ({ value: t.id, name: t.label ? `${t.id}  ${chalk.dim(t.label)}` : t.id })),
      });
    }
    const typed = (await input({ message: `No ${promptName}s found. Enter a ${promptName} name (blank to cancel):` })).trim();
    return typed || undefined;
  } catch {
    // User hit Ctrl-C / Esc on the prompt.
    return undefined;
  }
}

interface ExecuteCloudDispatchParams {
  provider: CloudProvider;
  dispatchOptions: DispatchOptions;
  /** Image file paths for vision dispatch (checked against provider capability). */
  imagePaths?: string[];
  /** Raw skill refs (`id` or `id@version`) for ride-along skills. */
  skillIds?: string[];
  /** Stream the task output after dispatch; false = fire-and-forget. */
  follow: boolean;
  json: boolean;
}

/**
 * Dispatch a cloud task and (unless follow=false) stream it to completion.
 * Owns: share-env injection, capability checks, the dispatch spinner +
 * missing-target picker, local persistence, event emission, and the budget
 * kill-switch. Dies on any dispatch failure — callers never see a partial.
 */
export async function executeCloudDispatch(params: ExecuteCloudDispatchParams): Promise<void> {
  const { provider, dispatchOptions, follow, json } = params;
  const imagePaths = params.imagePaths ?? [];
  const skillIds = params.skillIds ?? [];

  const shareEnv = shareRuntimeEnv();
  if (shareEnv) dispatchOptions.env = shareEnv;

  // Vision attachments + ride-along skills. Only wire them when the resolved
  // provider advertises support — otherwise fail loud rather than silently
  // drop the flags the user passed.
  const caps = provider.capabilities();
  if (imagePaths.length > 0) {
    if (!caps.images) die(`${provider.name} does not support image attachments.`, 1, { json });
    if (imagePaths.length > MAX_IMAGES_PER_DISPATCH) {
      die(`Too many images: ${imagePaths.length}. Max is ${MAX_IMAGES_PER_DISPATCH} per dispatch.`, 1, { json });
    }
    dispatchOptions.images = imagePaths.map(readImageAttachment);
  }
  if (skillIds.length > 0) {
    if (!caps.skills) die(`${provider.name} does not support ride-along skills.`, 1, { json });
    dispatchOptions.skills = skillIds.map(parseSkillRef);
  }

  // Dispatch. On a missing pre-provisioned target (Codex env / Factory
  // computer), offer an interactive picker instead of a raw error.
  const dispatchOnce = async () => {
    const spinner = ora({ text: `Dispatching to ${provider.name}...`, stream: process.stderr }).start();
    try {
      const t = await provider.dispatch(dispatchOptions);
      spinner.succeed(`Task ${t.id} dispatched to ${provider.name}`);
      return t;
    } catch (err) {
      spinner.fail('Dispatch failed');
      throw err;
    }
  };

  let task;
  try {
    task = await dispatchOnce();
  } catch (err) {
    if (err instanceof MissingTargetError) {
      const picked = await pickMissingTarget(provider, err, json);
      if (!picked) {
        die(err.guidance ? `${err.message}\n\n${err.guidance}` : err.message, 1, { json });
      }
      dispatchOptions.providerOptions![err.kind] = picked;
      try {
        task = await dispatchOnce();
      } catch (err2) {
        die((err2 as Error).message, 1, { json });
      }
    } else {
      die((err as Error).message, 1, { json });
    }
  }

  // Persist locally
  insertTask(task);
  emit('cloud.dispatch', { module: 'cloud', taskId: task.id, agent: task.agent, provider: task.provider as CloudProviderId, status: task.status });

  if (json) {
    process.stdout.write(JSON.stringify(task) + '\n');
  }

  // Stream output unless --no-follow
  if (!follow) return;

  try {
    // Live budget kill-switch (issue #399). Reuses makeLiveSpendWatcher to
    // feed the provider's `usage` events into a shared watcher; on a cap
    // breach we call provider.cancel(task.id) mid-stream. Dormant (returns
    // null) when no caps are configured, so the raw stream flows unchanged.
    const { wrapStreamWithBudgetGate } = await import('../budget/live-cloud.js');
    const gated = wrapStreamWithBudgetGate({
      provider,
      taskId: task.id,
      project: task.repo ?? task.repos?.[0] ?? process.cwd(),
      agent: task.agent ?? 'cloud',
      cwd: process.cwd(),
    });
    const eventSource = gated ? gated.wrap(provider.stream(task.id)) : provider.stream(task.id);
    const result = await renderStream(eventSource, { json });
    updateTaskStatus(task.id, result.status as CloudTaskStatus, {
      summary: result.summary,
      prUrl: result.prUrl,
    });
    emit('cloud.complete', { module: 'cloud', taskId: task.id, status: result.status, prUrl: result.prUrl });
    if (gated?.gate.breached()) {
      const b = gated.gate.breach();
      process.stderr.write(
        `[budget] cap ${b?.cap} exceeded — cancelled cloud task ${task.id}\n`,
      );
      process.exitCode = 7; // Mirrors BUDGET_KILL_EXIT_CODE for CI/headless.
    }
  } catch (err) {
    // Stream disconnect is OK — task keeps running
    process.stderr.write(chalk.dim(`\nStream disconnected. Task ${task.id} continues running.\n`));
    process.stderr.write(chalk.dim(`Check status: agents cloud status ${task.id}\n`));
  }
}
