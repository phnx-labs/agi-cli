import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_VERSION = (JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'),
) as { version: string }).version;

const describeSecrets = process.platform === 'win32' ? describe.skip : describe;


const SYNC_ENV = 'AGENTS_SYNC_PASSPHRASE';
const LEGACY_ENV = 'AGENTS_SECRETS_PASSPHRASE';
const TRANSPORT_PASS = 'transport-pass-not-a-real-key';

const tempHomes: string[] = [];

function makeTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-transport-'));
  tempHomes.push(home);
  const systemDir = path.join(home, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: Date.now(), latestVersion: PACKAGE_VERSION }),
  );
  return home;
}

function runCli(home: string, args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = { ...process.env as Record<string, string>, HOME: home, SHELL: '/bin/zsh' };
  delete env[SYNC_ENV];
  delete env[LEGACY_ENV];
  return spawnSync('node', ['--import', 'tsx', 'src/index.ts', ...args], {
    cwd: REPO_ROOT,
    env: { ...env, ...extraEnv },
    encoding: 'utf-8',
  });
}

function seedBundle(
  home: string, bundle: string, key: string, value: string,
  storeEnv: Record<string, string> = {},
): void {
  const dotenv = path.join(home, 'seed.env');
  fs.writeFileSync(dotenv, `${key}=${value}\n`);
  const res = runCli(
    home,
    ['secrets', 'import', bundle, '--from', dotenv, '--backend', 'file', '--all-plaintext'],
    storeEnv,
  );
  expect(res.stderr + res.stdout).toContain('Imported');
}

afterEach(() => {
  while (tempHomes.length) {
    const home = tempHomes.pop()!;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describeSecrets('export --to-file / import --from-file use AGENTS_SYNC_PASSPHRASE (RUSH-1968)', () => {
  it('round-trips a bundle through an encrypted file under the NEW variable', () => {
    const home = makeTempHome();
    seedBundle(home, 'src-bundle', 'DEMO_TOKEN', 'demo-value-123');
    const sealed = path.join(home, 'bundle.enc');

    const exported = runCli(home, ['secrets', 'export', 'src-bundle', '--to-file', sealed], {
      [SYNC_ENV]: TRANSPORT_PASS,
    });
    expect(exported.stderr + exported.stdout).toContain('Exported');
    expect(fs.existsSync(sealed)).toBe(true);
    expect(fs.readFileSync(sealed, 'utf-8')).not.toContain('demo-value-123');

    const imported = runCli(
      home,
      ['secrets', 'import', 'dst-bundle', '--from-file', sealed, '--backend', 'file'],
      { [SYNC_ENV]: TRANSPORT_PASS },
    );
    expect(imported.stderr + imported.stdout).toContain('Imported 1 key');
  });


  it('a file sealed on a LEGACY box opens on an upgraded box using the NEW variable', () => {
    const sender = makeTempHome();
    const receiver = makeTempHome();
    seedBundle(sender, 'src-bundle', 'DEMO_TOKEN', 'demo-value-123', { [LEGACY_ENV]: TRANSPORT_PASS });
    const sealed = path.join(sender, 'bundle.enc');

    const exported = runCli(sender, ['secrets', 'export', 'src-bundle', '--to-file', sealed], {
      [LEGACY_ENV]: TRANSPORT_PASS,
    });
    expect(exported.stderr + exported.stdout).toContain('Exported');

    const imported = runCli(
      receiver,
      ['secrets', 'import', 'dst-bundle', '--from-file', sealed, '--backend', 'file'],
      { [SYNC_ENV]: TRANSPORT_PASS },
    );
    expect(imported.stderr + imported.stdout).toContain('Imported 1 key');
  });
});
