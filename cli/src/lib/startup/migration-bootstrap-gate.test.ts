import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(HERE, '../../..');
const INDEX = path.join(CLI_ROOT, 'src/index.ts');

let scratch: string;

afterEach(() => {
  if (scratch && fs.existsSync(scratch)) {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

function writeLoader(dir: string): { loader: string; log: string } {
  const log = path.join(dir, 'loads.log');
  const hooks = path.join(dir, 'load-hooks.mjs');
  const register = path.join(dir, 'register-loader.mjs');
  fs.writeFileSync(
    hooks,
    `import fs from 'node:fs';
const logPath = process.env.AGENTS_LOAD_LOG;
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (logPath && result?.url) {
    try { fs.appendFileSync(logPath, result.url + '\\n'); } catch { /* ignore */ }
  }
  return result;
}
`,
  );
  const hooksUrl = pathToFileURL(hooks).href;
  const parentUrl = pathToFileURL(dir + path.sep).href;
  fs.writeFileSync(
    register,
    `import { register } from 'node:module';
register(${JSON.stringify(hooksUrl)}, ${JSON.stringify(parentUrl)});
`,
  );
  return { loader: register, log };
}

function runCli(args: string[], env: NodeJS.ProcessEnv, loader: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(loader).href, '--import', 'tsx', INDEX, ...args],
    {
      cwd: CLI_ROOT,
      env,
      encoding: 'utf-8',
      timeout: 60_000,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}


function loadedMigrateStrict(logPath: string): { migrate: boolean; fold: boolean; raw: string } {
  const raw = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
  const lines = raw.split('\n').filter(Boolean);
  let migrate = false;
  let fold = false;
  for (const line of lines) {
    if (/\/migrate-fold\.(ts|js)/.test(line)) fold = true;
    else if (/\/installations\/migrate\.(ts|js)(\?|#|$)/.test(line)) migrate = true;
  }
  return { migrate, fold, raw };
}

describe('migration bootstrap gate (RUSH-2454)', () => {
  it('agents --version does not resolve migrate.ts/js', () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-gate-version-'));
    const { loader, log } = writeLoader(scratch);
    const home = path.join(scratch, 'home');
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents: {}\n');
    fs.mkdirSync(path.join(home, '.agents-system', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents-system', 'hooks', 'x.sh'), 'x');

    const result = runCli(['--version'], {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENTS_SKIP_MIGRATION: '0',
      AGENTS_NO_AUTOPULL: '1',
      AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
      AGENTS_LOAD_LOG: log,
      NODE_NO_WARNINGS: '1',
    }, loader);

    expect(result.status).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);

    const loads = loadedMigrateStrict(log);
    expect(loads.migrate, `migrate.js must not load on --version; log:\n${loads.raw.slice(0, 2000)}`).toBe(false);
    expect(loads.fold, `migrate-fold.js must not load on --version; log:\n${loads.raw.slice(0, 2000)}`).toBe(false);
    expect(fs.lstatSync(path.join(home, '.agents-system')).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(home, '.agents', '.system'))).toBe(false);
  });

  it('agents --help does not resolve migrate.ts/js', () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-gate-help-'));
    const { loader, log } = writeLoader(scratch);
    const home = path.join(scratch, 'home');
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents: {}\n');
    fs.mkdirSync(path.join(home, '.agents-system'), { recursive: true });

    const result = runCli(['--help'], {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENTS_SKIP_MIGRATION: '0',
      AGENTS_NO_AUTOPULL: '1',
      AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
      AGENTS_LOAD_LOG: log,
      NODE_NO_WARNINGS: '1',
    }, loader);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    const loads = loadedMigrateStrict(log);
    expect(loads.migrate).toBe(false);
    expect(loads.fold).toBe(false);
  });

  it('a real command with a missing v19 sentinel loads migrate.js and folds legacy', () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-gate-real-'));
    const { loader, log } = writeLoader(scratch);
    const home = path.join(scratch, 'home');
    fs.mkdirSync(path.join(home, '.agents', '.system'), { recursive: true });
    fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents: {}\n');
    const legacy = path.join(home, '.agents-system');
    fs.mkdirSync(path.join(legacy, 'extra'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'extra', 'f.txt'), '1');

    const result = runCli(['doctor', '--json'], {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENTS_SKIP_MIGRATION: '0',
      AGENTS_NO_AUTOPULL: '1',
      AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
      AGENTS_LOAD_LOG: log,
      NODE_NO_WARNINGS: '1',
    }, loader);

    const loads = loadedMigrateStrict(log);
    expect(
      loads.migrate || loads.fold,
      `expected migrate or fold to load on real command; status=${result.status} stderr=${result.stderr.slice(0, 500)}\nlog:\n${loads.raw.slice(0, 2000)}`,
    ).toBe(true);
    expect(loads.migrate, `migrate.js must load when sentinel missing; log:\n${loads.raw.slice(0, 2000)}`).toBe(true);
  });
});
