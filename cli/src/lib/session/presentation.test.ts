import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const srcRoot = path.resolve(import.meta.dirname, '..', '..');
const commandsDir = path.join(srcRoot, 'commands') + path.sep;
const presentation = path.join(srcRoot, 'lib', 'session', 'presentation.ts');

function runtimeImports(file: string): string[] {
  const text = fs.readFileSync(file, 'utf-8').replace(/^import type [^;]+;/gm, '');
  const specs = [...text.matchAll(/(?:from\s+|import\s*\(\s*)'(\.{1,2}\/[^']+)'/g)].map((m) => m[1]);
  return specs.map((spec) => path.resolve(path.dirname(file), spec).replace(/\.js$/, '.ts'));
}

describe('lib/session/presentation runtime import closure', () => {
  it('imports no command module itself', () => {
    expect(runtimeImports(presentation).filter((dep) => dep.startsWith(commandsDir))).toEqual([]);
  });

  it('reaches commands only through the two library edges that predate it', () => {
    const seen = new Set<string>();
    const stack = [presentation];
    const intoCommands = new Set<string>();
    while (stack.length) {
      const file = stack.pop()!;
      if (seen.has(file) || !fs.existsSync(file)) continue;
      seen.add(file);
      for (const dep of runtimeImports(file)) {
        if (dep.startsWith(commandsDir)) intoCommands.add(`${path.relative(srcRoot, file)} -> ${path.relative(srcRoot, dep)}`);
        else stack.push(dep);
      }
    }
    expect(seen.size).toBeGreaterThan(5);
    expect([...intoCommands].sort()).toEqual([
      'lib/accounts/add.ts -> commands/utils.ts',
      'lib/smart-launch.ts -> commands/ssh.ts',
    ]);
  });
});
