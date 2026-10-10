import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const srcRoot = path.resolve(import.meta.dirname, '..', '..');
const commandsDir = path.join(srcRoot, 'commands') + path.sep;
const sessionsCommand = path.join(srcRoot, 'commands', 'sessions.ts');
const extracted = ['presentation', 'selection', 'resume-command'].map((name) => path.join(srcRoot, 'lib', 'session', `${name}.ts`));

function runtimeImports(file: string): { dep: string; dynamic: boolean }[] {
  const text = fs.readFileSync(file, 'utf-8').replace(/^import type [^;]+;/gm, '');
  return [...text.matchAll(/(from\s+|import\s*\(\s*)'(\.{1,2}\/[^']+)'/g)].map((m) => ({
    dep: path.resolve(path.dirname(file), m[2]).replace(/\.js$/, '.ts'),
    dynamic: m[1].startsWith('import'),
  }));
}

function libToCommandEdges(root: string, followDynamic: boolean): { seen: number; edges: string[] } {
  const seen = new Set<string>();
  const stack = [root];
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

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

function namesImportedFrom(file: string, target: string): string[] {
  const text = fs.readFileSync(file, 'utf-8');
  const names: string[] = [];
  for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(\.{1,2}\/[^']+)'/g)) {
    if (path.resolve(path.dirname(file), m[2]).replace(/\.js$/, '.ts') !== target) continue;
    names.push(...m[1].split(',').map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter(Boolean));
  }
  for (const m of text.matchAll(/(?:const\s+\{([^}]*)\}\s*=\s*)?await import\('(\.{1,2}\/[^']+)'\)(?:\)?\.(\w+))?/g)) {
    if (path.resolve(path.dirname(file), m[2]).replace(/\.js$/, '.ts') !== target) continue;
    if (m[1]) names.push(...m[1].split(',').map((n) => n.trim().split(/\s*:\s*/)[0]).filter(Boolean));
    if (m[3]) names.push(m[3]);
  }
  return names;
}

describe.each(extracted)('runtime import closure of %s', (root) => {
  it('imports no command module itself', () => {
    expect(runtimeImports(root).filter(({ dep }) => dep.startsWith(commandsDir))).toEqual([]);
  });

  it('static import closure reaches no command module', () => {
    const { seen, edges } = libToCommandEdges(root, false);
    expect(seen).toBeGreaterThan(5);
    expect(edges).toEqual([]);
  });

  it('closure including dynamic imports keeps exactly the four deferred library-to-command edges', () => {
    expect(libToCommandEdges(root, true).edges).toEqual([
      'lib/accounts/add.ts -> commands/utils.ts',
      'lib/smart-launch.ts -> commands/ssh.ts',
      'lib/snapshot.ts -> commands/ps-roster.ts',
      'lib/snapshot.ts -> commands/view.ts',
    ]);
  });
});

describe('the preview receiver in commands/ps.ts', () => {
  it('reaches no part of the retiring commands/sessions.ts, statically or through a dynamic import', () => {
    const psCommand = path.join(srcRoot, 'commands', 'ps.ts');
    const seen = new Set<string>();
    const stack = [psCommand];
    while (stack.length) {
      const file = stack.pop()!;
      if (seen.has(file) || !fs.existsSync(file)) continue;
      seen.add(file);
      stack.push(...runtimeImports(file).map(({ dep }) => dep));
    }
    expect(seen.size).toBeGreaterThan(5);
    expect(seen.has(sessionsCommand)).toBe(false);
  });
});

describe('commands/sessions.ts no longer serves extracted selectors, rows, picker or resume helpers', async () => {
  const movedExports = [
    ...Object.keys(await import('./selection.js')),
    ...Object.keys(await import('./resume-command.js')),
    ...Object.keys(await import('./presentation.js')),
    ...Object.keys(await import('../../commands/sessions-picker.js')),
    ...Object.keys(await import('../../commands/ps.js')),
  ];

  it('does not re-export the selection, resume-command or picker modules', () => {
    expect(fs.readFileSync(sessionsCommand, 'utf-8')).not.toMatch(/export\s+(\*|\{[^}]*\})\s+from\s+'(\.\.\/lib\/session\/(selection|resume-command)|\.\/sessions-picker)\.js'/);
  });

  it('no source or test imports a moved export from commands/sessions', () => {
    const offenders = sourceFiles(srcRoot).flatMap((file) =>
      namesImportedFrom(file, sessionsCommand)
        .filter((name) => movedExports.includes(name))
        .map((name) => `${path.relative(srcRoot, file)}: ${name}`));
    expect(offenders).toEqual([]);
  });
});
