import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_SH = path.resolve(__dirname, 'test.sh');

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [TEST_SH, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

// RUSH-3178: the ~13k-test suite must never quietly land on the machine someone is using. Offload
// is the default, local is opt-in, and an unavailable offload target fails instead of falling
// back.
describe('scripts/test.sh — the suite never runs locally by accident', () => {
  it('refuses an unusable --device instead of falling back to local', () => {
    // A name not in the registry now fails at the registry lookup before any ssh, since the
    // address comes from the registry. The invariant pinned: an unusable target aborts and never
    // silently becomes a local run.
    const r = run(['--device', 'no-such-box-xyz.invalid']);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/running the full suite on THIS machine/i);
  });

  it('fails loud and names --device when the default auto-pick cannot run', () => {
    // A missing prerequisite must fail rather than silently run locally. The
    // default mode is `auto`, so the first prerequisite is the CLI that does the
    // picking; with an empty PATH there is nothing to pick with.
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'testsh-nopath-'));
    const r = run([], { PATH: `${emptyBin}:/usr/bin:/bin` });
    fs.rmSync(emptyBin, { recursive: true, force: true });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not on PATH/);
    // It must hand the operator the actionable alternatives, not just die.
    expect(r.stderr).toMatch(/--device/);
    expect(r.stderr).toMatch(/--here/);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/running the full suite on THIS machine/i);
  });

  it('fails loud when --crabbox is asked for and crabbox is missing', () => {
    // crabbox is now an explicit choice, so its absence is only an error when
    // the operator actually asked for it — and the message must say to drop the
    // flag rather than leave them guessing.
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'testsh-nocrab-'));
    const r = run(['--crabbox'], { PATH: `${emptyBin}:/usr/bin:/bin` });
    fs.rmSync(emptyBin, { recursive: true, force: true });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/crabbox is not installed/);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/running the full suite on THIS machine/i);
  });

  it('forwards vitest args through the crabbox path (RUSH-3015 mitigation)', () => {
    // Regression guard: the crabbox branch ignored VITEST_ARGS, so the producer's `-- --retry=2
    // --maxWorkers=2` was silently dropped on every ordinary run. A dropped argument is invisible
    // at runtime, so it needs a test.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testsh-forward-'));
    const scripts = path.join(dir, 'cli', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.copyFileSync(TEST_SH, path.join(scripts, 'test.sh'));

    // Stand-in sandbox.sh records exactly what the offload branch handed it.
    const record = path.join(dir, 'got.txt');
    fs.writeFileSync(
      path.join(scripts, 'sandbox.sh'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > ${JSON.stringify(record)}\n`,
    );
    fs.chmodSync(path.join(scripts, 'sandbox.sh'), 0o755);

    // A fake `crabbox` so the branch gets past its installed-check.
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

  // Sharding (RUSH-3230): the suite is 3079s of CPU at 11.5x parallelism on one box, so wall ==
  // CPU/workers (269s) and it is throughput-bound. Adding boxes divides the CPU; splitting files
  // only moved 296s -> 269s. These pin the routing, not the arithmetic.

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
    // `devices pick --json` landed in 1.22.49. An older CLI answers with a
    // commander "unknown option" that says nothing about sharding, so the script
    // must name the version AND the fix rather than pass the confusion through.
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
    // And never silently degrades into a local run.
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/running the full suite on THIS machine/i);
  });

  it('does not use `mapfile` — macOS ships bash 3.2, where it does not exist', () => {
    // Caught by running it: `mapfile: command not found` on the interactive Mac (bash 4+ only).
    // Comment lines are exempt, since the script explains why it avoids mapfile and a whole-file
    // match flagged that.
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
    // Names the escape hatch so the next person does not guess.
    expect(r.stderr).toMatch(/-- --oops/);
  });

  it('requires a value for --device (never silently offloads to nowhere)', () => {
    const r = run(['--device']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--device needs a machine name/);
  });

  it('refuses the interactive host by name, and says how to override', () => {
    // The registry marks exactly one device `interactive: true` — the laptop
    // someone is sitting at. Naming it as a --device target is almost always a
    // mistake, and silently honoring it is the bug this script exists to stop.
    const interactive = JSON.parse(
      spawnSync('agents', ['devices', 'list', '--json'], { encoding: 'utf-8' }).stdout || '[]',
    ).find((d: { interactive?: boolean }) => d.interactive)?.name;
    if (!interactive) return; // no interactive host registered on this box

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
  // The auto path (RUSH-3211): a fake `agents` on PATH answers `devices pick` with a name and
  // `devices list --json` with an empty registry, so the run aborts at the address lookup with a
  // message naming the picked device, which proves auto resolved.

  // Every fake answers `devices --help` with a `pick` row; without it the fake looks like a CLI
  // that predates the verb and the version diagnostic fires, making these tests pass for the wrong
  // reason.
  const HELP_STANZA =
    '#!/usr/bin/env bash\n'
    + 'if [ "$2" = "--help" ] || [ "$3" = "--help" ]; then\n'
    + '  echo "  pick   Print the device automatic placement would choose"\n'
    + '  exit 0\n'
    + 'fi\n';

  /** A fake `agents` whose `devices pick` prints `picked`. Returns its bin dir. */
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

    // It got as far as resolving the PICKED device's address — proof the default
    // went through the picker, not through crabbox and not through a local run.
    expect(r.stderr).toMatch(/picked-worker-7/);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/running the full suite on THIS machine/i);
  });

  it('treats `--device auto` as the sentinel, never as a host literally named auto', () => {
    // Dialing a box called "auto" would hang until ConnectTimeout, which reads
    // as a network problem rather than the mistake it is.
    const bin = fakeAgents('picked-worker-7');
    const r = run(['--device', 'auto'], { PATH: `${bin}:${process.env.PATH}` });
    fs.rmSync(bin, { recursive: true, force: true });

    expect(r.stderr).toMatch(/picked-worker-7/);
    expect(r.stderr).not.toMatch(/device 'auto'/);
  });

  it('fails loud, naming --device and --here, when no worker is eligible', () => {
    // The picker exiting non-zero means the fleet has nothing to offer. That must
    // abort with the alternatives spelled out — never degrade into a local run.
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
    // `pick` exiting 0 with nothing on stdout would otherwise rsync to ":" —
    // a confusing failure far from the cause.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testsh-emptypick-'));
    fs.writeFileSync(path.join(dir, 'agents'), `${HELP_STANZA}exit 0\n`);
    fs.chmodSync(path.join(dir, 'agents'), 0o755);
    const r = run([], { PATH: `${dir}:${process.env.PATH}` });
    fs.rmSync(dir, { recursive: true, force: true });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/returned no device/);
  });
});

// Every assertion reproduces a bug from the first --shard revision. They run through `runSealed`,
// which puts only a bash symlink on PATH, so a regressed guard fails fast with "rsync not found"
// instead of hanging or running the whole suite on the CI machine.
describe('scripts/test.sh — the shard flags cannot silently do the wrong thing', () => {
  // Resolve bash rather than hardcoding /bin/bash: the sealed PATH must still contain the
  // interpreter, and a wrong path makes spawnSync fail to launch and surface as `undefined`
  // stderr.
  const BASH = (() => {
    const found = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf-8' }).stdout?.trim();
    if (found && fs.existsSync(found)) return found;
    for (const c of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash']) {
      if (fs.existsSync(c)) return c;
    }
    throw new Error('no bash on this machine — scripts/test.sh cannot be exercised');
  })();

  /** Run test.sh with nothing on PATH but bash, so it can never dispatch. */
  function runSealed(args: string[]) {
    const onlyBash = fs.mkdtempSync(path.join(os.tmpdir(), 'testsh-sealed-'));
    fs.symlinkSync(BASH, path.join(onlyBash, 'bash'));
    try {
      return run(args, { PATH: onlyBash });
    } finally {
      fs.rmSync(onlyBash, { recursive: true, force: true });
    }
  }

  // Regression: `--shard 0` passed the numeric regex, hit no floor, ran zero iterations and
  // printed "All 0 shards passed." with exit 0. A green run that executed no tests is the worst
  // runner failure, so the floor is pinned on both spellings.
  it.each([
    ['--shard', '0'],
    ['--shard', '1'],
    ['--shard=0'],
    ['--shard=1'],
  ])('refuses a shard count below 2 (%s %s)', (...args: string[]) => {
    const r = runSealed(args);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/needs at least 2 workers/);
    // Never a false green, and never a local run.
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/All 0 shards passed/);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/running the full suite on THIS machine/i);
  });

  it('refuses a non-numeric shard count', () => {
    const r = runSealed(['--shard', 'abc']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/needs a worker count/);
  });

  // Regression: `--devices onebox` derived SHARDS from the list length and bypassed the floor
  // because shard_count_ok was only wired into the --shard arms, running a one-shard fan-out with
  // no warning.
  it('applies the same floor when the count comes from --devices', () => {
    const r = runSealed(['--devices', 'onebox']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/needs at least 2 workers/);
    // The message names the flag the caller actually passed.
    expect(r.stderr).toMatch(/--devices/);
  });

  it('refuses a --devices list that parses to nothing', () => {
    const r = runSealed(['--devices', '']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--devices needs a comma-separated list/);
  });

  // Regression: MODE was last-write-wins with no cross-flag validation, so one
  // of the two flags was dropped purely on argument order, silently. Both
  // orders are pinned because argument order was the whole bug.
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
    // Naming BOTH flags is the point: the operator has to know which two
    // disagreed, not just that something did.
    expect(r.stderr).toContain(named as string);
    expect(r.stderr).toContain(other as string);
    // A conflict must never resolve into a local run.
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/running the full suite on THIS machine/i);
  });

  it('still allows --devices together with --shard — same mode, not a conflict', () => {
    // Guards the guard: the legitimate pairing (name the workers and state the count) must not
    // start failing. Run with a PATH lacking rsync so the script dies at the first prerequisite
    // check, proving parsing accepted the combination without dispatching.
    const r = runSealed(['--devices', 'a,b', '--shard', '2']);

    expect(r.stderr).not.toMatch(/conflicts with/);
    // Reached the shard branch — so the flags were accepted together.
    expect(r.stderr).toMatch(/rsync not found/);
  });
});
