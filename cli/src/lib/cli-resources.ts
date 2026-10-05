import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync, execFile } from 'child_process';
import * as yaml from 'yaml';
import { listResources, resolveResource } from './resources.js';
import { probeCapture } from './probe.js';
import { composeWin32CommandLine } from './platform/index.js';
import { execFileShellSpec } from './platform/exec.js';
import { localBinDir } from './platform/posixpath.js';
import { compareVersions } from './agent-spec/primitives.js';

// ─── Validation primitives ───────────────────────────────────────────────────

/** Token allowed inside `check:` strings — letters, digits, underscore, dot, slash, dash. */
const SAFE_CHECK_TOKEN = /^[a-zA-Z0-9_./-]+$/;

/** npm package name with optional scope and optional version/tag. */
const NPM_PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[a-zA-Z0-9._-]+)?$/;

/** Homebrew formula name (and optional tap prefix). */
const BREW_FORMULA = /^([a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*\/)?[a-z0-9][a-z0-9_.+-]*$/;

/** Path segment inside a tarball — no leading slash, no `..`, no shell metas. */
const SAFE_PATH_SEGMENT = /^[a-zA-Z0-9_./-]+$/;

function assertSafeCheckToken(tok: string): void {
  if (!SAFE_CHECK_TOKEN.test(tok)) {
    throw new Error(`check contains unsafe token: ${JSON.stringify(tok)}`);
  }
}

function assertNpmPackage(name: string): void {
  if (!NPM_PACKAGE.test(name)) {
    throw new Error(`npm package name is not allowlisted: ${JSON.stringify(name)}`);
  }
}

function assertBrewFormula(name: string): void {
  if (!BREW_FORMULA.test(name)) {
    throw new Error(`brew formula name is not allowlisted: ${JSON.stringify(name)}`);
  }
}

function assertHttpsUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`url is not parseable: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`url must use https:// (got ${parsed.protocol}): ${JSON.stringify(url)}`);
  }
}

function assertSafePathSegment(seg: string): void {
  if (!SAFE_PATH_SEGMENT.test(seg) || seg.startsWith('/') || seg.split('/').includes('..')) {
    throw new Error(`extract path is not allowlisted: ${JSON.stringify(seg)}`);
  }
}


export type InstallMethod =
  | { npm: string }
  | { brew: string }
  | { script: string }
  | { binary: BinarySpec };

export interface BinarySpec {
  [platform: string]: {
    url: string;
    extract?: string;
  };
}

export type CheckSpec =
  | { kind: 'which'; cmd: string }
  | { kind: 'version'; cmd: string; args: string[] };

export interface CliManifest {
  name: string;
  description?: string;
  homepage?: string;
  check: CheckSpec;
  install: InstallMethod[];
  postInstall?: string;
  source: string;
  path: string;
}

interface CliManifestError {
  file: string;
  reason: string;
}


function parseCheckSpec(raw: unknown, defaultName: string): CheckSpec {
  // Project/extra manifests are untrusted: process fields remain allowlisted argv.
  if (raw == null) {
    assertSafeCheckToken(defaultName);
    return { kind: 'version', cmd: defaultName, args: ['--version'] };
  }
  if (typeof raw === 'string') {
    const tokens = raw.trim().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) {
      assertSafeCheckToken(defaultName);
      return { kind: 'version', cmd: defaultName, args: ['--version'] };
    }
    for (const tok of tokens) assertSafeCheckToken(tok);
    const [cmd, ...args] = tokens;
    return args.length === 0 ? { kind: 'which', cmd } : { kind: 'version', cmd, args };
  }
  if (typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    const kind = r.kind;
    if (kind !== 'which' && kind !== 'version') {
      throw new Error(`check.kind must be "which" or "version" (got ${JSON.stringify(kind)})`);
    }
    if (typeof r.cmd !== 'string' || !r.cmd.trim()) {
      throw new Error('check.cmd must be a non-empty string');
    }
    const cmd = r.cmd.trim();
    assertSafeCheckToken(cmd);
    if (kind === 'which') return { kind: 'which', cmd };
    const args = Array.isArray(r.args) ? r.args : [];
    const safeArgs: string[] = [];
    for (const a of args) {
      if (typeof a !== 'string') throw new Error('check.args entries must be strings');
      assertSafeCheckToken(a);
      safeArgs.push(a);
    }
    return { kind: 'version', cmd, args: safeArgs };
  }
  throw new Error('check must be a string or an object with { kind, cmd, args? }');
}

