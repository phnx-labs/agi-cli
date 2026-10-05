import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentId } from '../types.js';
import { AgentPackageError } from './package-types.js';
import { resolveAgentPackage } from './package-resolve.js';
import { materializeAgentPackage } from './materialize.js';
import { getMcpConfigPathForHome } from './agents.js';
import { hookRegistrationTargets } from '../hooks/install.js';

const FIXTURE = path.join(import.meta.dirname, 'testdata', 'rabbit-hole');

const tempDirs: string[] = [];
function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pkg-materialize-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const HARNESS_VERSIONS: Record<string, string> = { claude: '2.1.0', codex: '0.150.0', opencode: '1.2.0' };

describe('materializeAgentPackage — native layouts', () => {
  for (const harness of ['claude', 'codex', 'opencode'] as AgentId[]) {
    it(`materializes the rabbit-hole fixture into a native ${harness} home`, () => {
      const resolved = resolveAgentPackage(FIXTURE);
      const outputHome = tempHome();
      const receipt = materializeAgentPackage(resolved, { harness, harnessVersion: HARNESS_VERSIONS[harness], outputHome });

      expect(receipt.harness).toEqual({ id: harness, version: HARNESS_VERSIONS[harness] });
      expect(receipt.agent.digest).toBe(`sha256:${resolved.digest}`);
      const kinds = receipt.resources.map((r) => r.kind).sort();
      expect(kinds).toEqual(['hooks', 'instructions', 'mcp', 'skills', 'subagents']);

      // Every listed target genuinely exists on disk under the output home.
      for (const entry of receipt.resources) {
        expect(fs.existsSync(path.join(outputHome, entry.target)), `${entry.kind}:${entry.name} -> ${entry.target}`).toBe(true);
      }
    });
  }

  it('opencode gets the overlay skill content, claude gets the portable one', () => {
    const resolved = resolveAgentPackage(FIXTURE);
    const claudeHome = tempHome();
    const opencodeHome = tempHome();
    const claudeReceipt = materializeAgentPackage(resolved, { harness: 'claude', harnessVersion: '2.1.0', outputHome: claudeHome });
    const opencodeReceipt = materializeAgentPackage(resolved, { harness: 'opencode', harnessVersion: '1.2.0', outputHome: opencodeHome });

    const claudeSkillEntry = claudeReceipt.resources.find((r) => r.kind === 'skills')!;
    const opencodeSkillEntry = opencodeReceipt.resources.find((r) => r.kind === 'skills')!;
    expect(claudeSkillEntry.provenance).toBe('portable');
    expect(opencodeSkillEntry.provenance).toBe('overlay');
    expect(claudeSkillEntry.sha256).not.toBe(opencodeSkillEntry.sha256);

    const claudeSkillContent = fs.readFileSync(path.join(claudeHome, claudeSkillEntry.target, 'SKILL.md'), 'utf-8');
    const opencodeSkillContent = fs.readFileSync(path.join(opencodeHome, opencodeSkillEntry.target, 'SKILL.md'), 'utf-8');
    expect(claudeSkillContent).toContain('Search broadly');
    expect(opencodeSkillContent).toContain('native `webfetch` tool');
  });

  it('materializes the mcp server into claude\'s .mcp.json with the declared command', () => {
    const resolved = resolveAgentPackage(FIXTURE);
    const outputHome = tempHome();
    const receipt = materializeAgentPackage(resolved, { harness: 'claude', harnessVersion: '2.1.0', outputHome });
    const mcpEntry = receipt.resources.find((r) => r.kind === 'mcp')!;
    const config = JSON.parse(fs.readFileSync(path.join(outputHome, mcpEntry.target), 'utf-8'));
    expect(config.mcpServers.browser.command).toBe('npx');
  });

  it('registers the hook script under the harness hooks dir, executable', () => {
    const resolved = resolveAgentPackage(FIXTURE);
    const outputHome = tempHome();
    const receipt = materializeAgentPackage(resolved, { harness: 'claude', harnessVersion: '2.1.0', outputHome });
    const hookEntry = receipt.resources.find((r) => r.kind === 'hooks')!;
    const scriptPath = path.join(outputHome, hookEntry.target);
    expect(fs.statSync(scriptPath).mode & 0o111).not.toBe(0);
    const settings = JSON.parse(fs.readFileSync(path.join(outputHome, '.claude', 'settings.json'), 'utf-8'));
    expect(JSON.stringify(settings)).toContain('PostToolUse');
  });
});

