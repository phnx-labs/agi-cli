
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions } from '../src/lib/agent-spec/primitives';

const VERSION_FILE = /^\d[\w.+-]*\.md$/;

export function buildAggregate(versions: { version: string; body: string }[]): string {
  const sorted = [...versions].sort((a, b) => compareVersions(b.version, a.version));
  const sections = sorted.map((v) => `## ${v.version}\n\n${v.body.trim()}`);
  return `# Changelog\n\n${sections.join('\n\n')}\n`;
}

export function generate(changelogDir: string): string {
  const versions: { version: string; body: string }[] = [];
  for (const name of readdirSync(changelogDir)) {
    if (!VERSION_FILE.test(name)) continue;
    const full = join(changelogDir, name);
    if (!statSync(full).isFile()) continue;
    versions.push({ version: name.slice(0, -3), body: readFileSync(full, 'utf-8') });
  }
  return buildAggregate(versions);
}

if ((import.meta as { main?: boolean }).main) {
  const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const out = generate(join(cliRoot, '.changelog'));
  writeFileSync(join(cliRoot, 'CHANGELOG.md'), out);
  console.log(`gen-changelog: wrote CHANGELOG.md (${out.length} bytes)`);
}