export function parseCliManifest(
  contents: string,
  opts: { name: string; source: string; path: string },
): CliManifest {
  const raw = yaml.parseDocument(contents, { strict: false }).toJS();
  if (!raw || typeof raw !== 'object') {
    throw new Error('manifest must be a YAML object');
  }

  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : opts.name;
  assertSafeCheckToken(name);
  const description = typeof raw.description === 'string' ? raw.description : undefined;
  const homepage = typeof raw.homepage === 'string' ? raw.homepage : undefined;
  const check = parseCheckSpec(raw.check, name);
  const postInstall = typeof raw.post_install === 'string' ? raw.post_install : undefined;

  if (!Array.isArray(raw.install) || raw.install.length === 0) {
    throw new Error('install must be a non-empty list of methods');
  }

  const install: InstallMethod[] = raw.install.map((entry: unknown, i: number) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`install[${i}] must be an object with one of: npm, brew, script, binary`);
    }
    const e = entry as Record<string, unknown>;
    const keys = Object.keys(e).filter((k) => e[k] !== undefined && e[k] !== null);
    if (keys.length !== 1) {
      throw new Error(`install[${i}] must declare exactly one method (got: ${keys.join(', ') || 'none'})`);
    }
    const key = keys[0];
    const value = e[key];
    if (key === 'npm') {
      if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`install[${i}].npm must be a non-empty string`);
      }
      const v = value.trim();
      assertNpmPackage(v);
      return { npm: v };
    }
    if (key === 'brew') {
      if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`install[${i}].brew must be a non-empty string`);
      }
      const v = value.trim();
      assertBrewFormula(v);
      return { brew: v };
    }
    if (key === 'script') {
      if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`install[${i}].script must be a non-empty string`);
      }
      const v = value.trim();
      assertHttpsUrl(v);
      return { script: v };
    }
    if (key === 'binary') {
      if (!value || typeof value !== 'object') {
        throw new Error(`install[${i}].binary must be a platform map`);
      }
      const binary: BinarySpec = {};
      for (const [platform, spec] of Object.entries(value as Record<string, unknown>)) {
        if (!spec || typeof spec !== 'object') {
          throw new Error(`install[${i}].binary.${platform} must be an object with a url`);
        }
        const s = spec as Record<string, unknown>;
        if (typeof s.url !== 'string' || !s.url.trim()) {
          throw new Error(`install[${i}].binary.${platform}.url must be a non-empty string`);
        }
        const url = s.url.trim();
        assertHttpsUrl(url);
        let extract: string | undefined;
        if (typeof s.extract === 'string' && s.extract.length > 0) {
          assertSafePathSegment(s.extract);
          extract = s.extract;
        }
        binary[platform] = { url, extract };
      }
      return { binary };
    }
    throw new Error(`install[${i}] has unknown method "${key}" (expected: npm, brew, script, binary)`);
  });

  return {
    name,
    description,
    homepage,
    check,
    install,
    postInstall,
    source: opts.source,
    path: opts.path,
  };
}

export function listCliManifests(cwd?: string): {
  manifests: CliManifest[];
  errors: CliManifestError[];
} {
  const resolved = listResources('clis', cwd);
  const manifests: CliManifest[] = [];
  const errors: CliManifestError[] = [];

  for (const entry of resolved) {
    if (!entry.path.endsWith('.yaml') && !entry.path.endsWith('.yml')) continue;
    try {
      const contents = fs.readFileSync(entry.path, 'utf-8');
      const manifest = parseCliManifest(contents, {
        name: entry.name,
        source: entry.source,
        path: entry.path,
      });
      manifests.push(manifest);
    } catch (err) {
      errors.push({ file: entry.path, reason: (err as Error).message });
    }
  }

  return { manifests, errors };
}

