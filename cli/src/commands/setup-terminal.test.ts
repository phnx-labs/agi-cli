import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

it('all setup commands reject invalid terminal modes before opening or installing anything', () => {
  const entry = fileURLToPath(new URL('../index.ts', import.meta.url));
  for (const tool of ['browser', 'computer', 'secrets', 'term']) {
    for (const [args, error] of [
      [['--terminal', 'invalid-backend'], 'Unknown --terminal backend'],
      [['--terminal', '--install-only'], '--terminal and --install-only are separate setup modes.'],
    ] as const) {
      const result = spawnSync('bun', [entry, 'setup', tool, ...args], { encoding: 'utf8', timeout: 15_000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toContain(error);
      expect(result.stderr).not.toContain('at openSetupTerminal');
      expect(result.stdout).toBe('');
    }
  }
});