describe('materializeAgentPackage — determinism', () => {
  it('produces a byte-identical receipt on a second run against the same output home', () => {
    const resolved = resolveAgentPackage(FIXTURE);
    const outputHome = tempHome();
    materializeAgentPackage(resolved, { harness: 'claude', harnessVersion: '2.1.0', outputHome });
    const firstReceiptBytes = fs.readFileSync(path.join(outputHome, 'materialization-receipt.json'));
    materializeAgentPackage(resolved, { harness: 'claude', harnessVersion: '2.1.0', outputHome });
    const secondReceiptBytes = fs.readFileSync(path.join(outputHome, 'materialization-receipt.json'));
    expect(secondReceiptBytes.equals(firstReceiptBytes)).toBe(true);
  });

  it('produces the same digest from a freshly-resolved package on every run', () => {
    const a = resolveAgentPackage(FIXTURE);
    const outputHomeA = tempHome();
    const receiptA = materializeAgentPackage(a, { harness: 'codex', harnessVersion: '0.150.0', outputHome: outputHomeA });

    const b = resolveAgentPackage(FIXTURE);
    const outputHomeB = tempHome();
    const receiptB = materializeAgentPackage(b, { harness: 'codex', harnessVersion: '0.150.0', outputHome: outputHomeB });

    expect(receiptA.agent.digest).toBe(receiptB.agent.digest);
    expect(receiptA.resources).toEqual(receiptB.resources);
  });
});

describe('materializeAgentPackage — stale pruning', () => {
  it('removes a previously-materialized skill that is no longer declared, without touching unmanaged files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pkg-prune-'));
    tempDirs.push(dir);
    fs.cpSync(FIXTURE, dir, { recursive: true });

    const outputHome = tempHome();
    const resolvedBefore = resolveAgentPackage(dir);
    const receiptBefore = materializeAgentPackage(resolvedBefore, { harness: 'claude', harnessVersion: '2.1.0', outputHome });
    const skillEntry = receiptBefore.resources.find((r) => r.kind === 'skills')!;
    const skillDirOnDisk = path.join(outputHome, skillEntry.target);
    expect(fs.existsSync(skillDirOnDisk)).toBe(true);

    // Plant an unmanaged file the materializer must never touch.
    const unmanagedFile = path.join(outputHome, '.claude', 'unmanaged-note.txt');
    fs.mkdirSync(path.dirname(unmanagedFile), { recursive: true });
    fs.writeFileSync(unmanagedFile, 'do not delete me');

    // Remove the skill from the package and re-materialize into the SAME home.
    const manifestPath = path.join(dir, 'agent.yaml');
    fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, 'utf-8').replace('  skills:\n    - skills/web-research\n', ''));

    const resolvedAfter = resolveAgentPackage(dir);
    const receiptAfter = materializeAgentPackage(resolvedAfter, { harness: 'claude', harnessVersion: '2.1.0', outputHome });

    expect(receiptAfter.resources.some((r) => r.kind === 'skills')).toBe(false);
    expect(fs.existsSync(skillDirOnDisk)).toBe(false);
    expect(fs.existsSync(unmanagedFile)).toBe(true);
    expect(fs.readFileSync(unmanagedFile, 'utf-8')).toBe('do not delete me');
  });
});

describe('materializeAgentPackage — refuses to write through a symlink out of the output home', () => {
  it('refuses when a symlink is planted at the harness-config-dir join point (outputHome/.claude -> live home)', () => {
    const resolved = resolveAgentPackage(FIXTURE);
    // A stand-in for the operator's real ~/.claude, with a marker we must not touch.
    const fakeHome = tempHome();
    const liveClaude = path.join(fakeHome, '.claude');
    fs.mkdirSync(liveClaude, { recursive: true });
    const marker = path.join(liveClaude, 'CLAUDE.md');
    fs.writeFileSync(marker, 'LIVE-MARKER-DO-NOT-TOUCH');

    const outputHome = tempHome();
    // resolveOutputHome would accept this output home (it's an ordinary dir);
    // the escape is the child the materializer forms itself.
    fs.symlinkSync(liveClaude, path.join(outputHome, '.claude'));

    expect(() =>
      materializeAgentPackage(resolved, { harness: 'claude', harnessVersion: '2.1.0', outputHome }),
    ).toThrow(/outside the output home/);
    // The live marker is untouched — nothing was written through the symlink.
    expect(fs.readFileSync(marker, 'utf-8')).toBe('LIVE-MARKER-DO-NOT-TOUCH');
  });
});