export function resolveCliManifest(name: string, cwd?: string): CliManifest | null {
  const resolved = resolveResource('clis', name, cwd);
  if (!resolved) return null;
  if (!resolved.path.endsWith('.yaml') && !resolved.path.endsWith('.yml')) return null;
  const contents = fs.readFileSync(resolved.path, 'utf-8');
  return parseCliManifest(contents, {
    name: resolved.name,
    source: resolved.source,
    path: resolved.path,
  });
}


const cmdExistsCache = new Map<string, boolean>();
export function hasCommand(cmd: string): boolean {
  if (cmdExistsCache.has(cmd)) return cmdExistsCache.get(cmd)!;
  let ok: boolean;
  if (process.platform === 'win32') {
    ok = spawnSync('where', [cmd], { stdio: 'ignore' }).status === 0;
  } else {
    ok = spawnSync('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', '_', cmd], {
      stdio: 'ignore',
    }).status === 0;
  }
  cmdExistsCache.set(cmd, ok);
  return ok;
}

export function isCliInstalled(manifest: CliManifest): boolean {
  const c = manifest.check;
  if (c.kind === 'which') {
    cmdExistsCache.delete(c.cmd);
    return hasCommand(c.cmd);
  }
  const result = spawnSync(c.cmd, c.args, { stdio: 'ignore', timeout: 10_000 });
  if (result.status === 0) return true;
  if (process.platform === 'win32' && result.error) {
    // Shell retry is safe only because manifest parsing already validated every token.
    const line = composeWin32CommandLine(c.cmd, c.args);
    const retry = spawnSync(line, { stdio: 'ignore', timeout: 10_000, shell: true });
    return retry.status === 0;
  }
  return false;
}

export function isCliInstalledAsync(manifest: CliManifest): Promise<boolean> {
  const c = manifest.check;
  if (c.kind === 'which') {
    cmdExistsCache.delete(c.cmd);
    return Promise.resolve(hasCommand(c.cmd));
  }
  return probeCapture(c.cmd, c.args, 10_000).then(
    () => true,
    (err) => {
      const spawnFailed = typeof (err as NodeJS.ErrnoException).code === 'string';
      if (process.platform === 'win32' && spawnFailed) {
        // Shell retry is safe only because manifest parsing already validated every token.
        const line = composeWin32CommandLine(c.cmd, c.args);
        return new Promise<boolean>((resolve) => {
          execFile(line, { timeout: 10_000, shell: true }, (retryErr) => resolve(!retryErr));
        });
      }
      return false;
    },
  );
}


export function selectInstallMethod(manifest: CliManifest): InstallMethod | null {
  for (const method of manifest.install) {
    if ('npm' in method && hasCommand('npm')) return method;
    if ('brew' in method && hasCommand('brew')) return method;
    if ('script' in method && (hasCommand('curl') || hasCommand('wget'))) return method;
    if ('binary' in method) {
      const key = `${process.platform}-${process.arch}`;
      if (method.binary[key]) return method;
    }
  }
  return null;
}

export function describeCheck(check: CheckSpec): string {
  return check.kind === 'which' ? check.cmd : `${check.cmd} ${check.args.join(' ')}`.trim();
}

export function describeMethod(method: InstallMethod): string {
  if ('npm' in method) return `npm install -g ${method.npm}`;
  if ('brew' in method) return `brew install ${method.brew}`;
  if ('script' in method) return `curl ${method.script} | sh`;
  const key = `${process.platform}-${process.arch}`;
  const spec = method.binary[key];
  return spec ? `download ${spec.url}` : 'binary download';
}


export interface InstallResult {
  manifest: CliManifest;
  method: InstallMethod | null;
  installed: boolean;
  output?: string;
  error?: string;
}

