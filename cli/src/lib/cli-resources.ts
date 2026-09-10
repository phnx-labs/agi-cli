/**
 * CLI tool resources — declarative manifests for command-line binaries the user
 * wants installed on the host (e.g. higgsfield, gh, glab).
 *
 * A CLI resource is a YAML file under <repo>/cli/<name>.yaml. Resolution follows
 * the same project > user > system > extra-repo precedence as other resources,
 * but unlike skills/commands/hooks, CLI resources are NOT copied into per-agent
 * version homes — they install binaries onto the host PATH. The relationship is
 * "Brewfile-style": declare once in ~/.agents/cli/, install on any new machine.
 *
 * Security: every field that becomes a child-process argument is validated
 * against a strict allowlist and dispatched via spawnSync with an argv array.
 * Nothing here ever runs through a shell — manifests can come from project repos
 * or pulled extras, so anything that would let a manifest author smuggle in
 * `;`, `$(...)`, backticks, redirects, or pipe operators is a remote-code-
 * execution sink.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync, execFile } from 'child_process';
import * as yaml from 'yaml';
import { listResources, resolveResource } from './resources.js';
import { probeCapture } from './probe.js';
import { composeWin32CommandLine } from './platform/index.js';
import { localBinDir } from './platform/posixpath.js';
import { isSecretsPresent, SECRETS_CLI_NAME, SECRETS_CLI_SPEC } from './secrets-cli.js';

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

// ─── Schema ──────────────────────────────────────────────────────────────────

/** A single install method. Exactly one of the keys (npm/brew/script/binary) is set. */
export type InstallMethod =
  | { npm: string }
  | { brew: string }
  | { script: string }
  | { binary: BinarySpec };

/** Per-platform binary download spec. Keys are `<os>-<arch>` (e.g. darwin-arm64). */
export interface BinarySpec {
  [platform: string]: {
    url: string;
    /** Path inside the archive (relative). Required when url is a .tar.gz/.zip. */
    extract?: string;
  };
}

/**
 * How to verify a CLI is installed. Structured so we can dispatch to spawnSync
 * with an argv array — never through a shell.
 *
 * `which` — just check PATH for `cmd`.
 * `version` — spawn `cmd` with `args` and require exit 0.
 */
export type CheckSpec =
  | { kind: 'which'; cmd: string }
  | { kind: 'version'; cmd: string; args: string[] };

/** Parsed CLI manifest. */
export interface CliManifest {
  /** Name as it appears on the command line (e.g. "higgsfield"). */
  name: string;
  /** One-line summary shown in `agents cli list`. */
  description?: string;
  /** Project homepage; used in detail view + post-install messaging. */
  homepage?: string;
  /** Structured check spec; never a raw shell command. */
  check: CheckSpec;
  /** Install methods tried in order; first one whose tool is available is used. */
  install: InstallMethod[];
  /** Message printed after successful install — typically auth instructions. */
  postInstall?: string;
  /** Origin layer this manifest was resolved from. */
  source: string;
  /** Absolute path to the yaml file. */
  path: string;
}

/** A validation problem in a CLI manifest. */
export interface CliManifestError {
  /** Filename that failed to parse. */
  file: string;
  /** Human-readable reason. */
  reason: string;
}

/**
 * Fallback host-CLI manifest used when no `clis/secrets.yaml` is declared.
 * Lives here (not in secrets-cli.ts) so the process client can import the pin
 * without loading this parser.
 */