describe('materializeAgentPackage — refuses a preplanted symlink at each final leaf (PHNX-3838)', () => {
  // Every concrete file the materializer writes or chmods, keyed to the leaf a preplanted symlink
  // could redirect. `dangling` (target absent) is the subtle case realpath-of-existing-prefix
  // misses, which copyFileSync/writeFileSync/chmod then follow.
  const leaves: { name: string; leaf: (home: string) => string }[] = [
    { name: 'instructions', leaf: (h) => path.join(h, '.claude', 'CLAUDE.md') },
    { name: 'mcp config', leaf: (h) => getMcpConfigPathForHome('claude', h) },
    { name: 'subagent file', leaf: (h) => path.join(h, '.claude', 'agents', 'source-finder.md') },
    { name: 'hook script', leaf: (h) => path.join(h, '.claude', 'hooks', 'capture.sh') },
    { name: 'hook settings.json', leaf: (h) => path.join(h, '.claude', 'settings.json') },
    { name: 'materialization receipt', leaf: (h) => path.join(h, 'materialization-receipt.json') },
  ];

  for (const dangling of [true, false]) {
    for (const c of leaves) {
      it(`refuses a ${dangling ? 'dangling' : 'live'} symlink at the ${c.name} leaf`, () => {
        const resolved = resolveAgentPackage(FIXTURE);
        const outputHome = tempHome();
        const victimDir = tempHome();
        const victim = path.join(victimDir, 'pwned.txt');
        if (!dangling) fs.writeFileSync(victim, 'LIVE-VICTIM');
        const leaf = c.leaf(outputHome);
        fs.mkdirSync(path.dirname(leaf), { recursive: true });
        fs.symlinkSync(victim, leaf);

        expect(() =>
          materializeAgentPackage(resolved, { harness: 'claude', harnessVersion: '2.1.0', outputHome }),
        ).toThrow(/symlink|outside the output home/);

        if (dangling) {
          expect(fs.existsSync(victim), `${c.name}: nothing created through a dangling symlink`).toBe(false);
        } else {
          expect(fs.readFileSync(victim, 'utf-8'), `${c.name}: live victim untouched`).toBe('LIVE-VICTIM');
        }
      });
    }
  }
});

