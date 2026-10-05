import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installGooseCommandToVersion,
  listGooseCommandsInVersion,
  gooseCommandMatches,
  removeGooseCommandFromVersion,
  gooseCommandsDir,
  gooseCommandConfigPath,
} from './goose-commands.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-goose-cmd-'));
  tempDirs.push(dir);
  return dir;
}

function writeSource(dir: string, name: string, content: string): string {
  const p = path.join(dir, `${name}.md`);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function readConfig(versionHome: string): { slash_commands?: Array<{ command: string; recipe_path: string }>; [k: string]: unknown } {
  return yaml.parse(fs.readFileSync(gooseCommandConfigPath(versionHome), 'utf-8'));
}

describe('installGooseCommandToVersion', () => {
  it('writes a recipe YAML and registers a slash_commands entry pointing at it', () => {
    const src = makeTempDir();
    const versionHome = makeTempDir();
    const sourcePath = writeSource(src, 'deploy', '---\ndescription: Deploy the app\n---\nRun the deploy for $ARGUMENTS.');

    const r = installGooseCommandToVersion(versionHome, 'deploy', sourcePath);
    expect(r.success).toBe(true);

    const recipePath = path.join(gooseCommandsDir(versionHome), 'deploy.yaml');
    expect(fs.existsSync(recipePath)).toBe(true);
    expect(gooseCommandsDir(versionHome).endsWith(path.join('.config', 'goose', 'commands'))).toBe(true);

    const recipe = yaml.parse(fs.readFileSync(recipePath, 'utf-8')) as { version: string; title: string; description: string; prompt: string };
    expect(recipe.version).toBe('1.0.0');
    expect(recipe.title).toBe('deploy');
    expect(recipe.description).toBe('Deploy the app');
    expect(recipe.prompt).toContain('Run the deploy for $ARGUMENTS.');

    const config = readConfig(versionHome);
    expect(config.slash_commands).toEqual([{ command: 'deploy', recipe_path: recipePath }]);
  });

  it('preserves existing config keys and other slash_commands, sorted by command', () => {
    const src = makeTempDir();
    const versionHome = makeTempDir();
    const configPath = gooseCommandConfigPath(versionHome);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, yaml.stringify({
      model: 'gpt-5',
      mcp_servers: { ctx: { command: 'ctx' } },
      slash_commands: [{ command: 'zeta', recipe_path: '/x/zeta.yaml' }],
    }), 'utf-8');

    installGooseCommandToVersion(versionHome, 'alpha', writeSource(src, 'alpha', '---\ndescription: A\n---\nDo A.'));

    const config = readConfig(versionHome);
    expect(config.model).toBe('gpt-5');
    expect(config.mcp_servers).toEqual({ ctx: { command: 'ctx' } });
    expect(config.slash_commands?.map(e => e.command)).toEqual(['alpha', 'zeta']);
  });

  it('refuses to clobber a pre-existing but unparseable config.yaml (fails, preserves the file)', () => {
    const src = makeTempDir();
    const versionHome = makeTempDir();
    const configPath = gooseCommandConfigPath(versionHome);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const badContent = 'mcp_servers:\n  ctx:\n    command: ctx\n\tbad: [unclosed\n';
    fs.writeFileSync(configPath, badContent, 'utf-8');

    const r = installGooseCommandToVersion(versionHome, 'deploy', writeSource(src, 'deploy', '---\ndescription: D\n---\nDo D.'));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not valid YAML|Refusing to rewrite/);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(badContent);
  });

  it('is idempotent — re-installing the same command does not duplicate entries', () => {
    const src = makeTempDir();
    const versionHome = makeTempDir();
    const sourcePath = writeSource(src, 'plan', '---\ndescription: Plan\n---\nPlan it.');
    installGooseCommandToVersion(versionHome, 'plan', sourcePath);
    installGooseCommandToVersion(versionHome, 'plan', sourcePath);
    expect(readConfig(versionHome).slash_commands).toHaveLength(1);
  });
});

describe('listGooseCommandsInVersion + gooseCommandMatches', () => {
  it('lists installed commands and matches only when recipe + registration are current', () => {
    const src = makeTempDir();
    const versionHome = makeTempDir();
    const sourcePath = writeSource(src, 'recap', '---\ndescription: Recap\n---\nRecap the session.');
    installGooseCommandToVersion(versionHome, 'recap', sourcePath);

    expect(listGooseCommandsInVersion(versionHome)).toEqual(['recap']);
    expect(gooseCommandMatches(versionHome, 'recap', sourcePath)).toBe(true);

    fs.writeFileSync(sourcePath, '---\ndescription: Recap\n---\nRecap EVERYTHING now.', 'utf-8');
    expect(gooseCommandMatches(versionHome, 'recap', sourcePath)).toBe(false);
  });

  it('does not match when the slash_commands registration is missing even if the recipe exists', () => {
    const src = makeTempDir();
    const versionHome = makeTempDir();
    const sourcePath = writeSource(src, 'x', '---\ndescription: X\n---\nDo X.');
    installGooseCommandToVersion(versionHome, 'x', sourcePath);
    fs.writeFileSync(gooseCommandConfigPath(versionHome), yaml.stringify({ model: 'gpt-5' }), 'utf-8');
    expect(gooseCommandMatches(versionHome, 'x', sourcePath)).toBe(false);
  });
});

describe('removeGooseCommandFromVersion', () => {
  it('deletes the recipe, unregisters the slash_commands entry, and preserves other keys', () => {
    const src = makeTempDir();
    const versionHome = makeTempDir();
    installGooseCommandToVersion(versionHome, 'a', writeSource(src, 'a', '---\ndescription: A\n---\nA.'));
    installGooseCommandToVersion(versionHome, 'b', writeSource(src, 'b', '---\ndescription: B\n---\nB.'));

    const r = removeGooseCommandFromVersion(versionHome, 'a');
    expect(r.success).toBe(true);
    expect(fs.existsSync(path.join(gooseCommandsDir(versionHome), 'a.yaml'))).toBe(false);
    expect(readConfig(versionHome).slash_commands?.map(e => e.command)).toEqual(['b']);
  });

  it('drops the slash_commands key entirely when removing the last command', () => {
    const src = makeTempDir();
    const versionHome = makeTempDir();
    installGooseCommandToVersion(versionHome, 'only', writeSource(src, 'only', '---\ndescription: O\n---\nO.'));
    removeGooseCommandFromVersion(versionHome, 'only');
    const config = readConfig(versionHome);
    expect(config.slash_commands).toBeUndefined();
  });

  it('soft-deletes the recipe to the trash dir when one is provided', () => {
    const src = makeTempDir();
    const versionHome = makeTempDir();
    const trash = path.join(makeTempDir(), 'trash');
    installGooseCommandToVersion(versionHome, 'c', writeSource(src, 'c', '---\ndescription: C\n---\nC.'));
    removeGooseCommandFromVersion(versionHome, 'c', trash);
    expect(fs.existsSync(path.join(gooseCommandsDir(versionHome), 'c.yaml'))).toBe(false);
    const trashed = fs.readdirSync(trash);
    expect(trashed).toHaveLength(1);
    expect(trashed[0]).toMatch(/^c\.yaml\.\d{4}-\d{2}-\d{2}T/);
  });
});