const BIN_DIR_ENV = 'AGENTS_CLI_BIN_DIR';

const LEGACY_BIN_DIR = '/usr/local/bin';

function isWritableDir(dir: string, opts: { create: boolean }): boolean {
  try {
    if (opts.create) fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveBinDir(): string {
  const override = process.env[BIN_DIR_ENV];
  if (override && override.trim()) return override.trim();

  const local = localBinDir();
  if (isWritableDir(local, { create: true })) return local;

  if (isWritableDir(LEGACY_BIN_DIR, { create: false })) return LEGACY_BIN_DIR;

  throw new Error(
    `${LEGACY_BIN_DIR} is not writable (EACCES) and ~/.local/bin could not be created or ` +
      `written to either. Set ${BIN_DIR_ENV} to a writable directory, e.g.:\n` +
      `  export ${BIN_DIR_ENV}="$HOME/.local/bin"\n` +
      `then re-run the install.`,
  );
}

export function buildInstallCommand(method: InstallMethod): string {
  if ('npm' in method) return `npm install -g ${method.npm}`;
  if ('brew' in method) return `brew install ${method.brew}`;
  if ('script' in method) {
    return hasCommand('curl')
      ? `curl -fsSL ${method.script} | sh`
      : `wget -qO- ${method.script} | sh`;
  }
  const key = `${process.platform}-${process.arch}`;
  const spec = method.binary[key];
  if (!spec) return 'binary download';
  const binDir = resolveBinDir();
  return spec.extract
    ? `curl -fsSL ${spec.url} -o /tmp/agents-cli-bin.tgz && tar -xzf /tmp/agents-cli-bin.tgz -C ${binDir} ${spec.extract}`
    : `curl -fsSL ${spec.url} -o ${path.join(binDir, 'agents-cli-downloaded')}`;
}

/**
 * Execute an install method via spawnSync with argv arrays. Each branch
 * re-validates the relevant field — defense in depth, since callers may
 * construct InstallMethod values without going through parseCliManifest
 * (tests, future programmatic use).
 *
 * For `script`, the download is staged to a temp file and then exec'd as
 * `sh <file>` so we never need a shell pipe (`curl | sh`).
 */
function runInstallMethod(method: InstallMethod, stdio: 'inherit' | ['inherit', 2, 'inherit']): void {
  if ('npm' in method) {
    assertNpmPackage(method.npm);
    const invocation = execFileShellSpec('npm', ['install', '-g', method.npm]);
    const r = spawnSync(invocation.command, invocation.args, { stdio, shell: invocation.shell });
    if (r.status !== 0) {
      throw new Error(`npm install -g ${method.npm} exited with status ${r.status ?? 'unknown'}`);
    }
    return;
  }
  if ('brew' in method) {
    assertBrewFormula(method.brew);
    const r = spawnSync('brew', ['install', method.brew], { stdio });
    if (r.status !== 0) {
      throw new Error(`brew install ${method.brew} exited with status ${r.status ?? 'unknown'}`);
    }
    return;
  }
  if ('script' in method) {
    assertHttpsUrl(method.script);
    const tmp = path.join(os.tmpdir(), `agents-cli-install-${process.pid}-${Date.now()}.sh`);
    try {
      let dl;
      if (hasCommand('curl')) {
        dl = spawnSync('curl', ['-fsSL', method.script, '-o', tmp], { stdio });
      } else if (hasCommand('wget')) {
        dl = spawnSync('wget', ['-q', '-O', tmp, method.script], { stdio });
      } else {
        throw new Error('neither curl nor wget is available on PATH');
      }
      if (dl.status !== 0) {
        throw new Error(`download of install script failed (status ${dl.status ?? 'unknown'})`);
      }
      const r = spawnSync('sh', [tmp], { stdio });
      if (r.status !== 0) {
        throw new Error(`install script exited with status ${r.status ?? 'unknown'}`);
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch {  }
    }
    return;
  }
  if ('binary' in method) {
    const key = `${process.platform}-${process.arch}`;
    const spec = method.binary[key];
    if (!spec) throw new Error(`no binary declared for ${key}`);
    assertHttpsUrl(spec.url);
    const binDir = resolveBinDir();
    if (spec.extract) {
      assertSafePathSegment(spec.extract);
      const tmp = path.join(os.tmpdir(), `agents-cli-bin-${process.pid}-${Date.now()}.tgz`);
      try {
        const dl = spawnSync('curl', ['-fsSL', spec.url, '-o', tmp], { stdio });
        if (dl.status !== 0) {
          throw new Error(`binary download failed (status ${dl.status ?? 'unknown'})`);
        }
        const x = spawnSync('tar', ['-xzf', tmp, '-C', binDir, spec.extract], {
          stdio,
        });
        if (x.status !== 0) {
          throw new Error(`tar extract failed (status ${x.status ?? 'unknown'})`);
        }
      } finally {
        try { fs.unlinkSync(tmp); } catch {  }
      }
    } else {
      const r = spawnSync(
        'curl',
        ['-fsSL', spec.url, '-o', path.join(binDir, 'agents-cli-downloaded')],
        { stdio },
      );
      if (r.status !== 0) {
        throw new Error(`binary download failed (status ${r.status ?? 'unknown'})`);
      }
    }
    return;
  }
}

/**
 * Install a single CLI by running its first compatible method. Streams the
 * underlying command's output to the parent terminal so users see brew/npm
 * progress live. Verifies success by re-running `check`.
 */
export function installCli(
  manifest: CliManifest,
  opts: { dryRun?: boolean; logToStderr?: boolean } = {},
): InstallResult {
  const method = selectInstallMethod(manifest);
  if (!method) {
    return {
      manifest,
      method: null,
      installed: false,
      error: `No compatible install method for this host (${process.platform}-${process.arch}). Declared methods: ${manifest.install.map(describeMethod).join('; ')}`,
    };
  }

  if (opts.dryRun) {
    return { manifest, method, installed: false, output: `[dry-run] would run: ${describeMethod(method)}` };
  }

  try {
    runInstallMethod(method, opts.logToStderr ? ['inherit', 2, 'inherit'] : 'inherit');
  } catch (err) {
    return {
      manifest,
      method,
      installed: false,
      error: `install command failed: ${(err as Error).message}`,
    };
  }

  // Re-check; many installers exit 0 but leave the binary off PATH for the
  // current shell (e.g. brew on a fresh install). Trust `check`, not the
  // installer's exit code.
  cmdExistsCache.delete(manifest.name);
  const installed = isCliInstalled(manifest);
  return { manifest, method, installed };
}


const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;
const FIRST_SEMVER = /\d+\.\d+\.\d+/;

export function npmPin(manifest: CliManifest): { pkg: string; version: string } | null {
  const method = manifest.install.find((m): m is { npm: string } => 'npm' in m);
  if (!method) return null;
  const at = method.npm.lastIndexOf('@');
  if (at <= 0) return null;
  const version = method.npm.slice(at + 1);
  return EXACT_SEMVER.test(version) ? { pkg: method.npm.slice(0, at), version } : null;
}

export async function installedCliVersion(manifest: CliManifest): Promise<string | null> {
  const c = manifest.check;
  if (c.kind !== 'version') return null;
  try {
    const { stdout } = await probeCapture(c.cmd, c.args, 10_000);
    return FIRST_SEMVER.exec(stdout)?.[0] ?? null;
  } catch {
    return null;
  }
}

function resolveOnPath(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
    }
  }
  return null;
}

export function owningNpmPrefix(cmd: string, pkg: string): string | null {
  const real = resolveOnPath(cmd);
  if (!real) return null;
  const marker = `${path.sep}lib${path.sep}node_modules${path.sep}${pkg.split('/').join(path.sep)}${path.sep}`;
  const idx = real.indexOf(marker);
  return idx > 0 ? real.slice(0, idx) : null;
}

export type CliUpgradeResult =
  | { name: string; status: 'current'; version: string }
  | { name: string; status: 'upgraded'; from: string; to: string }
  | { name: string; status: 'skipped' | 'failed'; reason: string };

export const UPGRADE_TIMEOUT_MS = 5 * 60_000;

function runNpmInstall(prefix: string, spec: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'npm',
      ['install', '-g', '--prefix', prefix, spec],
      { timeout: UPGRADE_TIMEOUT_MS, signal, maxBuffer: 16 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`npm install -g --prefix ${prefix} ${spec} failed: ${String(stderr).trim().split('\n').pop() ?? err.message}`));
        else resolve();
      },
    );
  });
}