describe('materializeAgentPackage — never GCs the process-global hook shim dir (PHNX-3838)', () => {
  it('leaves unrelated operator shims intact when a package with hooks is materialized', () => {
    const resolved = resolveAgentPackage(FIXTURE);
    // The ONE process-global shim dir every harness's normal sync sweeps by
    // manifest. Isolate it to a temp dir so the assertion is deterministic.
    const shimsDir = tempHome();
    const operatorShim = path.join(shimsDir, 'operator-hook.sh');
    fs.writeFileSync(operatorShim, '#!/bin/sh\n# operator hook, unrelated to any package\n');
    const anotherShim = path.join(shimsDir, 'watchdog.sh');
    fs.writeFileSync(anotherShim, '#!/bin/sh\n# another unrelated operator hook\n');

    const prev = process.env.AGENTS_HOOK_SHIMS_DIR;
    process.env.AGENTS_HOOK_SHIMS_DIR = shimsDir;
    try {
      const outputHome = tempHome();
      const receipt = materializeAgentPackage(resolved, { harness: 'claude', harnessVersion: '2.1.0', outputHome });
      // The hook really was registered (otherwise this test proves nothing).
      expect(receipt.resources.some((r) => r.kind === 'hooks')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.AGENTS_HOOK_SHIMS_DIR;
      else process.env.AGENTS_HOOK_SHIMS_DIR = prev;
    }

    // The package manifest carried only its own hook — the default sweep would
    // have deleted BOTH unrelated shims. They must survive.
    expect(fs.existsSync(operatorShim), 'operator-hook.sh survives materialization').toBe(true);
    expect(fs.existsSync(anotherShim), 'watchdog.sh survives materialization').toBe(true);
  });
});

describe('hookRegistrationTargets — the settings leaf the materializer guards, per portable harness (PHNX-3838)', () => {
  it('names the real registrar file(s) each harness writes', () => {
    const h = '/x';
    expect(hookRegistrationTargets('claude', h)).toEqual([path.join(h, '.claude', 'settings.json')]);
    expect(hookRegistrationTargets('codex', h)).toEqual([path.join(h, '.codex', 'hooks.json'), path.join(h, '.codex', 'config.toml')]);
    expect(hookRegistrationTargets('opencode', h)).toEqual([path.join(h, '.config', 'opencode', 'plugins', 'agents-cli-hooks.ts')]);
  });

  for (const harness of ['claude', 'codex', 'opencode'] as AgentId[]) {
    it(`refuses a symlink at ${harness}'s hook settings leaf`, () => {
      const resolved = resolveAgentPackage(FIXTURE);
      const outputHome = tempHome();
      const victim = path.join(tempHome(), 'pwned.txt');
      const leaf = hookRegistrationTargets(harness, outputHome)[0];
      fs.mkdirSync(path.dirname(leaf), { recursive: true });
      fs.symlinkSync(victim, leaf); // dangling
      expect(() =>
        materializeAgentPackage(resolved, { harness, harnessVersion: HARNESS_VERSIONS[harness], outputHome }),
      ).toThrow(/symlink|outside the output home/);
      expect(fs.existsSync(victim)).toBe(false);
    });
  }
});

describe('materializeAgentPackage — stale-prune never deletes outside the output home', () => {
  it('never deletes through a symlinked ancestor named by a stale receipt target (no .., not absolute)', () => {
    const resolved = resolveAgentPackage(FIXTURE);
    const outputHome = tempHome();
    const victimDir = tempHome();
    const victim = path.join(victimDir, 'keep.txt');
    fs.writeFileSync(victim, 'do not delete me');
    // A symlinked ancestor planted inside the output home.
    fs.symlinkSync(victimDir, path.join(outputHome, 'exfil'));

    // A schema-valid receipt naming a path ONE LEVEL under the symlinked ancestor:
    // textually contained (no '..', not absolute), but it realpaths outside.
    const planted = {
      schemaVersion: 1,
      agent: { ref: 'evil@000000000000', digest: 'sha256:0' },
      harness: { id: 'claude', version: '2.1.0' },
      resources: [{ kind: 'skills', name: 'ghost', target: 'exfil/keep.txt', sha256: '0', provenance: 'portable' }],
      warnings: [],
    };
    fs.writeFileSync(path.join(outputHome, 'materialization-receipt.json'), JSON.stringify(planted, null, 2) + '\n');

    materializeAgentPackage(resolved, { harness: 'claude', harnessVersion: '2.1.0', outputHome });
    expect(fs.existsSync(victim), 'victim under a symlinked ancestor must survive').toBe(true);
  });

  it('ignores a planted receipt whose target escapes the output home (../victim, absolute)', () => {
    const resolved = resolveAgentPackage(FIXTURE);
    const outputHome = tempHome();
    // A real prior run, so there is a home + receipt to overwrite.
    materializeAgentPackage(resolved, { harness: 'claude', harnessVersion: '2.1.0', outputHome });

    // Victims OUTSIDE the output home that a traversal target would delete.
    const relVictim = path.join(path.dirname(outputHome), `victim-rel-${process.pid}.txt`);
    fs.writeFileSync(relVictim, 'do not delete me');
    tempDirs.push(relVictim);
    const absVictimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pkg-abs-victim-'));
    tempDirs.push(absVictimDir);
    const absVictim = path.join(absVictimDir, 'keep.txt');
    fs.writeFileSync(absVictim, 'do not delete me either');

    // Plant a malicious, unsigned receipt claiming to "own" those outside paths.
    const planted = {
      schemaVersion: 1,
      agent: { ref: 'evil@000000000000', digest: 'sha256:0' },
      harness: { id: 'claude', version: '2.1.0' },
      resources: [
        { kind: 'skills', name: 'evil-rel', target: `../${path.basename(relVictim)}`, sha256: '0', provenance: 'portable' },
        { kind: 'skills', name: 'evil-abs', target: absVictim, sha256: '0', provenance: 'portable' },
      ],
      warnings: [],
    };
    fs.writeFileSync(path.join(outputHome, 'materialization-receipt.json'), JSON.stringify(planted, null, 2) + '\n');

    // Re-materialize: the pruner reads that receipt but must refuse the escaping targets.
    materializeAgentPackage(resolved, { harness: 'claude', harnessVersion: '2.1.0', outputHome });

    expect(fs.existsSync(relVictim), 'relative ../victim must survive').toBe(true);
    expect(fs.existsSync(absVictim), 'absolute victim must survive').toBe(true);
  });

  it('treats a schema-invalid prior receipt as no prior receipt (no pruning)', () => {
    const resolved = resolveAgentPackage(FIXTURE);
    const outputHome = tempHome();
    materializeAgentPackage(resolved, { harness: 'claude', harnessVersion: '2.1.0', outputHome });
    // Corrupt the receipt into an invalid shape; a re-run must not throw and must re-materialize cleanly.
    fs.writeFileSync(path.join(outputHome, 'materialization-receipt.json'), JSON.stringify({ schemaVersion: 2, resources: 'nope' }));
    const receipt = materializeAgentPackage(resolved, { harness: 'claude', harnessVersion: '2.1.0', outputHome });
    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.resources.length).toBeGreaterThan(0);
  });
});

