import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve(__dirname, 'generate-reference.sh');
const outputs = ['command-index.md', 'command-index.json', 'command-reference.html'];

describe.skipIf(process.platform === 'win32')('generate-reference.sh', () => {
  it('generates the real tree outside cli/, checks without writing, and repairs missing or stale output', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'reference-'));
    const outDir = join(cwd, 'preview with spaces');
    const run = (...args: string[]) => spawnSync('bash', [script, '--out-dir', 'preview with spaces', ...args], {
      cwd, encoding: 'utf8', timeout: 20_000,
    });
    try {
      const generated = run();
      expect(generated.status, generated.stderr).toBe(0);
      const before = outputs.map((file) => readFileSync(join(outDir, file), 'utf8'));
      expect(JSON.parse(before[1]).tree.length).toBeGreaterThan(50);
      expect(before[2]).toContain('<nav id="nav"');
      expect(before[2]).toContain('agents teams create &lt;team&gt;');

      const mtimes = outputs.map((file) => statSync(join(outDir, file)).mtimeMs);
      const checked = run('--check');
      expect(checked.status, checked.stderr).toBe(0);
      expect(outputs.map((file) => statSync(join(outDir, file)).mtimeMs)).toEqual(mtimes);

      writeFileSync(join(outDir, 'command-reference.html'), '<html>stale</html>');
      unlinkSync(join(outDir, 'command-index.json'));
      const stale = run('--check');
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain('command-reference.html');
      expect(stale.stderr).toContain('command-index.json');
      expect(readFileSync(join(outDir, 'command-reference.html'), 'utf8')).toBe('<html>stale</html>');

      const repaired = run();
      expect(repaired.status, repaired.stderr).toBe(0);
      expect(outputs.map((file) => readFileSync(join(outDir, file), 'utf8'))).toEqual(before);

      const typo = run('--chek');
      expect(typo.status).not.toBe(0);
      expect(typo.stderr).toContain('--chek');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