export async function upgradeCliToPin(
  manifest: CliManifest,
  opts: { signal?: AbortSignal; deadlineAt?: number } = {},
): Promise<CliUpgradeResult> {
  const { signal, deadlineAt } = opts;
  const name = manifest.name;
  const pin = npmPin(manifest);
  if (!pin) return { name, status: 'skipped', reason: 'no exact npm pin' };
  if (manifest.check.kind !== 'version') return { name, status: 'skipped', reason: 'check reports no version' };
  const from = await installedCliVersion(manifest);
  if (!from) return { name, status: 'skipped', reason: 'not installed or reports no version' };
  if (compareVersions(from, pin.version) >= 0) return { name, status: 'current', version: from };
  if (process.platform === 'win32') return { name, status: 'skipped', reason: `outdated (${from} < ${pin.version}); unattended upgrade is POSIX-only` };
  const prefix = owningNpmPrefix(manifest.check.cmd, pin.pkg);
  if (!prefix) {
    return { name, status: 'skipped', reason: `outdated (${from} < ${pin.version}) but ${manifest.check.cmd} on PATH is not an npm install of ${pin.pkg}` };
  }
  if (deadlineAt !== undefined && Date.now() + UPGRADE_TIMEOUT_MS > deadlineAt) {
    return { name, status: 'skipped', reason: `outdated (${from} < ${pin.version}); deferred, not enough time left in this tick` };
  }
  try {
    await runNpmInstall(prefix, `${pin.pkg}@${pin.version}`, signal);
  } catch (err) {
    return { name, status: 'failed', reason: (err as Error).message };
  }
  const to = await installedCliVersion(manifest);
  if (to !== pin.version) {
    return { name, status: 'failed', reason: `installed ${pin.pkg}@${pin.version} into ${prefix} but ${manifest.check.cmd} still reports ${to ?? 'no version'}` };
  }
  return { name, status: 'upgraded', from, to };
}