describe('materializeAgentPackage — fails closed', () => {
  it('refuses a harness the package does not declare supported', () => {
    const resolved = resolveAgentPackage(FIXTURE);
    expect(() =>
      materializeAgentPackage(resolved, { harness: 'grok', harnessVersion: '1.0.0', outputHome: tempHome() }),
    ).toThrow(/does not declare 'grok' as a supported harness/);
  });

  it('blocks dispatch when the requested harness version lacks a declared capability', () => {
    const resolved = resolveAgentPackage(FIXTURE);
    // Codex hooks require >= 0.116.0 — an older version must fail loud, not silently skip hooks.
    expect(() =>
      materializeAgentPackage(resolved, { harness: 'codex', harnessVersion: '0.100.0', outputHome: tempHome() }),
    ).toThrow(AgentPackageError);
    try {
      materializeAgentPackage(resolved, { harness: 'codex', harnessVersion: '0.100.0', outputHome: tempHome() });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AgentPackageError);
      expect((err as AgentPackageError).code).toBe('unsupported-capability');
      expect((err as AgentPackageError).details?.join(' ')).toMatch(/hooks 'capture'/);
    }
  });

  it('writes nothing when capability validation fails', () => {
    const resolved = resolveAgentPackage(FIXTURE);
    const outputHome = tempHome();
    expect(() =>
      materializeAgentPackage(resolved, { harness: 'codex', harnessVersion: '0.100.0', outputHome }),
    ).toThrow();
    expect(fs.existsSync(path.join(outputHome, 'materialization-receipt.json'))).toBe(false);
  });
});

/** Copy the fixture into a fresh temp dir and rewrite its one mcp resource. */
function tempPackageWithMcpServer(overrides: { transport: 'stdio' | 'http'; url?: string; headers?: Record<string, string> }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pkg-mcp-cap-'));
  tempDirs.push(dir);
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const lines = [`name: browser`, `transport: ${overrides.transport}`];
  if (overrides.url) lines.push(`url: ${overrides.url}`);
  if (overrides.headers) {
    lines.push('headers:');
    for (const [k, v] of Object.entries(overrides.headers)) lines.push(`  ${k}: ${v}`);
  }
  fs.writeFileSync(path.join(dir, 'mcp', 'browser.yaml'), lines.join('\n') + '\n');
  return dir;
}

function detailsOf(fn: () => unknown): string[] {
  try {
    fn();
    expect.unreachable();
  } catch (err) {
    expect(err).toBeInstanceOf(AgentPackageError);
    return (err as AgentPackageError).details ?? [];
  }
}

