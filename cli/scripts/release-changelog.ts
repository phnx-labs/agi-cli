
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from './gen-changelog';

const version = process.argv[2];
if (!version) {
  console.error('release-changelog: usage: release-changelog <version>');
  process.exit(2);
}

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const changelogDir = join(cliRoot, '.changelog');
const nextDir = join(changelogDir, 'next');

const fragments = existsSync(nextDir)
  ? readdirSync(nextDir)
      .filter((n) => n.endsWith('.md') && n !== 'README.md')
      .sort()
      .map((n) => ({ name: n, body: readFileSync(join(nextDir, n), 'utf-8').trim() }))
      .filter((f) => f.body)
  : [];

if (fragments.length === 0) {
  console.error(
    `release-changelog: queue empty — add a note at .changelog/next/<ticket>.md before releasing ${version}`,
  );
  process.exit(1);
}

const notes = fragments.map((f) => f.body).join('\n\n');
writeFileSync(join(changelogDir, `${version}.md`), `${notes}\n`);
for (const f of fragments) rmSync(join(nextDir, f.name));

writeFileSync(join(cliRoot, 'CHANGELOG.md'), generate(changelogDir));

process.stdout.write(notes);
