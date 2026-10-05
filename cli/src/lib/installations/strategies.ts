import * as crypto from 'crypto';
import { promisify } from 'util';
import { exec, execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AGENTS, findInPath, isSelfUpdatingAgent } from '../agents.js';
import { VERSION_RE } from '../agent-spec/primitives.js';
import { importInstallScriptBinary } from '../import.js';
import {
  getBinaryPath,
  getLatestNpmVersion,
  getOldestNpmVersion,
  getLiveVersion,
  getVersionHomePath,
  invalidateLiveVersionCache,
  isGlobalBinaryAgent,
} from './versions.js';
import type { AgentId } from '../types.js';
import { installationDir } from './store.js';
import type { Installation, UpdateStrategyId } from './types.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const INSTALL_TIMEOUT_MS = 120_000;

export interface UpdateContext {
  agent: AgentId;
  installation: Installation;
  requested: string;
  onProgress?: (message: string) => void;
}

export interface StagedRelease {
  release: string;
  binary: string;
  home: string;
  stagingDir: string | null;
}

export interface CommitHandles {
  undo: () => void;
  finalize: () => void;
}

export interface UpdateStrategy {
  readonly id: UpdateStrategyId;
  readonly transactional: boolean;
  readonly sharedBinary: boolean;
  resolveTarget(ctx: UpdateContext): Promise<string>;
  stage(ctx: UpdateContext, target: string): Promise<StagedRelease>;
  commit(ctx: UpdateContext, staged: StagedRelease): Promise<CommitHandles>;
}

