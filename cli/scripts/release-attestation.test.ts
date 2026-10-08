import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, 'release-attestation.sh');
const temps: string[] = [];

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sh(args: string[], cwd?: string): { status: number; out: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { cwd, encoding: 'utf-8' });
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function sha256(file: string): string {
  const r = spawnSync('sha256sum', [file], { encoding: 'utf-8' });
  if (r.status === 0) return r.stdout.trim().split(/\s+/)[0];
  const s = spawnSync('shasum', ['-a', '256', file], { encoding: 'utf-8' });
  if (s.status !== 0) throw new Error(`sha256 failed: ${s.stderr}`);
  return s.stdout.trim().split(/\s+/)[0];
}

function initRepo(): { root: string; tree: string; commit: string } {
  const root = tmp('rel-attest-repo-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  fs.mkdirSync(path.join(root, 'cli'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cli/bun.lock'), 'lock-v1\n');
  fs.writeFileSync(path.join(root, 'cli/vitest.config.ts'), 'export default {}\n');
  fs.writeFileSync(path.join(root, 'cli/package.json'), '{"version":"1.0.0"}\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return {
    root,
    tree: git(root, 'rev-parse', 'HEAD^{tree}'),
    commit: git(root, 'rev-parse', 'HEAD'),
  };
}

function packTgz(dir: string, filename: string, body: string): { path: string; digest: string } {
  const tgz = path.join(dir, filename);
  fs.writeFileSync(tgz, body);
  return { path: tgz, digest: `sha256:${sha256(tgz)}` };
}

function record(opts: {
  tree: string;
  lock: string;
  policy: string;
  bun?: string;
  node?: string;
  platform?: string;
  suite?: string;
  filename: string;
  digest: string;
  conclusion?: string;
}): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: 'merge-candidate',
    candidateTree: opts.tree,
    candidateCommit: 'deadbeef',
    lockfileDigest: opts.lock,
    policyVersion: opts.policy,
    toolchain: { bun: opts.bun ?? '1.2.3', node: opts.node ?? 'v24.0.0', os: opts.platform ?? 'Linux-x86_64' },
    platform: opts.platform ?? 'Linux-x86_64',
    suite: opts.suite ?? 'selected',
    conclusion: opts.conclusion ?? 'pass',
    tarball: { filename: opts.filename, digest: opts.digest },
  });
}

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

