/**
 * Install the standalone `secrets` CLI without re-embedding the engine.
 *
 * Prefers a declared `clis/secrets.yaml` (`agents clis install secrets`);
 * otherwise `npm i -g @phnx-labs/secrets-cli@<pin>`. Never writes a `secrets`
 * alias shim. Presence after install is `findInPath` (skips our shims dir).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installCli, resolveCliManifest } from './cli-resources.js';
import {
  SECRETS_CLI_INSTALL_HINT,
  SECRETS_CLI_SPEC,
  isSecretsPresent,
} from './secrets-cli.js';
import { forgetResolvedSecretsBin } from './secrets-client.js';

export interface InstallSecretsCliOptions {
  cwd?: string;
  /** Test seam: `npm i -g --prefix` so the suite does not touch the host prefix. */
  npmPrefix?: string;
  /** Report the method that would run, without spawning npm. */
  dryRun?: boolean;
}

export interface InstallSecretsCliResult {
  ok: boolean;
  alreadyInstalled: boolean;
  /** `clis` = declared host-CLI manifest; `npm` = the pinned package fallback. */
  method: 'clis' | 'npm' | null;
  error?: string;
}

function npmGlobalBin(): string | undefined {
  const r = spawnSync('npm', ['bin', '-g'], {
    encoding: 'utf8',
    timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const dir = r.stdout?.trim();
  if (r.status !== 0 || !dir) return undefined;
  return dir;
}

function prependPath(dir: string): void {
  const current = process.env.PATH ?? '';
  const resolved = path.resolve(dir);
  const already = current.split(path.delimiter).some((p) => {
    if (!p) return false;
    try {
      return path.resolve(p) === resolved;
    } catch {
      return false;
    }
  });
  if (already) return;
  process.env.PATH = `${dir}${path.delimiter}${current}`;
}

function afterInstallRefresh(npmPrefix?: string): void {
  const binDir = npmPrefix ? path.join(npmPrefix, 'bin') : npmGlobalBin();
  if (binDir && fs.existsSync(binDir)) prependPath(binDir);
  forgetResolvedSecretsBin();
}

function prefixedSecretsBin(npmPrefix: string): string {
  if (process.platform === 'win32') {
    return path.join(npmPrefix, 'lib', 'node_modules', '@phnx-labs', 'secrets-cli', 'dist', 'index.js');
  }
  return path.join(npmPrefix, 'bin', 'secrets');
}

function isDeclaredSecretsManifest(cwd?: string): boolean {
  const manifest = resolveCliManifest('secrets', cwd);
  return manifest !== null && manifest.source !== 'builtin';
}

/**
 * Ensure the standalone `secrets` binary is on PATH (skipping our shims dir).
 * Idempotent: a box that already has it is a no-op.
 */
export function installSecretsCli(opts: InstallSecretsCliOptions = {}): InstallSecretsCliResult {
  if (isSecretsPresent()) {
    return { ok: true, alreadyInstalled: true, method: null };
  }

  const declared = isDeclaredSecretsManifest(opts.cwd);
  const method: 'clis' | 'npm' = declared && !opts.npmPrefix ? 'clis' : 'npm';

  if (opts.dryRun) {
    return { ok: true, alreadyInstalled: false, method };
  }

  if (method === 'clis') {
    const manifest = resolveCliManifest('secrets', opts.cwd)!;
    const result = installCli(manifest);
    afterInstallRefresh();
    if (isSecretsPresent()) {
      return { ok: true, alreadyInstalled: false, method: 'clis' };
    }
    return {
      ok: false,
      alreadyInstalled: false,
      method: 'clis',
      error:
        result.error ??
        `Declared host CLI install ran but \`secrets\` is still missing. Install with:\n  ${SECRETS_CLI_INSTALL_HINT}`,
    };
  }

  const args = ['install', '-g', '--no-audit', '--no-fund', SECRETS_CLI_SPEC];
  if (opts.npmPrefix) args.push('--prefix', opts.npmPrefix);
  const r = spawnSync('npm', args, {
    encoding: 'utf8',
    timeout: 4 * 60 * 1000,
    stdio: opts.npmPrefix ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  afterInstallRefresh(opts.npmPrefix);

  if (opts.npmPrefix) {
    const bin = prefixedSecretsBin(opts.npmPrefix);
    if ((r.status ?? 1) === 0 && fs.existsSync(bin)) {
      return { ok: true, alreadyInstalled: false, method: 'npm' };
    }
  } else if (isSecretsPresent()) {
    return { ok: true, alreadyInstalled: false, method: 'npm' };
  }

  const detail = r.error?.message
    ?? (typeof r.stderr === 'string' && r.stderr.trim() ? r.stderr.trim() : `exit ${r.status ?? 'unknown'}`);
  return {
    ok: false,
    alreadyInstalled: false,
    method: 'npm',
    error: `Failed to install ${SECRETS_CLI_SPEC}: ${detail}\n  ${SECRETS_CLI_INSTALL_HINT}`,
  };
}