function runId(): string {
  return `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
}

function moveDir(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

const NPM_LIVE_ENTRIES = ['node_modules', 'package.json', 'package-lock.json'] as const;

const npmPackageStrategy: UpdateStrategy = {
  id: 'npm-package',
  transactional: true,
  sharedBinary: false,

  async resolveTarget(ctx) {
    if (ctx.requested === 'latest' || ctx.requested === 'oldest') {
      const resolved = ctx.requested === 'latest'
        ? await getLatestNpmVersion(ctx.agent)
        : await getOldestNpmVersion(ctx.agent);
      if (!resolved) {
        throw new Error(
          `Could not resolve the ${ctx.requested} published version for ${AGENTS[ctx.agent].name} from npm.`
        );
      }
      return resolved;
    }
    return ctx.requested;
  },

  async stage(ctx, target) {
    const pkg = AGENTS[ctx.agent].npmPackage;
    const dir = installationDir(ctx.agent, ctx.installation.label);
    const stagingDir = path.join(dir, `.staging-${runId()}`);
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(
      path.join(stagingDir, 'package.json'),
      JSON.stringify({ name: `agents-${ctx.agent}-${target}`, version: '1.0.0', private: true }, null, 2)
    );

    const winShell = process.platform === 'win32';
    ctx.onProgress?.(`Staging ${pkg}@${target}...`);
    await execFileAsync('npm', ['install', `${pkg}@${target}`, '--ignore-scripts'], {
      cwd: stagingDir,
      shell: winShell,
      timeout: INSTALL_TIMEOUT_MS,
    });

    const pkgRoot = path.join(stagingDir, 'node_modules', pkg);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf-8'));
      const postinstall = manifest?.scripts?.postinstall;
      if (typeof postinstall === 'string' && postinstall.trim()) {
        ctx.onProgress?.(`Running ${AGENTS[ctx.agent].name} postinstall...`);
        await execFileAsync(postinstall, [], { cwd: pkgRoot, shell: true, timeout: INSTALL_TIMEOUT_MS });
      }
    } catch {
    }

    return {
      release: target,
      binary: path.join(stagingDir, 'node_modules', '.bin', AGENTS[ctx.agent].cliCommand),
      home: getVersionHomePath(ctx.agent, ctx.installation.label),
      stagingDir,
    };
  },

  async commit(ctx, staged) {
    const dir = installationDir(ctx.agent, ctx.installation.label);
    const rollbackDir = path.join(dir, `.rollback-${runId()}`);
    const displaced: string[] = [];
    const stagedIn: string[] = [];

    const restorePreCommitState = () => {
      const errors: string[] = [];
      for (const entry of [...stagedIn].reverse()) {
        try { fs.rmSync(path.join(dir, entry), { recursive: true, force: true }); }
        catch (err) { errors.push(`${entry}: ${(err as Error).message}`); }
      }
      for (const entry of [...displaced].reverse()) {
        try { moveDir(path.join(rollbackDir, entry), path.join(dir, entry)); }
        catch (err) { errors.push(`${entry}: ${(err as Error).message}`); }
      }
      if (errors.length) throw new Error(`Rollback incomplete; recovery files retained at ${rollbackDir}: ${errors.join('; ')}`);
      fs.rmSync(rollbackDir, { recursive: true, force: true });
    };

    try {
      for (const entry of NPM_LIVE_ENTRIES) {
        const live = path.join(dir, entry);
        if (!fs.existsSync(live)) continue;
        moveDir(live, path.join(rollbackDir, entry));
        displaced.push(entry);
      }
      for (const entry of NPM_LIVE_ENTRIES) {
        const from = path.join(staged.stagingDir!, entry);
        if (fs.existsSync(from)) {
          moveDir(from, path.join(dir, entry));
          stagedIn.push(entry);
        }
      }
    } catch (err) {
      restorePreCommitState();
      throw new Error(
        `${(err as Error).message} The swap was interrupted partway through and has been rolled back to `
        + `${ctx.installation.releaseVersion}.`
      );
    }

    return {
      undo: restorePreCommitState,
      finalize: () => fs.rmSync(rollbackDir, { recursive: true, force: true }),
    };
  },
};

const globalBinaryStrategy: UpdateStrategy = {
  id: 'global-binary',
  transactional: false,
  sharedBinary: true,

  async resolveTarget(ctx) {
    if (ctx.requested !== 'latest') {
      throw new Error(
        `${AGENTS[ctx.agent].name} is a single self-updating binary with no pinnable releases — `
        + `it can only be updated to the current one. Re-run: agents update ${ctx.agent}@${ctx.installation.label} --to latest`
      );
    }
    return 'latest';
  },

  async stage(ctx) {
    const script = AGENTS[ctx.agent].installScript!;
    ctx.onProgress?.(`Updating ${AGENTS[ctx.agent].name} via official installer...`);
    await execAsync(script, { timeout: INSTALL_TIMEOUT_MS });
    invalidateLiveVersionCache(ctx.agent);
    const live = await getLiveVersion(ctx.agent);
    if (!live) {
      throw new Error(
        `${AGENTS[ctx.agent].name} installer finished but its version could not be determined.`
      );
    }
    return {
      release: live,
      binary: getBinaryPath(ctx.agent, ctx.installation.label),
      home: getVersionHomePath(ctx.agent, ctx.installation.label),
      stagingDir: null,
    };
  },

  async commit() {
    return { undo: () => {}, finalize: () => {} };
  },
};

const installScriptStrategy: UpdateStrategy = {
  id: 'install-script',
  transactional: false,
  sharedBinary: false,

  async resolveTarget(ctx) {
    const script = AGENTS[ctx.agent].installScript!;
    if (!script.includes('VERSION') && ctx.requested !== 'latest') {
      throw new Error(
        `${AGENTS[ctx.agent].name}'s installer takes no version, so it can only be updated to the current release. `
        + `Re-run: agents update ${ctx.agent}@${ctx.installation.label} --to latest`
      );
    }
    return ctx.requested;
  },

  async stage(ctx, target) {
    const config = AGENTS[ctx.agent];
    const script = config.installScript!.replaceAll('VERSION', target === 'latest' ? 'latest' : target);
    ctx.onProgress?.(`Updating ${config.name} via official installer...`);
    await execAsync(script, { timeout: INSTALL_TIMEOUT_MS });
    invalidateLiveVersionCache(ctx.agent);

    const installed = findInPath(config.cliCommand);
    if (!installed) {
      throw new Error(
        `${config.name} installer finished but ${config.cliCommand} is not on PATH — the install did not complete.`
      );
    }

    const release = target === 'latest'
      ? (await getLiveVersion(ctx.agent)) ?? target
      : target;

    const dir = installationDir(ctx.agent, ctx.installation.label);
    const stagingDir = path.join(dir, `.staging-${runId()}`);
    fs.mkdirSync(stagingDir, { recursive: true });
    const imported = importInstallScriptBinary(
      { agentId: ctx.agent, npmPackage: config.npmPackage, cliCommand: config.cliCommand },
      ctx.installation.label,
      installed,
      stagingDir
    );
    if (!imported.success) {
      throw new Error(
        `${config.name} ${release} was installed but could not be linked into the version directory: ${imported.error ?? 'unknown error'}`
      );
    }

    return {
      release,
      binary: path.join(stagingDir, 'node_modules', '.bin', config.cliCommand),
      home: getVersionHomePath(ctx.agent, ctx.installation.label),
      stagingDir,
    };
  },

  commit: npmPackageStrategy.commit,
};

export function selectUpdateStrategy(agent: AgentId): UpdateStrategy {
  const config = AGENTS[agent];
  if (config.npmPackage) return npmPackageStrategy;
  if (config.installScript && isGlobalBinaryAgent(agent)) return globalBinaryStrategy;
  if (config.installScript) {
    if (!usesVersionDirLinkFarm(agent)) {
      throw new Error(
        `${config.name} keeps its binary outside the managed version directory, so agents-cli cannot yet update an `
        + `installation in place. Install the current release as a new installation: agents add ${agent}@latest`
      );
    }
    return installScriptStrategy;
  }
  throw new Error(
    `${config.name} is not installed by agents-cli (it declares no npm package and no installer), so there is nothing to update. `
    + `Update it with its own tooling.`
  );
}

function usesVersionDirLinkFarm(agent: AgentId): boolean {
  const probe = '0.0.0-probe';
  const expected = path.join(installationDir(agent, probe), 'node_modules', '.bin', AGENTS[agent].cliCommand);
  return getBinaryPath(agent, probe) === expected;
}

export function supportsPinnedUpdate(agent: AgentId): boolean {
  const config = AGENTS[agent];
  if (config.npmPackage) return true;
  return !isSelfUpdatingAgent(agent);
}

export function assertValidRelease(requested: string): void {
  if (!VERSION_RE.test(requested)) {
    throw new Error(`Invalid release: ${JSON.stringify(requested)}`);
  }
}
