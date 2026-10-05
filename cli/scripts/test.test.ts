import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_SH = path.resolve(__dirname, 'test.sh');
const COMMON_SH = path.resolve(__dirname, 'lib/common.sh');

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [TEST_SH, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

describe('scripts/test.sh — the suite never runs locally by accident', () => {
  it('refuses an unusable --device instead of falling back to local', () => {
    const r = run(['--device', 'no-such-box-xyz.invalid']);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/running the full suite on THIS machine/i);
  });

  it('fails loud and names --device when the default auto-pick cannot run', () => {
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'testsh-nopath-'));
    const r = run([], { PATH: `${emptyBin}:/usr/bin:/bin` });
    fs.rmSync(emptyBin, { recursive: true, force: true });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not on PATH/);
    expect(r.stderr).toMatch(/--device/);
    expect(r.stderr).toMatch(/--here/);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/running the full suite on THIS machine/i);
  });

  it('fails loud when --crabbox is asked for and crabbox is missing', () => {
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'testsh-nocrab-'));
    const r = run(['--crabbox'], { PATH: `${emptyBin}:/usr/bin:/bin` });
    fs.rmSync(emptyBin, { recursive: true, force: true });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/crabbox is not installed/);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/running the full suite on THIS machine/i);
  });

  it('forwards vitest args through the crabbox path (RUSH-3015 mitigation)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testsh-forward-'));
    const scripts = path.join(dir, 'cli', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.copyFileSync(TEST_SH, path.join(scripts, 'test.sh'));
    fs.mkdirSync(path.join(scripts, 'lib'));
    fs.copyFileSync(COMMON_SH, path.join(scripts, 'lib/common.sh'));

    const record = path.join(dir, 'got.txt');
    fs.writeFileSync(
      path.join(scripts, 'sandbox.sh'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > ${JSON.stringify(record)}\n`,
    );
    fs.chmodSync(path.join(scripts, 'sandbox.sh'), 0o755);

    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'crabbox'), '#!/usr/bin/env bash\nexit 0\n');
    fs.chmodSync(path.join(bin, 'crabbox'), 0o755);

    const r = spawnSync('bash', [path.join(scripts, 'test.sh'), '--crabbox', '--', '--retry=2', '--maxWorkers=2'], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });

    expect(r.status, r.stdout + r.stderr).toBe(0);
    const got = fs.readFileSync(record, 'utf-8').trim();
    fs.rmSync(dir, { recursive: true, force: true });
    expect(got).toBe('test --retry=2 --maxWorkers=2');
  });


  it('requires a worker count, so `--shard` alone cannot fan out to nowhere', () => {
    const r = run(['--shard']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--shard needs a worker count/);
  });

  it('rejects a non-numeric worker count', () => {
    expect(run(['--shard', 'abc']).status).not.toBe(0);
    expect(run(['--shard=x']).status).not.toBe(0);
  });

  it('names the version requirement when the installed CLI cannot enumerate workers', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'testsh-oldcli-'));
    fs.writeFileSync(
      path.join(bin, 'agents'),
      '#!/usr/bin/env bash\n'
      + 'if [ "$1" = "--version" ]; then echo 1.22.47; exit 0; fi\n'
      + 'exit 1\n',
    );
    fs.chmodSync(path.join(bin, 'agents'), 0o755);
    const r = run(['--shard', '4'], { PATH: `${bin}:${process.env.PATH}` });
    fs.rmSync(bin, { recursive: true, force: true });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/has no 'devices pick --json'/);
    expect(r.stderr).toMatch(/1\.22\.49/);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/running the full suite on THIS machine/i);
  });

  it('does not use `mapfile` — macOS ships bash 3.2, where it does not exist', () => {
    const code = fs.readFileSync(TEST_SH, 'utf-8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/\bmapfile\b/);
  });

  it('rejects an unknown flag rather than forwarding it to vitest', () => {
    const r = run(['--oops']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unexpected argument: --oops/);
    expect(r.stderr).toMatch(/-- --oops/);
  });

  it('requires a value for --device (never silently offloads to nowhere)', () => {
    const r = run(['--device']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--device needs a machine name/);
  });

  it('refuses the interactive host by name, and says how to override', () => {
    const interactive = JSON.parse(
      spawnSync('agents', ['devices', 'list', '--json'], { encoding: 'utf-8' }).stdout || '[]',
    ).find((d: { interactive?: boolean }) => d.interactive)?.name;
    if (!interactive) return;

    const r = run(['--device', interactive]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/is the INTERACTIVE host/);
    expect(r.stderr).toMatch(/--here/);
  });

  it('rejects a device that is not in the registry', () => {
    const r = run(['--device', 'not-a-real-box']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not in the registry/);
  });

  it('rejects a --repo-root that is not a repo checkout', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'testsh-notrepo-'));
    const r = run(['--repo-root', empty, '--device', 'no-such-box-xyz.invalid']);
    fs.rmSync(empty, { recursive: true, force: true });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/has no cli/);
  });

  const HELP_STANZA =
    '#!/usr/bin/env bash\n'
    + 'if [ "$2" = "--help" ] || [ "$3" = "--help" ]; then\n'
    + '  echo "  pick   Print the device automatic placement would choose"\n'
    + '  exit 0\n'
    + 'fi\n';

  function fakeAgents(picked: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testsh-fakeagents-'));
    fs.writeFileSync(
      path.join(dir, 'agents'),
      HELP_STANZA
      + 'if [ "$1" = "devices" ] && [ "$2" = "pick" ]; then\n'
      + `  echo ${JSON.stringify(picked)}\n`
      + '  exit 0\n'
      + 'fi\n'
      + 'if [ "$1" = "devices" ] && [ "$2" = "list" ]; then echo "[]"; exit 0; fi\n'
      + 'exit 0\n',
    );
    fs.chmodSync(path.join(dir, 'agents'), 0o755);
    return dir;
  }

  it('defaults to auto: asks the CLI for a worker instead of running here', () => {
    const bin = fakeAgents('picked-worker-7');
    const r = run([], { PATH: `${bin}:${process.env.PATH}` });
    fs.rmSync(bin, { recursive: true, force: true });

    expect(r.stderr).toMatch(/picked-worker-7/);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/running the full suite on THIS machine/i);
  });

  it('treats `--device auto` as the sentinel, never as a host literally named auto', () => {
    const bin = fakeAgents('picked-worker-7');
    const r = run(['--device', 'auto'], { PATH: `${bin}:${process.env.PATH}` });
    fs.rmSync(bin, { recursive: true, force: true });

    expect(r.stderr).toMatch(/picked-worker-7/);
    expect(r.stderr).not.toMatch(/device 'auto'/);
  });

  it('fails loud, naming --device and --here, when no worker is eligible', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testsh-nopick-'));
    fs.writeFileSync(path.join(dir, 'agents'), `${HELP_STANZA}exit 1\n`);
    fs.chmodSync(path.join(dir, 'agents'), 0o755);
    const r = run([], { PATH: `${dir}:${process.env.PATH}` });
    fs.rmSync(dir, { recursive: true, force: true });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no worker device is available/);
    expect(r.stderr).toMatch(/--device/);
    expect(r.stderr).toMatch(/--here/);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/running the full suite on THIS machine/i);
  });

  it('refuses an empty pick rather than proceeding with no device', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testsh-emptypick-'));
    fs.writeFileSync(path.join(dir, 'agents'), `${HELP_STANZA}exit 0\n`);
    fs.chmodSync(path.join(dir, 'agents'), 0o755);
    const r = run([], { PATH: `${dir}:${process.env.PATH}` });
    fs.rmSync(dir, { recursive: true, force: true });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/returned no device/);
  });
});

describe('scripts/test.sh — the shard flags cannot silently do the wrong thing', () => {
  const BASH = (() => {
    const found = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf-8' }).stdout?.trim();
    if (found && fs.existsSync(found)) return found;
    for (const c of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash']) {
      if (fs.existsSync(c)) return c;
    }
    throw new Error('no bash on this machine — scripts/test.sh cannot be exercised');
  })();

  function runSealed(args: string[]) {
    const onlyBash = fs.mkdtempSync(path.join(os.tmpdir(), 'testsh-sealed-'));
    fs.symlinkSync(BASH, path.join(onlyBash, 'bash'));
    try {
      return run(args, { PATH: onlyBash });
    } finally {
      fs.rmSync(onlyBash, { recursive: true, force: true });
    }
  }

  it.each([
    ['--shard', '0'],
    ['--shard', '1'],
    ['--shard=0'],
    ['--shard=1'],
  ])('refuses a shard count below 2 (%s %s)', (...args: string[]) => {
    const r = runSealed(args);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/needs at least 2 workers/);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/All 0 shards passed/);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/running the full suite on THIS machine/i);
  });

  it('refuses a non-numeric shard count', () => {
    const r = runSealed(['--shard', 'abc']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/needs a worker count/);
  });

  it('applies the same floor when the count comes from --devices', () => {
    const r = runSealed(['--devices', 'onebox']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/needs at least 2 workers/);
    expect(r.stderr).toMatch(/--devices/);
  });

  it('refuses a --devices list that parses to nothing', () => {
    const r = runSealed(['--devices', '']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--devices needs a comma-separated list/);
  });

  it.each([
    [['--shard', '2', '--device', 'box'], '--device', '--shard'],
    [['--device', 'box', '--shard', '2'], '--shard', '--device'],
    [['--shard', '2', '--here'], '--here', '--shard'],
    [['--here', '--shard', '2'], '--shard', '--here'],
    [['--shard', '3', '--crabbox'], '--crabbox', '--shard'],
    [['--crabbox', '--shard', '3'], '--shard', '--crabbox'],
  ])('refuses conflicting target flags (%j)', (args, named, other) => {
    const r = runSealed(args as string[]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/conflicts with/);
    expect(r.stderr).toContain(named as string);
    expect(r.stderr).toContain(other as string);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/running the full suite on THIS machine/i);
  });

  it('still allows --devices together with --shard — same mode, not a conflict', () => {
    const r = runSealed(['--devices', 'a,b', '--shard', '2']);

    expect(r.stderr).not.toMatch(/conflicts with/);
    expect(r.stderr).toMatch(/rsync not found/);
  });
});