export async function upgradeOutdatedClis(
  opts: { signal?: AbortSignal; deadlineAt?: number; cwd?: string } = {},
): Promise<CliUpgradeResult[]> {
  const { manifests } = listCliManifests(opts.cwd);
  const results: CliUpgradeResult[] = [];
  for (const manifest of manifests) {
    if (opts.signal?.aborted) break;
    if (manifest.source === 'project') continue;
    results.push(await upgradeCliToPin(manifest, opts));
  }
  return results;
}

// ─── Status snapshot ─────────────────────────────────────────────────────────

interface CliStatus {
  manifest: CliManifest;
  installed: boolean;
}

/** Convenience: list all manifests + their installed-on-host status. */
export function listCliStatus(cwd?: string): {
  statuses: CliStatus[];
  errors: CliManifestError[];
} {
  const { manifests, errors } = listCliManifests(cwd);
  const statuses = manifests.map((manifest) => ({
    manifest,
    installed: isCliInstalled(manifest),
  }));
  return { statuses, errors };
}

export async function listCliStatusAsync(cwd?: string): Promise<{
  statuses: CliStatus[];
  errors: CliManifestError[];
}> {
  const { manifests, errors } = listCliManifests(cwd);
  const statuses = await Promise.all(
    manifests.map(async (manifest) => ({
      manifest,
      installed: await isCliInstalledAsync(manifest),
    })),
  );
  return { statuses, errors };
}
