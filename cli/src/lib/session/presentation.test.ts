import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const srcRoot = path.resolve(import.meta.dirname, '..', '..');
const commandsDir = path.join(srcRoot, 'commands') + path.sep;
const presentation = path.join(srcRoot, 'lib', 'session', 'presentation.ts');

function runtimeImports(file: string): { dep: string; dynamic: boolean }[] {
  const text = fs.readFileSync(file, 'utf-8').replace(/^import type [^;]+;/gm, '');
  return [...text.matchAll(/(from\s+|import\s*\(\s*)'(\.{1,2}\/[^']+)'/g)].map((m) => ({
    dep: path.resolve(path.dirname(file), m[2]).replace(/\.js$/, '.ts'),
    dynamic: m[1].startsWith('import'),
  }));
}

function libToCommandEdges(followDynamic: boolean): { seen: number; edges: string[] } {
  const seen = new Set<string>();
  const stack = [presentation];
  const edges = new Set<string>();
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    for (const { dep, dynamic } of runtimeImports(file)) {
      if (dynamic && !followDynamic) continue;
      if (!file.startsWith(commandsDir) && dep.startsWith(commandsDir)) {
        edges.add(`${path.relative(srcRoot, file)} -> ${path.relative(srcRoot, dep)}`);
      }
      stack.push(dep);
    }
  }
  return { seen: seen.size, edges: [...edges].sort() };
}

describe('lib/session/presentation runtime import closure', () => {
  it('imports no command module itself', () => {
    expect(runtimeImports(presentation).filter(({ dep }) => dep.startsWith(commandsDir))).toEqual([]);
  });

  it('static import closure reaches no command module', () => {
    const { seen, edges } = libToCommandEdges(false);
    expect(seen).toBeGreaterThan(5);
    expect(edges).toEqual([]);
  });

  it('closure including dynamic imports keeps exactly the four deferred library-to-command edges', () => {
    expect(libToCommandEdges(true).edges).toEqual([
      'lib/accounts/add.ts -> commands/utils.ts',
      'lib/smart-launch.ts -> commands/ssh.ts',
      'lib/snapshot.ts -> commands/ps-roster.ts',
      'lib/snapshot.ts -> commands/view.ts',
    ]);
  });
});