export function builtinSecretsCliManifest(): CliManifest {
  return {
    name: SECRETS_CLI_NAME,
    description: 'Standalone secrets CLI — keychain-backed bundles for agents-cli',
    homepage: 'https://github.com/phnx-labs/secrets-cli',
    check: { kind: 'which', cmd: SECRETS_CLI_NAME },
    install: [{ npm: SECRETS_CLI_SPEC }],
    postInstall: [
      'Then onboard existing stores:',
      '  agents setup secrets',
      '  agents secrets list',
    ].join('\n'),
    source: 'builtin',
    path: '(builtin)',
  };
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse a `check:` field into a CheckSpec. Accepts either a structured object
 * (`{ kind: 'which'|'version', cmd, args? }`) or a legacy whitespace-separated
 * string. String form is split on whitespace and each token is validated against
 * SAFE_CHECK_TOKEN — manifests cannot smuggle in shell metacharacters.
 */
export function parseCheckSpec(raw: unknown, defaultName: string): CheckSpec {
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

/**
 * Parse a single CLI manifest from its YAML contents.
 * Returns a manifest on success; throws on schema violations so callers can
 * decide whether to surface or swallow the error per file.
 */
export function parseCliManifest(
  contents: string,
  opts: { name: string; source: string; path: string },
): CliManifest {
  // Tolerant parse. A manifest may legitimately carry OS-specific strings — a
  // Windows path like `C:\Users\...` embedded in a double-quoted YAML scalar
  // trips YAML's escape rules (`\U` is an invalid escape) and makes the strict
  // `yaml.parse` throw a parser error. That throw must NOT pre-empt the
  // security validation below: the per-field allowlist checks (unsafe tokens,
  // non-https URLs, path traversal) are the authoritative gate on a hostile
  // manifest. parseDocument collects those escape errors instead of throwing
  // and still recovers the scalar values, so the dangerous content reaches
  // assertSafeCheckToken / assertNpmPackage and is rejected on its merits.
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

/**
 * Discover all CLI manifests resolvable from the current cwd. Returns valid
 * manifests and any parse errors separately so the CLI can show both.
 */
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

  // agents-cli cannot run without the standalone `secrets` CLI. When no
  // clis/secrets.yaml is declared yet, still expose the pinned npm method so
  // `agents clis install secrets`, doctor, and setup share one path.
  if (!manifests.some((m) => m.name === SECRETS_CLI_NAME)) {
    manifests.push(builtinSecretsCliManifest());
  }

  return { manifests, errors };
}

/** Resolve a single CLI manifest by name. Returns null when not declared. */
export function resolveCliManifest(name: string, cwd?: string): CliManifest | null {
  const resolved = resolveResource('clis', name, cwd);
  if (resolved && (resolved.path.endsWith('.yaml') || resolved.path.endsWith('.yml'))) {
    const contents = fs.readFileSync(resolved.path, 'utf-8');
    return parseCliManifest(contents, {
      name: resolved.name,
      source: resolved.source,
      path: resolved.path,
    });
  }
  if (name === SECRETS_CLI_NAME) return builtinSecretsCliManifest();
  return null;
}

// ─── Host detection ──────────────────────────────────────────────────────────

/**
 * Return true if a command resolves on the current PATH. Uses POSIX `command -v`
 * (or `where` on Windows) via spawn argv (no shell); results are cached for the
 * lifetime of the process.
 */
const cmdExistsCache = new Map<string, boolean>();
export function hasCommand(cmd: string): boolean {
  if (cmdExistsCache.has(cmd)) return cmdExistsCache.get(cmd)!;
  let ok: boolean;
  if (process.platform === 'win32') {
    // `sh` only exists when Git Bash is installed; `where` is the native PATH
    // probe (resolves .exe/.cmd/.bat via PATHEXT). Argv keeps `cmd` uninterpolated.
    ok = spawnSync('where', [cmd], { stdio: 'ignore' }).status === 0;
  } else {
    // `command` is a shell builtin on most POSIX shells; invoking `sh -c 'command -v X'`
    // with X as an *argument* (not interpolated) is the safe path. `cmd` may be passed
    // by callers that haven't validated it, so we route via argv to neutralize metas.
    ok = spawnSync('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', '_', cmd], {
      stdio: 'ignore',
    }).status === 0;
  }
  cmdExistsCache.set(cmd, ok);
  return ok;
}

/**
 * Run the manifest's check. Dispatches on CheckSpec.kind — never invokes a
 * shell, never interpolates strings into a command line.
 */
export function isCliInstalled(manifest: CliManifest): boolean {
  // `secrets` must never be resolved via `command -v` / a PATH spawn: the
  // leftover `~/.agents/.cache/shims/secrets` alias execs `agents secrets`
  // and sits first on PATH (agi-cli#3532). findInPath skips that dir.
  if (manifest.name === SECRETS_CLI_NAME || manifest.check.cmd === SECRETS_CLI_NAME) {
    return isSecretsPresent();
  }
  const c = manifest.check;
  if (c.kind === 'which') {
    cmdExistsCache.delete(c.cmd);
    return hasCommand(c.cmd);
  }
  const result = spawnSync(c.cmd, c.args, { stdio: 'ignore', timeout: 10_000 });
  if (result.status === 0) return true;
  // On Windows the PATH entry point is often a `.cmd`/`.bat` shim (npm installs,
  // script installers), which Node refuses to spawn without a shell (ENOENT /
  // EINVAL). A failed *spawn* — not a failed run — gets one retry through the
  // shell, as a single pre-composed line (DEP0190-safe). Check tokens are
  // SAFE_CHECK_TOKEN-validated at parse time, so the line cannot inject.
  if (process.platform === 'win32' && result.error) {
    const line = composeWin32CommandLine(c.cmd, c.args);
    const retry = spawnSync(line, { stdio: 'ignore', timeout: 10_000, shell: true });
    return retry.status === 0;
  }
  return false;
}

/**
 * Async, non-blocking sibling of {@link isCliInstalled}. Same dispatch and
 * Windows-shim retry, but over `execFile` so many manifests can be checked
 * concurrently — the fix for RUSH-2136, where `agents doctor --json` ran a dozen+
 * blocking 10s-timeout `spawnSync` checks SERIALLY (measured ~136s on an idle
 * box). `execFile`'s `timeout` still SIGKILLs a wedged check, so a single
 * hanging probe can't stall the whole set past 10s.
 */
export function isCliInstalledAsync(manifest: CliManifest): Promise<boolean> {
  if (manifest.name === SECRETS_CLI_NAME || manifest.check.cmd === SECRETS_CLI_NAME) {
    return Promise.resolve(isSecretsPresent());
  }
  const c = manifest.check;
  if (c.kind === 'which') {
    cmdExistsCache.delete(c.cmd);
    return Promise.resolve(hasCommand(c.cmd));
  }
  // probeCapture, not bare execFile: a checked CLI can fork children of its
  // own (copilot's platform-binary downloader), and settling without reaping
  // the probe's process group would orphan them mid-write (RUSH-3028).
  return probeCapture(c.cmd, c.args, 10_000).then(
    () => true,
    (err) => {
      // A spawn failure (as opposed to a non-zero exit) surfaces as a string
      // errno code (ENOENT/EINVAL) on the rejection; a non-zero exit or
      // timeout carries no errno. On Windows a `.cmd`/`.bat` shim spawn-fails
      // without a shell — retry once through the shell, exactly as the sync
      // path does.
      const spawnFailed = typeof (err as NodeJS.ErrnoException).code === 'string';
      if (process.platform === 'win32' && spawnFailed) {
        const line = composeWin32CommandLine(c.cmd, c.args);
        return new Promise<boolean>((resolve) => {
          execFile(line, { timeout: 10_000, shell: true }, (retryErr) => resolve(!retryErr));
        });
      }
      return false;
    },
  );
}

// ─── Method selection ────────────────────────────────────────────────────────

/**
 * Pick the first install method whose required host tool is available.
 * Returns null when none of the declared methods can run on this host.
 */
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

/** Render a CheckSpec back to a human-readable command string (display only). */
export function describeCheck(check: CheckSpec): string {
  return check.kind === 'which' ? check.cmd : `${check.cmd} ${check.args.join(' ')}`.trim();
}

/** Short description of a method for display. */
export function describeMethod(method: InstallMethod): string {
  if ('npm' in method) return `npm install -g ${method.npm}`;
  if ('brew' in method) return `brew install ${method.brew}`;
  if ('script' in method) return `curl ${method.script} | sh`;
  const key = `${process.platform}-${process.arch}`;
  const spec = method.binary[key];
  return spec ? `download ${spec.url}` : 'binary download';
}

// ─── Install ─────────────────────────────────────────────────────────────────

export interface InstallResult {
  manifest: CliManifest;
  /** Method that was attempted (null if no compatible method existed). */
  method: InstallMethod | null;
  /** True when the post-install `check` passed. */
  installed: boolean;
  /** stdout/stderr captured from the install command, for surfacing on failure. */
  output?: string;
  /** Set when the install runner threw or exited non-zero. */
  error?: string;
}

/** Env var that overrides where `binary` installs write their downloaded file(s). */
const BIN_DIR_ENV = 'AGENTS_CLI_BIN_DIR';

/** Historical default install dir — kept only as a last-resort fallback. */
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

/**
 * Resolve the directory a `binary` install method downloads/extracts into.
 *
 * `/usr/local/bin` used to be hardcoded here, which fails on Apple Silicon
 * Macs where that directory is root-owned and not user-writable (Homebrew
 * moved on to /opt/homebrew but left /usr/local/bin behind). Resolution
 * order:
 *  1. `AGENTS_CLI_BIN_DIR` — explicit override, used as-is when set.
 *  2. `~/.local/bin` — the XDG user-bin dir already used for shims (see
 *     posixpath.ts / shims.ts); created with mkdir -p if missing.
 *  3. `/usr/local/bin` — last resort, for hosts where it's still writable.
 *     When it isn't either, throw an actionable error naming the env var and
 *     ~/.local/bin instead of letting curl/tar fail with a bare EACCES.
 *
 * Called once per install/dry-run so the same directory is used everywhere
 * that method is described or executed.
 */
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

/**
 * Display-only rendering of how a method would be run, for `--dry-run` and
 * status output. Not used by installCli — execution goes through runInstallMethod
 * which dispatches to spawnSync with argv arrays.
 */
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
function runInstallMethod(method: InstallMethod): void {
  if ('npm' in method) {
    assertNpmPackage(method.npm);
    const r = spawnSync('npm', ['install', '-g', method.npm], { stdio: 'inherit' });
    if (r.status !== 0) {
      throw new Error(`npm install -g ${method.npm} exited with status ${r.status ?? 'unknown'}`);
    }
    return;
  }
  if ('brew' in method) {
    assertBrewFormula(method.brew);
    const r = spawnSync('brew', ['install', method.brew], { stdio: 'inherit' });
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
        dl = spawnSync('curl', ['-fsSL', method.script, '-o', tmp], { stdio: 'inherit' });
      } else if (hasCommand('wget')) {
        dl = spawnSync('wget', ['-q', '-O', tmp, method.script], { stdio: 'inherit' });
      } else {
        throw new Error('neither curl nor wget is available on PATH');
      }
      if (dl.status !== 0) {
        throw new Error(`download of install script failed (status ${dl.status ?? 'unknown'})`);
      }
      const r = spawnSync('sh', [tmp], { stdio: 'inherit' });
      if (r.status !== 0) {
        throw new Error(`install script exited with status ${r.status ?? 'unknown'}`);
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
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
        const dl = spawnSync('curl', ['-fsSL', spec.url, '-o', tmp], { stdio: 'inherit' });
        if (dl.status !== 0) {
          throw new Error(`binary download failed (status ${dl.status ?? 'unknown'})`);
        }
        const x = spawnSync('tar', ['-xzf', tmp, '-C', binDir, spec.extract], {
          stdio: 'inherit',
        });
        if (x.status !== 0) {
          throw new Error(`tar extract failed (status ${x.status ?? 'unknown'})`);
        }
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      }
    } else {
      const r = spawnSync(
        'curl',
        ['-fsSL', spec.url, '-o', path.join(binDir, 'agents-cli-downloaded')],
        { stdio: 'inherit' },
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
  opts: { dryRun?: boolean } = {},
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
    runInstallMethod(method);
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

// ─── Status snapshot ─────────────────────────────────────────────────────────

export interface CliStatus {
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

/**
 * Async sibling of {@link listCliStatus} that probes every manifest CONCURRENTLY
 * (RUSH-2136). The sync version runs each blocking `spawnSync` check one after
 * another, so a dozen host CLIs whose checks are slow serialize into a
 * multi-minute stall on `agents doctor --json`. This awaits them in parallel, so
 * total wall time is the slowest single check (bounded at 10s), not their sum.
 */
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
