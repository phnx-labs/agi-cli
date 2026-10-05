/** The release mutex, tested against a real git remote with two clones; mutual exclusion is `git
 * push` semantics, so stubbing git would prove nothing. Pins the 2026-08-02 jam: two agents
 * entered release.sh at once and the second found out at the publish gate. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const describeWin = process.platform === 'win32' ? describe.skip : describe;


const SCRIPT = path.resolve(__dirname, 'release-lease.sh');
const REF = 'refs/release-lock/test-held';

let root: string;
let origin: string;
let boxA: string;
let boxB: string;

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function lease(cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, RELEASE_LEASE_REF: REF, ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function leaseAsync(cwd: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    const p = spawn('bash', [SCRIPT, ...args], {
      cwd,
      env: { ...process.env, RELEASE_LEASE_REF: REF, ...env },
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => resolve({ status: status ?? -1, stdout, stderr }));
  });
}

function procState(pid: number): string {
  return spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf-8' }).stdout.trim();
}

const zombieParents: ChildProcess[] = [];

/** A real unreaped zombie: a Python parent forks, lets the child exit, and never wait(2)s. Bash
 * cannot do this portably since macOS Bash reaps background jobs. This is the shape a SIGKILLed
 * release.sh leaves; `ps -p` still lists it. */
function spawnZombie(): number {
  const pidFile = path.join(root, `zombie-${zombieParents.length}.pid`);
  const parent = spawn('python3', ['-c', [
    'import os, sys, time',
    'pid = os.fork()',
    'if pid == 0:',
    '    os._exit(0)',
    'with open(sys.argv[1], "w", encoding="utf-8") as f:',
    '    f.write(str(pid))',
    'time.sleep(60)',
  ].join('\n'), pidFile], { stdio: 'ignore' });
  if (!parent.pid) throw new Error('python3 is required to create the zombie process fixture');
  zombieParents.push(parent);
  for (let i = 0; i < 200; i++) {
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf-8').trim());
      if (pid && procState(pid).startsWith('Z')) return pid;
    }
    spawnSync('sleep', ['0.05']);
  }
  throw new Error('no zombie appeared');
}

function makeBox(name: string) {
  const dir = path.join(root, name);
  git(root, 'clone', '--quiet', origin, dir);
  git(dir, 'config', 'user.email', `${name}@test.local`);
  git(dir, 'config', 'user.name', name);
  return dir;
}

function currentHolder(cwd: string) {
  const m = /holder=(\S+)/.exec(lease(cwd, ['status']).stdout);
  return m?.[1] ?? '';
}

/** Push a lease that is genuinely `ageMin` minutes old by backdating the commit. With `--ttl-min 0`
 * every lease is reclaimable, so reclaim tests would pass for the wrong reason. */
function plantStaleLease(
  cwd: string,
  version: string,
  ageMin: number,
  opts: { force?: boolean; host?: string; pid?: number; started?: string } = {},
) {
  const when = new Date(Date.now() - ageMin * 60_000).toISOString();
  const tree = git(cwd, 'hash-object', '-t', 'tree', '/dev/null');
  const holder = opts.host ? `${opts.host}/pid-${opts.pid ?? 1}` : 'dead-box/pid-1';
  const fields = [`version: ${version}`, `holder: ${holder}`];
  if (opts.host) fields.push(`host: ${opts.host}`);
  if (opts.pid !== undefined) fields.push(`pid: ${opts.pid}`);
  if (opts.started) fields.push(`started: ${opts.started}`);
  fields.push(`claimed: ${when}`);
  const msg = `release lease\n\n${fields.join('\n')}\n`;
  const r = spawnSync('git', ['commit-tree', tree, '-m', msg], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when },
  });
  if (r.status !== 0) throw new Error(`commit-tree failed: ${r.stderr}`);
  const sha = r.stdout.trim();
  git(cwd, 'push', '--quiet', ...(opts.force ? ['--force'] : []), 'origin', `${sha}:${REF}`);
  return sha;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-lease-'));
  origin = path.join(root, 'origin.git');
  git(root, 'init', '--quiet', '--bare', origin);

  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed);
  git(seed, 'init', '--quiet');
  git(seed, 'config', 'user.email', 'seed@test.local');
  git(seed, 'config', 'user.name', 'seed');
  fs.writeFileSync(path.join(seed, 'README.md'), '# seed\n');
  git(seed, 'add', 'README.md');
  git(seed, 'commit', '--quiet', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');

  boxA = makeBox('box-a');
  boxB = makeBox('box-b');
});

