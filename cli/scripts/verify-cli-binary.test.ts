import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const tempDirs: string[] = [];

// Run the REAL prepack gate against a staged tree: verify-cli-binary.sh cds to
// its own script-dir/.., so a copy inside a temp tree verifies that tree.
function stageTree(opts: {
  version?: string;
  binary?: string | null;
  pinSha?: string;
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-verify-cli-bin-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'bin'), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, 'scripts', 'verify-cli-binary.sh'),
    path.join(root, 'scripts', 'verify-cli-binary.sh'),
  );
  fs.chmodSync(path.join(root, 'scripts', 'verify-cli-binary.sh'), 0o755);
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ version: opts.version ?? '1.0.0' }),
  );
  if (opts.binary !== null) {
    const binary = opts.binary ?? `MACHO-STAND-IN\nvar VERSION = "${opts.version ?? '1.0.0'}";\n`;
    fs.writeFileSync(path.join(root, 'dist', 'bin', 'agents'), binary, { mode: 0o755 });
    const sha = opts.pinSha ?? createHash('sha256').update(binary).digest('hex');
    fs.writeFileSync(
      path.join(root, 'scripts', 'agents-cli-bin.sha256'),
      `${sha}  dist/bin/agents\n`,
    );
  }
  return root;
}

function runGate(root: string) {
  return spawnSync('bash', [path.join(root, 'scripts', 'verify-cli-binary.sh')], {
    encoding: 'utf-8',
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// bash is required (it is on every platform this runs: macOS, Linux CI, and
// the Windows CI runners ship Git Bash on PATH).
describe('verify-cli-binary.sh prepack gate', () => {
  it('refuses to pack when dist/bin/agents is missing', () => {
    const root = stageTree({ binary: null });
    const result = runGate(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing dist/bin/agents');
  });

  it('refuses to pack on a sha mismatch with the pin', () => {
    const root = stageTree({ pinSha: '0'.repeat(64) });
    const result = runGate(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SHA256 mismatch');
  });

  it('refuses a stale binary whose embedded version is not the packaged version', () => {
    // The stale pair is self-consistent (sha matches its own pin) — only the
    // embedded `VERSION = "…";` literal exposes it.
    const root = stageTree({
      version: '2.0.0',
      binary: 'MACHO-STAND-IN\nvar VERSION = "1.9.9";\n',
    });
    const result = runGate(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not embed version 2.0.0');
  });

  it.runIf(process.platform !== 'darwin')(
    'passes when the bundler merged VERSION into a declaration list (comma, not semicolon)',
    () => {
      // bun 1.3.14 merges adjacent consts, so the stamped line lands as `var VERSION = "<v>",
      // IS_DEV_BUILD = ...;`; the gate must not demand a semicolon after the literal (1.22.36
      // publish blocker).
      const root = stageTree({
        binary: 'MACHO-STAND-IN\nvar VERSION = "1.0.0", IS_DEV_BUILD = false;\n',
      });
      const result = runGate(root);
      expect(result.status, result.stderr).toBe(0);
    },
  );

  it.runIf(process.platform !== 'darwin')(
    'passes on sha + version match where codesign does not exist',
    () => {
      const root = stageTree({});
      const result = runGate(root);
      expect(result.status, result.stderr).toBe(0);
    },
  );

  it.runIf(process.platform === 'darwin')(
    'darwin: refuses an unsigned binary even when sha + version match',
    () => {
      const root = stageTree({});
      const result = runGate(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('codesign --verify failed');
    },
  );
});
