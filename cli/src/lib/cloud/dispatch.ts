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
import { shareRuntimeEnv } from '../share-runtime.js';

function imageMimeFromPath(file: string): ImageAttachment['mimeType'] {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  die(`Unsupported image type ${JSON.stringify(ext || file)}. Use .png, .jpg/.jpeg, or .webp.`);
}

function readImageAttachment(file: string): ImageAttachment {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    die(`Image not found: ${file}`);
  }
  const mimeType = imageMimeFromPath(file);
  return { data: fs.readFileSync(file).toString('base64'), mimeType };
}

function parseSkillRef(raw: string): SkillRef {
  const at = raw.lastIndexOf('@');
  if (at > 0) {
    return { id: raw.slice(0, at), version: raw.slice(at + 1) };
  }
  return { id: raw };
}

export function resolveCloudPrompt(raw: string | undefined, opts: { json: boolean; hint: string }): string {
  let prompt = raw;
  if (!prompt) die('Prompt is required. Pass it as an argument or with --prompt.', 1, { json: opts.json, hint: opts.hint });

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
    return undefined;
  }
}

interface ExecuteCloudDispatchParams {
  provider: CloudProvider;
  dispatchOptions: DispatchOptions;
  imagePaths?: string[];
  skillIds?: string[];
  follow: boolean;
  json: boolean;
}

export async function executeCloudDispatch(params: ExecuteCloudDispatchParams): Promise<void> {
  // Every cloud surface converges here so persistence, events, capability checks, and budget cancellation agree.
  const { provider, dispatchOptions, follow, json } = params;
  const imagePaths = params.imagePaths ?? [];
  const skillIds = params.skillIds ?? [];

  const shareEnv = shareRuntimeEnv();
  if (shareEnv) dispatchOptions.env = shareEnv;

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

  insertTask(task);
  emit('cloud.dispatch', { module: 'cloud', taskId: task.id, agent: task.agent, provider: task.provider as CloudProviderId, status: task.status });

  if (json) {
    process.stdout.write(JSON.stringify(task) + '\n');
  }

  if (!follow) return;

  try {
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
      process.exitCode = 7;
    }
  } catch (err) {
    process.stderr.write(chalk.dim(`\nStream disconnected. Task ${task.id} continues running.\n`));
    process.stderr.write(chalk.dim(`Check status: agents cloud status ${task.id}\n`));
  }
}