afterEach(() => {
  for (const p of zombieParents.splice(0)) p.kill('SIGKILL');
  fs.rmSync(root, { recursive: true, force: true });
});

describeWin('release-lease: mutual exclusion across machines', () => {
  it('guards absent-ref creation and reclaims stale leases with one CAS push', async () => {
    const boxC = makeBox('box-c');
    git(boxA, 'config', 'user.email', 'shared@test.local');
    git(boxA, 'config', 'user.name', 'shared');
    git(boxB, 'config', 'user.email', 'shared@test.local');
    git(boxB, 'config', 'user.name', 'shared');
    // The shared timestamp must be NOW, not a literal: lease age is measured from the committer
    // timestamp, so a fixed past date makes the loser reclaim a stale lease. One value computed
    // once keeps both commits identical except claim-id.
    const fixed = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const env = { GIT_AUTHOR_DATE: fixed, GIT_COMMITTER_DATE: fixed };
    const [a, b] = await Promise.all([
      leaseAsync(boxA, ['claim', '1.20.82'], env),
      leaseAsync(boxB, ['claim', '1.20.82'], env),
    ]);
    expect([a, b].filter((r) => r.status === 0)).toHaveLength(1);

    plantStaleLease(boxA, '1.20.82', 90, { force: true });
    const hooks = path.join(origin, 'hooks');
    fs.writeFileSync(path.join(hooks, 'update'), [
      '#!/usr/bin/env bash',
      '[[ "$3" != "0000000000000000000000000000000000000000" ]]',
      '',
    ].join('\n'));
    fs.chmodSync(path.join(hooks, 'update'), 0o755);
    const reclaimed = lease(boxC, ['claim', '1.20.83', '--ttl-min', '45']);
    expect(reclaimed.status, `${reclaimed.stdout}${reclaimed.stderr}`).toBe(0);
    expect(lease(boxC, ['verify']).status).toBe(0);
  });

  it('lets exactly one of two concurrent claimants win', () => {
    const a = lease(boxA, ['claim', '1.20.82']);
    const b = lease(boxB, ['claim', '1.20.82']);

    expect(a.status).toBe(0);
    expect(b.status).toBe(1);
    expect(b.stderr).toContain('release already in flight');
  });

  it('names the holder and the version in the refusal', () => {
    lease(boxA, ['claim', '1.20.82']);
    const holder = currentHolder(boxA);
    expect(holder).not.toBe('');

    const b = lease(boxB, ['claim', '1.20.83']);

    expect(b.status).toBe(1);
    expect(b.stdout + b.stderr).toContain('version=1.20.82');
    expect(b.stdout + b.stderr).toContain(holder);
  });

  it('frees the lease for the next releaser once released', () => {
    expect(lease(boxA, ['claim', '1.20.82']).status).toBe(0);
    expect(lease(boxB, ['claim', '1.20.82']).status).toBe(1);

    expect(lease(boxA, ['release']).status).toBe(0);
    expect(lease(boxB, ['claim', '1.20.83']).status).toBe(0);
  });
});

