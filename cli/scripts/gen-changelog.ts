// Generate the aggregate CHANGELOG.md from `.changelog/` (`bun scripts/gen-changelog.ts` or `npm
// run changelog`): `<version>.md` per shipped version, `next/<slug>.md` per unreleased PR.
// Ordering reuses the CLI's `compareVersions`.

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions } from '../src/lib/agent-spec/primitives';

/** A version filename is `X.Y[.Z][-pre.N].md` — starts with a digit. */
const VERSION_FILE = /^\d[\w.+-]*\.md$/;

/** Assemble the aggregate body from parsed version sections, newest-first. Pure (no I/O) so sort
 * order is unit-testable; released versions only. */
export function buildAggregate(versions: { version: string; body: string }[]): string {
  const sorted = [...versions].sort((a, b) => compareVersions(b.version, a.version));
  const sections = sorted.map((v) => `## ${v.version}\n\n${v.body.trim()}`);
  return `# Changelog\n\n${sections.join('\n\n')}\n`;
}

/** Read the released per-version files from `.changelog/` and produce the aggregate. */
export function generate(changelogDir: string): string {
  const versions: { version: string; body: string }[] = [];
  for (const name of readdirSync(changelogDir)) {
    if (!VERSION_FILE.test(name)) continue; // skips `next/`, README, dotfiles
    const full = join(changelogDir, name);
    if (!statSync(full).isFile()) continue;
    versions.push({ version: name.slice(0, -3), body: readFileSync(full, 'utf-8') });
  }
  return buildAggregate(versions);
}

// CLI entry — only when executed directly (bun sets import.meta.main; under
// vitest/node it is falsy, so importing buildAggregate/generate has no side effect).
if ((import.meta as { main?: boolean }).main) {
  const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const out = generate(join(cliRoot, '.changelog'));
  writeFileSync(join(cliRoot, 'CHANGELOG.md'), out);
  console.log(`gen-changelog: wrote CHANGELOG.md (${out.length} bytes)`);
}