describeUnix('release-attestation.sh', () => {
  it('identity binds tree, lockfile, policy, and toolchain from a real repo', () => {
    const { root, tree, commit } = initRepo();
    const { status, out } = sh(['identity', '--repo-root', root], root);
    expect(status, out).toBe(0);
    const id = JSON.parse(out);
    expect(id.candidateTree).toBe(tree);
    expect(id.candidateCommit).toBe(commit);
    expect(id.lockfileDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(id.policyVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(id.toolchain.bun).toBeTruthy();
    expect(id.toolchain.node).toBeTruthy();
    expect(id.platform).toBeTruthy();
  });

  it('policyVersion depends only on file content, not the --repo-root checkout path (RUSH-2749)', () => {
    const { root, commit } = initRepo();
    const idA = JSON.parse(sh(['identity', '--repo-root', root], root).out);

    const clone = tmp('rel-attest-clone-');
    spawnSync('git', ['clone', '-q', root, clone]);
    git(clone, 'checkout', '-q', commit);
    const idB = JSON.parse(sh(['identity', '--repo-root', clone], clone).out);

    expect(idA.policyVersion).toBe(idB.policyVersion);
    expect(idA.lockfileDigest).toBe(idB.lockfileDigest);
  });

  it('require accepts the exact tree/toolchain/lock/policy key and rejects a parent tree', () => {
    const { root, tree } = initRepo();
    const id = JSON.parse(sh(['identity', '--repo-root', root], root).out);
    const store = tmp('rel-attest-store-');
    const tarball = packTgz(store, 'phnx-labs-agents-cli-1.0.0.tgz', 'pretested-bytes');
    const src = path.join(store, 'in.json');
    fs.writeFileSync(
      src,
      record({
        tree,
        lock: id.lockfileDigest,
        policy: id.policyVersion,
        bun: id.toolchain.bun,
        node: id.toolchain.node,
        platform: id.platform,
        filename: 'phnx-labs-agents-cli-1.0.0.tgz',
        digest: tarball.digest,
      }),
    );
    const written = sh(['write', '--dir', store, '--file', src], root);
    expect(written.status, written.out).toBe(0);

    const ok = sh(
      [
        'require',
        '--dir',
        store,
        '--tree',
        tree,
        '--lock',
        id.lockfileDigest,
        '--policy',
        id.policyVersion,
        '--bun',
        id.toolchain.bun,
        '--node',
        id.toolchain.node,
        '--platform',
        id.platform,
        '--suite',
        'selected',
      ],
      root,
    );
    expect(ok.status, ok.out).toBe(0);
    expect(ok.out.trim()).toBe(written.out.trim());

    fs.writeFileSync(path.join(root, 'cli/src.ts'), 'changed\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'child');
    const child = git(root, 'rev-parse', 'HEAD^{tree}');
    expect(child).not.toBe(tree);

    const otherHost = sh(
      [
        'require',
        '--dir',
        store,
        '--tree',
        tree,
        '--lock',
        id.lockfileDigest,
        '--policy',
        id.policyVersion,
        '--suite',
        'selected',
        '--repo-root',
        root,
      ],
      root,
    );
    expect(otherHost.status, otherHost.out).toBe(0);

    const parent = sh(
      [
        'require',
        '--dir',
        store,
        '--tree',
        child,
        '--lock',
        id.lockfileDigest,
        '--policy',
        id.policyVersion,
        '--bun',
        id.toolchain.bun,
        '--node',
        id.toolchain.node,
        '--platform',
        id.platform,
        '--suite',
        'selected',
      ],
      root,
    );
    expect(parent.status).not.toBe(0);
    expect(parent.out).toContain('missing exact attestation key');
    expect(parent.out).toContain(`tree=${child}`);
    expect(parent.out).not.toContain(tree);
  });

  it('atomically replaces an existing content-addressed record', () => {
    const { root, tree } = initRepo();
    const id = JSON.parse(sh(['identity', '--repo-root', root], root).out);
    const store = tmp('rel-attest-atomic-');
    const tarball = packTgz(store, 'phnx-labs-agents-cli-1.0.0.tgz', 'pretested-bytes');
    const src = path.join(store, 'in.json');
    const base = {
      tree,
      lock: id.lockfileDigest,
      policy: id.policyVersion,
      bun: id.toolchain.bun,
      node: id.toolchain.node,
      platform: id.platform,
      filename: 'phnx-labs-agents-cli-1.0.0.tgz',
      digest: tarball.digest,
    };
    fs.writeFileSync(src, record(base));
    const first = sh(['write', '--dir', store, '--file', src], root);
    expect(first.status, first.out).toBe(0);
    const dest = first.out.trim();
    const firstInode = fs.statSync(dest).ino;

    const replacement = JSON.parse(record(base));
    replacement.candidateCommit = 'feedface';
    fs.writeFileSync(src, JSON.stringify(replacement));
    const second = sh(['write', '--dir', store, '--file', src], root);
    expect(second.status, second.out).toBe(0);
    expect(second.out.trim()).toBe(dest);
    expect(fs.statSync(dest).ino).not.toBe(firstInode);
    expect(JSON.parse(fs.readFileSync(dest, 'utf-8')).candidateCommit).toBe('feedface');
    expect(fs.readdirSync(store).some((name) => /^\.[0-9a-f]{64}\./.test(name))).toBe(false);
  });

  it('rejects lock, policy, and toolchain mismatches and a failing conclusion', () => {
    const store = tmp('rel-attest-bad-');
    const tarball = packTgz(store, 'phnx-labs-agents-cli-1.0.0.tgz', 'x');
    const base = {
      tree: 'aaa',
      lock: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      policy: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
      filename: 'phnx-labs-agents-cli-1.0.0.tgz',
      digest: tarball.digest,
    };
    const file = path.join(store, 'a.json');
    fs.writeFileSync(file, record(base));
    expect(sh(['verify', '--file', file, '--tree', 'bbb']).status).not.toBe(0);
    expect(sh(['verify', '--file', file, '--tree', 'aaa', '--lock', 'sha256:dead']).out).toContain(
      'lock',
    );
    expect(sh(['verify', '--file', file, '--tree', 'aaa', '--policy', 'sha256:dead']).out).toContain(
      'policy',
    );
    expect(sh(['verify', '--file', file, '--tree', 'aaa', '--bun', '0.0.0']).out).toContain('bun');
    fs.writeFileSync(file, record({ ...base, conclusion: 'fail' }));
    expect(sh(['verify', '--file', file, '--tree', 'aaa']).status).not.toBe(0);
  });

  it('promote accepts the attested tgz and refuses a rebuilt/different file', () => {
    const store = tmp('rel-attest-promote-');
    const tarball = packTgz(store, 'phnx-labs-agents-cli-9.9.9.tgz', 'exact-bytes');
    const file = path.join(store, 'att.json');
    fs.writeFileSync(
      file,
      record({
        tree: 'ttt',
        lock: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        policy: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        filename: 'phnx-labs-agents-cli-9.9.9.tgz',
        digest: tarball.digest,
      }),
    );
    const ok = sh(['promote', '--file', file, '--tarball', tarball.path, '--tree', 'ttt']);
    expect(ok.status, ok.out).toBe(0);
    expect(ok.out.trim()).toBe(tarball.path);

    const other = packTgz(store, 'phnx-labs-agents-cli-9.9.9.tgz', 'REBUILT');
    const bad = sh(['promote', '--file', file, '--tarball', other.path, '--tree', 'ttt']);
    expect(bad.status).not.toBe(0);
    expect(bad.out).toContain('refusing to publish a different artifact');
  });

  it('benchmarks require+promote well under the 60s ordinary-release P99', () => {
    const { root, tree } = initRepo();
    const id = JSON.parse(sh(['identity', '--repo-root', root], root).out);
    const store = tmp('rel-attest-bench-');
    const tarball = packTgz(store, 'phnx-labs-agents-cli-1.0.0.tgz', 'bench');
    const src = path.join(store, 'in.json');
    fs.writeFileSync(
      src,
      record({
        tree,
        lock: id.lockfileDigest,
        policy: id.policyVersion,
        bun: id.toolchain.bun,
        node: id.toolchain.node,
        platform: id.platform,
        filename: 'phnx-labs-agents-cli-1.0.0.tgz',
        digest: tarball.digest,
      }),
    );
    sh(['write', '--dir', store, '--file', src], root);
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const req = sh(
        [
          'require',
          '--dir',
          store,
          '--tree',
          tree,
          '--lock',
          id.lockfileDigest,
          '--policy',
          id.policyVersion,
          '--bun',
          id.toolchain.bun,
          '--node',
          id.toolchain.node,
          '--platform',
          id.platform,
          '--suite',
          'selected',
        ],
        root,
      );
      expect(req.status, req.out).toBe(0);
      const promo = sh(['promote', '--file', req.out.trim(), '--tarball', tarball.path, '--tree', tree]);
      expect(promo.status, promo.out).toBe(0);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p99 = samples[samples.length - 1];
    expect(p99).toBeLessThan(10_000);
  });

  describe('derive', () => {
    function releaseCommit(root: string, changes: () => void): { tree: string; commit: string } {
      changes();
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'chore(release): x');
      return { tree: git(root, 'rev-parse', 'HEAD^{tree}'), commit: git(root, 'rev-parse', 'HEAD') };
    }

    function baseAttestation(root: string, tree: string, store: string): string {
      const id = JSON.parse(sh(['identity', '--repo-root', root], root).out);
      const tgz = packTgz(store, 'phnx-labs-agents-cli-1.0.0.tgz', 'base-pretested');
      const p = path.join(store, 'base.json');
      fs.writeFileSync(
        p,
        record({
          tree,
          lock: id.lockfileDigest,
          policy: id.policyVersion,
          bun: id.toolchain.bun,
          node: id.toolchain.node,
          platform: id.platform,
          filename: 'phnx-labs-agents-cli-1.0.0.tgz',
          digest: tgz.digest,
        }),
      );
      return p;
    }

    it('mints a release-tree record inheriting the base pass, with the release tarball', () => {
      const { root, tree: baseTree } = initRepo();
      const store = tmp('rel-attest-derive-');
      const base = baseAttestation(root, baseTree, store);
      const rel = releaseCommit(root, () => {
        fs.writeFileSync(path.join(root, 'cli/package.json'), '{"version":"1.0.1"}\n');
        fs.mkdirSync(path.join(root, 'cli/.changelog'), { recursive: true });
        fs.writeFileSync(path.join(root, 'cli/.changelog/1.0.1.md'), '- note\n');
        fs.mkdirSync(path.join(root, 'cli/docs'), { recursive: true });
        fs.writeFileSync(path.join(root, 'cli/docs/command-index.md'), '# index\n');
        fs.writeFileSync(path.join(root, 'cli/docs/command-index.json'), '{"tree":[]}\n');
        fs.writeFileSync(path.join(root, 'cli/docs/command-reference.html'), '<html>reference</html>\n');
      });
      const tgz = packTgz(store, 'phnx-labs-agents-cli-1.0.1.tgz', 'release-pretested');
      const d = sh(['derive', '--base', base, '--tarball', tgz.path, '--repo-root', root, '--commit', rel.commit], root);
      expect(d.status, d.out).toBe(0);
      const rec = JSON.parse(d.out);
      expect(rec.candidateTree).toBe(rel.tree);
      expect(rec.candidateCommit).toBe(rel.commit);
      expect(rec.conclusion).toBe('pass');
      expect(rec.tarball.filename).toBe('phnx-labs-agents-cli-1.0.1.tgz');
      expect(rec.tarball.digest).toBe(tgz.digest);
      expect(rec.derivedFrom.baseTree).toBe(baseTree);
      const baseRec = JSON.parse(fs.readFileSync(base, 'utf-8'));
      expect(rec.lockfileDigest).toBe(baseRec.lockfileDigest);
      expect(rec.policyVersion).toBe(baseRec.policyVersion);
    });

    it('a derived record satisfies require() for the release tree (round-trip)', () => {
      const { root, tree: baseTree } = initRepo();
      const store = tmp('rel-attest-derive-rt-');
      const base = baseAttestation(root, baseTree, store);
      const rel = releaseCommit(root, () => {
        fs.writeFileSync(path.join(root, 'cli/package.json'), '{"version":"1.0.1"}\n');
      });
      const tgz = packTgz(store, 'phnx-labs-agents-cli-1.0.1.tgz', 'release-pretested');
      const d = sh(['derive', '--base', base, '--tarball', tgz.path, '--repo-root', root, '--commit', rel.commit], root);
      expect(d.status, d.out).toBe(0);
      const src = path.join(store, 'derived.json');
      fs.writeFileSync(src, d.out);
      const written = sh(['write', '--dir', store, '--file', src], root);
      expect(written.status, written.out).toBe(0);
      const req = sh(['require', '--dir', store, '--tree', rel.tree, '--repo-root', root], root);
      expect(req.status, req.out).toBe(0);
    });

    it('inherits across monorepo changes outside the CLI package', () => {
      const { root, tree: baseTree } = initRepo();
      const store = tmp('rel-attest-derive-unrelated-');
      const base = baseAttestation(root, baseTree, store);
      const rel = releaseCommit(root, () => {
        fs.writeFileSync(path.join(root, 'README.md'), '# unrelated monorepo docs\n');
        fs.writeFileSync(path.join(root, 'cli/package.json'), '{"version":"1.0.1"}\n');
      });
      const tgz = packTgz(store, 'phnx-labs-agents-cli-1.0.1.tgz', 'release-pretested');
      const d = sh(['derive', '--base', base, '--tarball', tgz.path, '--repo-root', root, '--commit', rel.commit], root);
      expect(d.status, d.out).toBe(0);
      expect(JSON.parse(d.out).candidateTree).toBe(rel.tree);
    });

    it('refuses when the release tree changes code beyond version/changelog/command-index', () => {
      const { root, tree: baseTree } = initRepo();
      const store = tmp('rel-attest-derive-neg-');
      const base = baseAttestation(root, baseTree, store);
      const rel = releaseCommit(root, () => {
        fs.mkdirSync(path.join(root, 'cli/src'), { recursive: true });
        fs.writeFileSync(path.join(root, 'cli/src/foo.ts'), 'export const x = 1;\n');
      });
      const tgz = packTgz(store, 'phnx-labs-agents-cli-1.0.1.tgz', 'x');
      const d = sh(['derive', '--base', base, '--tarball', tgz.path, '--repo-root', root, '--commit', rel.commit], root);
      expect(d.status).not.toBe(0);
      expect(d.out).toMatch(/cli\/src\/foo\.ts|beyond version\/changelog\/command-index/);
    });

    it('refuses a lockfile change (would silently ride a stale suite result)', () => {
      const { root, tree: baseTree } = initRepo();
      const store = tmp('rel-attest-derive-lock-');
      const base = baseAttestation(root, baseTree, store);
      const rel = releaseCommit(root, () => {
        fs.writeFileSync(path.join(root, 'cli/bun.lock'), 'lock-v2\n');
      });
      const tgz = packTgz(store, 'phnx-labs-agents-cli-1.0.1.tgz', 'x');
      const d = sh(['derive', '--base', base, '--tarball', tgz.path, '--repo-root', root, '--commit', rel.commit], root);
      expect(d.status).not.toBe(0);
      expect(d.out).toMatch(/bun\.lock|beyond/);
    });

    it('refuses a packaged session-tracker change', () => {
      const { root, tree: baseTree } = initRepo();
      const store = tmp('rel-attest-derive-session-tracker-');
      const base = baseAttestation(root, baseTree, store);
      const rel = releaseCommit(root, () => {
        fs.mkdirSync(path.join(root, 'packages/session-tracker/src'), { recursive: true });
        fs.writeFileSync(path.join(root, 'packages/session-tracker/src/index.ts'), 'export const changed = true;\n');
      });
      const tgz = packTgz(store, 'phnx-labs-agents-cli-1.0.1.tgz', 'x');
      const d = sh(['derive', '--base', base, '--tarball', tgz.path, '--repo-root', root, '--commit', rel.commit], root);
      expect(d.status).not.toBe(0);
      expect(d.out).toMatch(/session-tracker/);
    });

    it('refuses a base that is not a passing tarball proof', () => {
      const { root, tree: baseTree } = initRepo();
      const store = tmp('rel-attest-derive-badbase-');
      const id = JSON.parse(sh(['identity', '--repo-root', root], root).out);
      const badBase = path.join(store, 'bad.json');
      fs.writeFileSync(
        badBase,
        record({
          tree: baseTree,
          lock: id.lockfileDigest,
          policy: id.policyVersion,
          filename: 'phnx-labs-agents-cli-1.0.0.tgz',
          digest: `sha256:${'a'.repeat(64)}`,
          conclusion: 'fail',
        }),
      );
      const rel = releaseCommit(root, () => {
        fs.writeFileSync(path.join(root, 'cli/package.json'), '{"version":"1.0.1"}\n');
      });
      const tgz = packTgz(store, 'phnx-labs-agents-cli-1.0.1.tgz', 'x');
      const d = sh(['derive', '--base', badBase, '--tarball', tgz.path, '--repo-root', root, '--commit', rel.commit], root);
      expect(d.status).not.toBe(0);
    });
  });
});