describeWin('release-lease: a dead run must not wedge the pipeline', () => {
  it('refuses to reclaim a lease that is younger than the TTL', () => {
    plantStaleLease(boxA, '1.20.82', 10);
    const b = lease(boxB, ['claim', '1.20.82', '--ttl-min', '45']);
    expect(b.status).toBe(1);
    expect(b.stderr).toContain('release already in flight');
  });

  it('reclaims a lease older than the TTL, and says whose it was', () => {
    plantStaleLease(boxA, '1.20.82', 90);
    const b = lease(boxB, ['claim', '1.20.83', '--ttl-min', '45']);

    expect(b.status).toBe(0);
    expect(b.stdout).toContain('reclaiming a stale release lease');
    expect(b.stdout).toContain('dead-box/pid-1');
    expect(b.stdout).toContain('version=1.20.82');

    expect(lease(boxA, ['claim', '1.20.84']).status).toBe(1);
  });

  it('gives one stale lease to exactly one of two simultaneous reclaimers', async () => {
    const boxC = makeBox('box-c');
    plantStaleLease(boxA, '1.20.82', 90);

    const [b, c] = await Promise.all([
      leaseAsync(boxB, ['claim', '1.20.83', '--ttl-min', '45']),
      leaseAsync(boxC, ['claim', '1.20.84', '--ttl-min', '45']),
    ]);

    const winners = [b, c].filter((r) => r.status === 0);
    expect(winners).toHaveLength(1);
  });
});