describe('materializeAgentPackage — mcp sub-capability gating (mcpHttp/mcpHeaders)', () => {
  it('blocks an http mcp server on a harness with mcpHttp: false (opencode)', () => {
    const dir = tempPackageWithMcpServer({ transport: 'http', url: 'https://example.com/mcp' });
    const resolved = resolveAgentPackage(dir);
    const details = detailsOf(() => materializeAgentPackage(resolved, { harness: 'opencode', harnessVersion: '1.2.0', outputHome: tempHome() }));
    expect(details.join(' ')).toMatch(/does not support capability 'mcpHttp'/);
  });

  it('blocks http headers on a harness with mcpHeaders: false (codex)', () => {
    const dir = tempPackageWithMcpServer({ transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } });
    const resolved = resolveAgentPackage(dir);
    const details = detailsOf(() => materializeAgentPackage(resolved, { harness: 'codex', harnessVersion: '0.150.0', outputHome: tempHome() }));
    expect(details.join(' ')).toMatch(/does not support capability 'mcpHeaders'/);
  });

  it('never writes the header into a config file the harness cannot express it in', () => {
    const dir = tempPackageWithMcpServer({ transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer secret' } });
    const resolved = resolveAgentPackage(dir);
    const outputHome = tempHome();
    expect(() => materializeAgentPackage(resolved, { harness: 'codex', harnessVersion: '0.150.0', outputHome })).toThrow();
    const configPath = path.join(outputHome, '.codex', 'config.toml');
    expect(fs.existsSync(configPath) && fs.readFileSync(configPath, 'utf-8').includes('secret')).toBe(false);
  });

  it('allows http + headers on a harness that supports both (claude)', () => {
    const dir = tempPackageWithMcpServer({ transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } });
    const resolved = resolveAgentPackage(dir);
    const outputHome = tempHome();
    const receipt = materializeAgentPackage(resolved, { harness: 'claude', harnessVersion: '2.1.0', outputHome });
    const mcpEntry = receipt.resources.find((r) => r.kind === 'mcp')!;
    const config = JSON.parse(fs.readFileSync(path.join(outputHome, mcpEntry.target), 'utf-8'));
    expect(config.mcpServers.browser.headers).toEqual({ Authorization: 'Bearer x' });
  });
});

describe('materializeAgentPackage — mcp config is a shared file, never blanket-deleted', () => {
  it('clears only the mcp section when the last mcp resource is removed, preserving unrelated content', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pkg-mcp-shared-'));
    tempDirs.push(dir);
    fs.cpSync(FIXTURE, dir, { recursive: true });

    const outputHome = tempHome();
    const resolvedBefore = resolveAgentPackage(dir);
    const receiptBefore = materializeAgentPackage(resolvedBefore, { harness: 'claude', harnessVersion: '2.1.0', outputHome });
    const mcpEntry = receiptBefore.resources.find((r) => r.kind === 'mcp')!;
    const configPath = path.join(outputHome, mcpEntry.target);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).mcpServers.browser).toBeDefined();

    // Simulate the real harness (or a prior operator) having written unrelated
    // top-level data into the SAME config file before this re-materialize.
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    config.oauthAccount = { email: 'someone@example.com' };
    config.projects = { '/workspace': { allowedTools: ['Bash'] } };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Remove the package's only mcp resource and re-materialize into the SAME home.
    const manifestPath = path.join(dir, 'agent.yaml');
    fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, 'utf-8').replace('  mcp:\n    - mcp/browser.yaml\n', ''));
    const resolvedAfter = resolveAgentPackage(dir);
    const receiptAfter = materializeAgentPackage(resolvedAfter, { harness: 'claude', harnessVersion: '2.1.0', outputHome });

    expect(receiptAfter.resources.some((r) => r.kind === 'mcp')).toBe(false);
    expect(fs.existsSync(configPath)).toBe(true);
    const configAfter = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(configAfter.mcpServers ?? {}).toEqual({});
    expect(configAfter.oauthAccount).toEqual({ email: 'someone@example.com' });
    expect(configAfter.projects).toEqual({ '/workspace': { allowedTools: ['Bash'] } });
  });
});
