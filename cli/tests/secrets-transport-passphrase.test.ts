/** End-to-end: `export --to-file` / `import --from-file` read the TRANSPORT passphrase
 * (`AGENTS_SYNC_PASSPHRASE`), not the store's master key (RUSH-1968). Drives the real CLI under a
 * temp HOME, round-tripping a bundle through an encrypted file. */
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

// win32: export/import envelope + file-store decrypt path is POSIX-process oriented (RUSH-2215).
const describeSecrets = process.platform === 'win32' ? describe.skip : describe;


const SYNC_ENV = 'AGENTS_SYNC_PASSPHRASE';
const LEGACY_ENV = 'AGENTS_SECRETS_PASSPHRASE';
/** Not a real credential — a literal used only to key a throwaway temp bundle. */
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

/** Drive the real CLI. `env` REPLACES both passphrase vars so a value leaking
 *  in from the developer's own shell can never make a negative case pass. */
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

/** Seed a file-backed bundle headlessly. `storeEnv` keys the store: `{}` for the default
 * machine-local key, or `{ AGENTS_SECRETS_PASSPHRASE }` to model a pre-upgrade box; the legacy
 * variable is the store key, a coupling this split removes. */
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
    // Sealed, not plaintext: the value must not be readable in the file.
    expect(fs.readFileSync(sealed, 'utf-8')).not.toContain('demo-value-123');

    const imported = runCli(
      home,
      ['secrets', 'import', 'dst-bundle', '--from-file', sealed, '--backend', 'file'],
      { [SYNC_ENV]: TRANSPORT_PASS },
    );
    expect(imported.stderr + imported.stdout).toContain('Imported 1 key');
  });

  // The passphrase env-var name in the errors is no longer agents-cli's to assert: PHNX-3989 made
  // export/import `--to-file` a passthrough and the standalone names its own `SECRETS_PASSPHRASE`.
  // The round-trip cases still prove the flags are forwarded and the file is sealed.

  it('a file sealed on a LEGACY box opens on an upgraded box using the NEW variable', () => {
    // Same secret, two spellings, two machines: the upgrade must not strand a
    // file sealed by the other side of the version boundary. Two temp HOMEs,
    // because each box keys its own store differently.
    const sender = makeTempHome();
    const receiver = makeTempHome();
    seedBundle(sender, 'src-bundle', 'DEMO_TOKEN', 'demo-value-123', { [LEGACY_ENV]: TRANSPORT_PASS });
    const sealed = path.join(sender, 'bundle.enc');

    const exported = runCli(sender, ['secrets', 'export', 'src-bundle', '--to-file', sealed], {
      [LEGACY_ENV]: TRANSPORT_PASS,
    });
    expect(exported.stderr + exported.stdout).toContain('Exported');

    // The receiver never holds the sender's master key — only the transport one.
    const imported = runCli(
      receiver,
      ['secrets', 'import', 'dst-bundle', '--from-file', sealed, '--backend', 'file'],
      { [SYNC_ENV]: TRANSPORT_PASS },
    );
    expect(imported.stderr + imported.stdout).toContain('Imported 1 key');
  });
});