describeWin('release-lease: releasing what you do not own', () => {
  it('will not drop a lease this box never claimed', () => {
    lease(boxA, ['claim', '1.20.82']);

    const b = lease(boxB, ['release']);
    expect(b.status).toBe(0);
    expect(b.stdout).toContain('no release lease to drop');

    expect(lease(boxB, ['claim', '1.20.83']).status).toBe(1);
  });

  it('will not drop a lease that was reclaimed out from under it', () => {
    lease(boxA, ['claim', '1.20.82']);
    plantStaleLease(boxB, '1.20.83', 0, { force: true });

    const a = lease(boxA, ['release']);
    expect(a.status).toBe(0);
    expect(a.stdout).toContain('no longer ours');

    expect(lease(boxA, ['claim', '1.20.83']).status).toBe(1);
  });

  it('is a no-op when nothing is held', () => {
    const r = lease(boxA, ['release']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no release lease to drop');
  });
});

describeWin('release-lease: a long healthy release must not lose its lease', () => {
  // The TTL is how long since the holder proved it was alive, not how long a release takes: CI
  // alone has run 57 minutes and release 1.20.77 took 186. Without renewal a healthy release would
  // be reclaimed mid-flight and two releasers would run.
  it('renewing keeps a lease that would otherwise be reclaimable', () => {
    lease(boxA, ['claim', '1.20.82']);

    expect(lease(boxA, ['renew']).status).toBe(0);

    const b = lease(boxB, ['claim', '1.20.83', '--ttl-min', '45']);
    expect(b.status).toBe(1);
    expect(b.stderr).toContain('release already in flight');
  });

  it('renew fails loudly once the lease has been reclaimed', () => {
    lease(boxA, ['claim', '1.20.82']);
    plantStaleLease(boxB, '1.20.83', 0, { force: true });

    const a = lease(boxA, ['renew']);
    expect(a.status).toBe(1);
    expect(a.stderr).toContain('no longer ours');
  });

  it('renew does not resurrect a lease that was already dropped', () => {
    lease(boxA, ['claim', '1.20.82']);
    lease(boxA, ['release']);

    expect(lease(boxA, ['renew']).status).toBe(1);
    expect(lease(boxB, ['claim', '1.20.83']).status).toBe(0);
  });
});

describeWin('release-lease: a renew must not orphan our own lease', () => {
  // The race: `renew` pushes sha2 then writes the token, non-atomically, so a `release` in between
  // sees sha1, finds sha2 on origin, and orphans our own lease until TTL. Ownership is membership
  // in the set of shas this run pushed, not equality with the latest.
  it('release still drops a lease that renew rotated', () => {
    lease(boxA, ['claim', '1.20.82']);
    lease(boxA, ['renew']);

    const gitdir = git(boxA, 'rev-parse', '--git-common-dir');
    const histPath = path.resolve(boxA, gitdir, 'release-lease.history');
    const tokPath = path.resolve(boxA, gitdir, 'release-lease.token');
    const history = fs.readFileSync(histPath, 'utf-8').trim().split('\n');
    expect(history.length).toBeGreaterThanOrEqual(2);
    fs.writeFileSync(tokPath, history[0] + '\n');

    const r = lease(boxA, ['release']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('release lease dropped');
    expect(r.stdout).not.toContain('leaving it alone');

    expect(lease(boxB, ['claim', '1.20.83']).status).toBe(0);
  });

  it('a fresh claim does not inherit ownership of a previous lease', () => {
    lease(boxA, ['claim', '1.20.82']);
    lease(boxA, ['release']);
    lease(boxB, ['claim', '1.20.83']);

    const a = lease(boxA, ['verify']);
    expect(a.status).toBe(1);
  });
});

describeWin('release-lease: verify gates the irreversible steps', () => {
  it('passes only while the lease is genuinely ours', () => {
    lease(boxA, ['claim', '1.20.82']);
    expect(lease(boxA, ['verify']).status).toBe(0);
  });

  it('fails once another box has reclaimed it', () => {
    lease(boxA, ['claim', '1.20.82']);
    plantStaleLease(boxB, '1.20.83', 0, { force: true });

    const a = lease(boxA, ['verify']);
    expect(a.status).toBe(1);
    expect(a.stderr).toContain('no longer ours');
  });

  it('fails closed when this checkout never claimed anything', () => {
    expect(lease(boxB, ['verify']).status).toBe(1);
  });

  it('fails closed when the lease vanished from origin', () => {
    lease(boxA, ['claim', '1.20.82']);
    git(boxB, 'push', '--quiet', '--delete', 'origin', REF);

    const a = lease(boxA, ['verify']);
    expect(a.status).toBe(1);
    expect(a.stderr).toContain('gone from origin');
  });
});

describeWin('release-lease: status', () => {
  it('reports unheld, then the holder', () => {
    expect(lease(boxA, ['status']).stdout.trim()).toBe('unheld');

    lease(boxA, ['claim', '1.20.82']);
    const s = lease(boxB, ['status']);
    expect(s.stdout).toContain('held');
    expect(s.stdout).toContain('version=1.20.82');
  });
});

/** RUSH-2274: an externally killed release never reaches its trap, so its lease stays on origin and
 * was cured only by the 30-minute TTL. These tests use real processes (a spawned `sleep` as the
 * release, killed externally) since the mechanism is a live `ps` probe. */
describeWin('release-lease: a killed holder must not wedge the pipeline', () => {
  const victims: ChildProcess[] = [];

  function spawnVictim(): ChildProcess {
    const p = spawn('sleep', ['300'], { stdio: 'ignore' });
    victims.push(p);
    return p;
  }

  async function killVictim(p: ChildProcess): Promise<void> {
    const exited = new Promise<void>((resolve) => p.once('exit', () => resolve()));
    p.kill('SIGKILL');
    await exited;
  }

  function thisHost(): string {
    lease(boxA, ['claim', '0.0.0'], { RELEASE_LEASE_HOLDER_PID: String(process.pid) });
    const host = currentHolder(boxA).split('/')[0];
    lease(boxA, ['release']);
    expect(host).not.toBe('');
    return host;
  }

  function startStamp(pid: number): string {
    const r = spawnSync('bash', ['-c', `ps -p ${pid} -o lstart= | tr -s '[:space:]' '_' | sed 's/^_//; s/_$//'`], {
      encoding: 'utf-8',
    });
    return r.stdout.trim();
  }

  afterEach(() => {
    for (const p of victims.splice(0)) p.kill('SIGKILL');
  });

  it('status says the holder is alive, then says it is gone once killed', async () => {
    const victim = spawnVictim();
    lease(boxA, ['claim', '1.20.82'], { RELEASE_LEASE_HOLDER_PID: String(victim.pid) });

    expect(lease(boxA, ['status']).stdout).toContain('holder-alive=yes');

    await killVictim(victim);

    const dead = lease(boxA, ['status']);
    expect(dead.stdout).toContain('holder-alive=no');
    expect(dead.stdout).toContain('clear');
  });

  it('reclaims a killed holder immediately, without waiting out the TTL', async () => {
    const victim = spawnVictim();
    lease(boxA, ['claim', '1.20.82'], { RELEASE_LEASE_HOLDER_PID: String(victim.pid) });
    await killVictim(victim);

    const again = lease(boxA, ['claim', '1.20.83', '--ttl-min', '45']);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('holder is gone');
    expect(lease(boxA, ['verify']).status).toBe(0);
  });

  it('counts an unreaped zombie holder as dead, not as a live release', () => {
    const pid = spawnZombie();
    expect(procState(pid)).toMatch(/^Z/);

    plantStaleLease(boxA, '1.20.82', 0, { host: thisHost(), pid });
    const b = lease(boxA, ['claim', '1.20.83', '--ttl-min', '45']);
    expect(b.status).toBe(0);
    expect(b.stdout).toContain('holder is gone');
  });

  it('never force-steals a live holder, even long past the TTL', () => {
    const pid = spawnVictim().pid!;
    plantStaleLease(boxA, '1.20.82', 90, { host: thisHost(), pid, started: startStamp(pid) });

    const b = lease(boxA, ['claim', '1.20.83', '--ttl-min', '45']);
    expect(b.status).toBe(1);
    expect(b.stderr).toContain('release already in flight');
    expect(b.stdout).toContain('still running on this box');
  });

  it('treats a recycled pid as dead, not as a live release', () => {
    const pid = spawnVictim().pid!;
    plantStaleLease(boxA, '1.20.82', 0, { host: thisHost(), pid, started: 'Mon_Jan_1_00:00:00_1990' });

    const b = lease(boxA, ['claim', '1.20.83', '--ttl-min', '45']);
    expect(b.status).toBe(0);
    expect(b.stdout).toContain('holder is gone');
  });

  it('will not probe a holder on another box — the TTL still governs there', () => {
    plantStaleLease(boxA, '1.20.82', 5, { host: 'some-other-box', pid: 1 });
    const fresh = lease(boxA, ['claim', '1.20.83', '--ttl-min', '45']);
    expect(fresh.status).toBe(1);
    expect(fresh.stdout).toContain('holder-alive=unknown');

    plantStaleLease(boxA, '1.20.82', 90, { host: 'some-other-box', pid: 1, force: true });
    const stale = lease(boxA, ['claim', '1.20.84', '--ttl-min', '45']);
    expect(stale.status).toBe(0);
    expect(stale.stdout).toContain('reclaiming a stale release lease');
  });

  it('keeps the release process as the holder across a renew', () => {
    const env = { RELEASE_LEASE_HOLDER_PID: String(spawnVictim().pid) };
    lease(boxA, ['claim', '1.20.82'], env);
    expect(lease(boxA, ['renew'], env).status).toBe(0);

    expect(lease(boxA, ['status']).stdout).toContain('holder-alive=yes');
    expect(lease(boxB, ['claim', '1.20.83', '--ttl-min', '45']).status).toBe(1);
  });
});

describeWin('release-lease: clear', () => {
  it('drops a lease whose holder was killed, without starting a release', async () => {
    const p = spawn('sleep', ['300'], { stdio: 'ignore' });
    lease(boxA, ['claim', '1.20.82'], { RELEASE_LEASE_HOLDER_PID: String(p.pid) });
    const exited = new Promise<void>((resolve) => p.once('exit', () => resolve()));
    p.kill('SIGKILL');
    await exited;

    expect(lease(boxB, ['release']).stdout).toContain('no release lease to drop');

    const cleared = lease(boxB, ['clear']);
    expect(cleared.status).toBe(0);
    expect(cleared.stdout).toContain('no live holder');
    expect(lease(boxB, ['status']).stdout.trim()).toBe('unheld');
  });

  it('refuses to clear a lease that may still be held', () => {
    plantStaleLease(boxA, '1.20.82', 5);
    const r = lease(boxB, ['clear', '--ttl-min', '45']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('refusing to clear');
    expect(lease(boxB, ['status']).stdout).toContain('version=1.20.82');
  });

  it('clears a long-stale lease and is a no-op when nothing is held', () => {
    expect(lease(boxA, ['clear']).stdout).toContain('no release lease to clear');

    plantStaleLease(boxA, '1.20.82', 90);
    expect(lease(boxB, ['clear', '--ttl-min', '45']).status).toBe(0);
    expect(lease(boxB, ['status']).stdout.trim()).toBe('unheld');
  });
});
