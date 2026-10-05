import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { commandAppliesTo, parseCommandMetadata } from './commands.js';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-commands-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runCommandsExpression(home: string, expression: string): unknown {
  const moduleUrl = pathToFileURL(path.resolve('src/lib/commands.ts')).href;
  const tsxBin = path.resolve('node_modules/.bin/tsx');
  const child = spawnSync(tsxBin, ['-e', `
    import {
      diffVersionCommands,
      installCommand,
      installCommandToVersion,
      listCommandsInVersionHome,
      listPluginCommandNames,
      removeCommandFromVersion,
    } from ${JSON.stringify(moduleUrl)};
    const home = ${JSON.stringify(home)};
    const result = ${expression};
    console.log(JSON.stringify(result));
  `], {
    env: { ...process.env, HOME: home },
    encoding: 'utf-8',
  });

  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim());
}

function scaffoldInstalledVersion(home: string, agent: string, version: string): void {
  const cliCommand = agent;
  const binaryDir = path.join(home, '.agents', '.history', 'versions', agent, version, 'node_modules', '.bin');
  fs.mkdirSync(binaryDir, { recursive: true });
  fs.writeFileSync(path.join(binaryDir, cliCommand), '#!/bin/sh\necho fake', 'utf-8');
  fs.chmodSync(path.join(binaryDir, cliCommand), 0o755);
}

function writeSystemCommand(home: string, name: string, content: string): string {
  const dir = path.join(home, '.agents', '.system', 'commands');
  fs.mkdirSync(dir, { recursive: true });
  const source = path.join(dir, `${name}.md`);
  fs.writeFileSync(source, content, 'utf-8');
  return source;
}

function trashCommandsDir(home: string): string {
  return path.join(home, '.agents', '.history', 'trash', 'commands');
}

function versionHomePath(home: string, agent: string, version: string): string {
  return path.join(home, '.agents', '.history', 'versions', agent, version, 'home');
}

describe('commandAppliesTo()', () => {
  it('excludes agents not listed in frontmatter', () => {
    expect(commandAppliesTo('cursor', '1.0.0', { agents: ['claude'] })).toEqual({
      ok: false,
      reason: 'agent_excluded',
    });
  });

  it('passes when agent is listed', () => {
    expect(commandAppliesTo('claude', '2.0.0', { agents: ['claude', 'codex'] })).toEqual({ ok: true });
  });

  it('gates codex versions with since/until on the command', () => {
    const meta = { agents: ['codex' as const], since: '0.117.0', until: '0.118.0' };
    expect(commandAppliesTo('codex', '0.116.0', meta).ok).toBe(false);
    expect(commandAppliesTo('codex', '0.117.0', meta)).toEqual({ ok: true });
    expect(commandAppliesTo('codex', '0.118.0', meta).ok).toBe(false);
  });
});

describe('command frontmatter install gating', () => {
  it('skips install when agents list excludes the target', () => {
    const home = makeTempHome();
    writeSystemCommand(home, 'version', `---
description: Show versions
agents: [claude]
---
Report versions.`);
    scaffoldInstalledVersion(home, 'codex', '0.116.0');

    const result = runCommandsExpression(
      home,
      "installCommandToVersion('codex', '0.116.0', 'version')"
    ) as { success: boolean; skipped?: boolean };

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    const commandsDir = path.join(versionHomePath(home, 'codex', '0.116.0'), '.codex', 'prompts');
    expect(fs.existsSync(path.join(commandsDir, 'version.md'))).toBe(false);
  });

  it('omits excluded commands from diffVersionCommands toAdd', () => {
    const home = makeTempHome();
    writeSystemCommand(home, 'version', `---
description: Show versions
agents: [claude]
---
Report versions.`);
    scaffoldInstalledVersion(home, 'codex', '0.116.0');

    const diff = runCommandsExpression(home, "diffVersionCommands('codex', '0.116.0')") as {
      toAdd: string[];
    };
    expect(diff.toAdd).not.toContain('version');
  });

  it('flags excluded but installed commands as toRemove', () => {
    const home = makeTempHome();
    writeSystemCommand(home, 'version', `---
description: Show versions
agents: [claude]
---
Report versions.`);
    scaffoldInstalledVersion(home, 'codex', '0.116.0');

    const commandsDir = path.join(versionHomePath(home, 'codex', '0.116.0'), '.codex', 'prompts');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'version.md'), 'Report versions.', 'utf-8');

    const diff = runCommandsExpression(home, "diffVersionCommands('codex', '0.116.0')") as {
      toRemove: string[];
      toAdd: string[];
    };
    expect(diff.toRemove).toEqual(['version']);
    expect(diff.toAdd).not.toContain('version');
  });
});

describe('diffVersionCommands — plugin-bundled commands are source-managed', () => {
  function writePluginCommand(home: string, plugin: string, cmd: string): void {
    const root = path.join(home, '.agents', 'plugins', plugin);
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: plugin, version: '1.0.0', description: `${plugin} plugin` }),
    );
    fs.mkdirSync(path.join(root, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(root, 'commands', `${cmd}.md`), `# /${plugin}-${cmd}\n`, 'utf-8');
  }

  it('listPluginCommandNames flattens plugin commands to <plugin>-<command>', () => {
    const home = makeTempHome();
    writePluginCommand(home, 'swarm', 'plan');
    const names = runCommandsExpression(home, '[...listPluginCommandNames()]') as string[];
    expect(names).toContain('swarm-plan');
  });

  it('does NOT flag a plugin-provided command-skill as an orphan', () => {
    const home = makeTempHome();
    writePluginCommand(home, 'swarm', 'plan');
    scaffoldInstalledVersion(home, 'codex', '0.117.0');

    const skillDir = path.join(versionHomePath(home, 'codex', '0.117.0'), '.codex', 'skills', 'swarm-plan');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: "swarm-plan"\ndescription: plan\nagents_command: "swarm-plan"\n---\n\n# /swarm-plan\n`,
      'utf-8',
    );

    const listed = runCommandsExpression(home, "listCommandsInVersionHome('codex', '0.117.0')") as string[];
    const diff = runCommandsExpression(home, "diffVersionCommands('codex', '0.117.0')") as { orphans: string[] };
    expect(listed).toContain('swarm-plan');
    expect(diff.orphans).not.toContain('swarm-plan');
  });
});

describe('version command management', () => {
  it('installs an unmanaged Cursor command to both surfaces through the package installation path', () => {
    const home = makeTempHome();
    const source = writeSystemCommand(
      home,
      'package-command',
      '---\nname: package-command\ndescription: Package command\n---\n\nPackage command body.',
    );

    const installed = runCommandsExpression(
      home,
      `installCommand(${JSON.stringify(source)}, 'cursor', 'package-command', 'copy')`
    ) as { error?: string };

    expect(installed.error).toBeUndefined();
    expect(fs.existsSync(path.join(home, '.cursor', 'commands', 'package-command.md'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.cursor', 'skills', 'package-command', 'SKILL.md'))).toBe(true);
  });

  it('installs and removes Cursor commands from both native and generated-skill surfaces', () => {
    const home = makeTempHome();
    writeSystemCommand(home, 'recap', 'Summarize this session.');

    const installed = runCommandsExpression(home, "installCommandToVersion('cursor', '2026.07.23-e383d2b', 'recap')") as { success: boolean };
    const cursorHome = path.join(versionHomePath(home, 'cursor', '2026.07.23-e383d2b'), '.cursor');

    expect(installed.success).toBe(true);
    expect(fs.existsSync(path.join(cursorHome, 'commands', 'recap.md'))).toBe(true);
    expect(fs.existsSync(path.join(cursorHome, 'skills', 'recap', 'SKILL.md'))).toBe(true);

    const removed = runCommandsExpression(home, "removeCommandFromVersion('cursor', '2026.07.23-e383d2b', 'recap')") as { success: boolean };
    expect(removed.success).toBe(true);
    expect(fs.existsSync(path.join(cursorHome, 'commands', 'recap.md'))).toBe(false);
    expect(fs.existsSync(path.join(cursorHome, 'skills', 'recap', 'SKILL.md'))).toBe(false);
  });

  it('installs, lists, diffs, and removes generated command skills for Codex 0.117.0+', () => {
    const home = makeTempHome();
    writeSystemCommand(home, 'recap', 'Summarize this session.');

    const installed = runCommandsExpression(home, "installCommandToVersion('codex', '0.117.0', 'recap')") as { success: boolean };
    const listed = runCommandsExpression(home, "listCommandsInVersionHome('codex', '0.117.0')") as string[];
    const diff = runCommandsExpression(home, "diffVersionCommands('codex', '0.117.0')") as {
      matched: string[];
      toAdd: string[];
      toUpdate: string[];
      orphans: string[];
    };
    const removed = runCommandsExpression(home, "removeCommandFromVersion('codex', '0.117.0', 'recap')") as { success: boolean };

    const versionHome = path.join(versionHomePath(home, 'codex', '0.117.0'), '.codex');
    expect(installed.success).toBe(true);
    expect(listed).toEqual(['recap']);
    expect(diff).toMatchObject({ matched: ['recap'], toAdd: [], toUpdate: [], toRemove: [], orphans: [] });
    expect(removed.success).toBe(true);
    expect(fs.existsSync(path.join(versionHome, 'skills', 'recap', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(versionHome, 'prompts', 'recap.md'))).toBe(false);
    const trashEntries = fs.existsSync(path.join(trashCommandsDir(home), 'codex', '0.117.0'))
      ? fs.readdirSync(path.join(trashCommandsDir(home), 'codex', '0.117.0'))
      : [];
    expect(trashEntries).toHaveLength(0);
  });
});

describe('Grok native command install', () => {
  it('installs a native .md command to ~/.agents/commands/ (not command-as-skill)', () => {
    const home = makeTempHome();
    writeSystemCommand(home, 'my-cmd', '---\ndescription: Test command\n---\nDo something.');
    scaffoldInstalledVersion(home, 'grok', '0.2.111');

    const installed = runCommandsExpression(home, "installCommandToVersion('grok', '0.2.111', 'my-cmd', 'copy')") as { success: boolean };
    expect(installed.success).toBe(true);

    const commandsDir = path.join(versionHomePath(home, 'grok', '0.2.111'), '.agents', 'commands');
    expect(fs.existsSync(path.join(commandsDir, 'my-cmd.md'))).toBe(true);
    expect(fs.existsSync(path.join(versionHomePath(home, 'grok', '0.2.111'), '.grok', 'skills', 'my-cmd', 'SKILL.md'))).toBe(false);

    const listed = runCommandsExpression(home, "listCommandsInVersionHome('grok', '0.2.111')") as string[];
    expect(listed).toEqual(['my-cmd']);
  });
});

describe('Goose recipe command install (end-to-end via installCommandToVersion)', () => {
  it('installs a command as a Goose recipe YAML + config.yaml slash_commands entry', () => {
    const home = makeTempHome();
    writeSystemCommand(home, 'deploy', '---\ndescription: Deploy the app\n---\nRun the deploy.');
    scaffoldInstalledVersion(home, 'goose', '1.34.0');

    const installed = runCommandsExpression(home, "installCommandToVersion('goose', '1.34.0', 'deploy', 'copy')") as { success: boolean };
    expect(installed.success).toBe(true);

    const versionHome = versionHomePath(home, 'goose', '1.34.0');
    const recipePath = path.join(versionHome, '.config', 'goose', 'commands', 'deploy.yaml');
    expect(fs.existsSync(recipePath)).toBe(true);
    expect(fs.existsSync(path.join(versionHome, '.config', 'goose', 'recipes', 'deploy.yaml'))).toBe(false);

    const config = yaml.parse(fs.readFileSync(path.join(versionHome, '.config', 'goose', 'config.yaml'), 'utf-8')) as { slash_commands?: Array<{ command: string; recipe_path: string }> };
    expect(config.slash_commands).toEqual([{ command: 'deploy', recipe_path: recipePath }]);

    const listed = runCommandsExpression(home, "listCommandsInVersionHome('goose', '1.34.0')") as string[];
    expect(listed).toEqual(['deploy']);
    const diff = runCommandsExpression(home, "diffVersionCommands('goose', '1.34.0')") as { matched: string[]; toAdd: string[]; toUpdate: string[]; orphans: string[] };
    expect(diff).toMatchObject({ matched: ['deploy'], toAdd: [], toUpdate: [], orphans: [] });

    const removed = runCommandsExpression(home, "removeCommandFromVersion('goose', '1.34.0', 'deploy')") as { success: boolean };
    expect(removed.success).toBe(true);
    expect(fs.existsSync(recipePath)).toBe(false);
    const after = yaml.parse(fs.readFileSync(path.join(versionHome, '.config', 'goose', 'config.yaml'), 'utf-8')) as { slash_commands?: unknown };
    expect(after.slash_commands).toBeUndefined();
  });
});

describe('removeCommandFromVersion soft-delete', () => {
  it('moves a .md command to trash for claude instead of deleting it', () => {
    const home = makeTempHome();
    writeSystemCommand(home, 'my-cmd', '---\ndescription: Test command\n---\nDo something.');
    scaffoldInstalledVersion(home, 'claude', '1.0.0');

    runCommandsExpression(home, "installCommandToVersion('claude', '1.0.0', 'my-cmd', 'copy')");

    const commandsDir = path.join(versionHomePath(home, 'claude', '1.0.0'), '.claude', 'commands');
    expect(fs.existsSync(path.join(commandsDir, 'my-cmd.md'))).toBe(true);

    const result = runCommandsExpression(home, "removeCommandFromVersion('claude', '1.0.0', 'my-cmd')") as { success: boolean };
    expect(result.success).toBe(true);

    expect(fs.existsSync(path.join(commandsDir, 'my-cmd.md'))).toBe(false);

    const trashSubDir = path.join(trashCommandsDir(home), 'claude', '1.0.0', 'my-cmd');
    expect(fs.existsSync(trashSubDir)).toBe(true);
    const trashFiles = fs.readdirSync(trashSubDir);
    expect(trashFiles).toHaveLength(1);
    expect(trashFiles[0]).toMatch(/^my-cmd\.md\.\d{4}-\d{2}-\d{2}T/);
    const trashedContent = fs.readFileSync(path.join(trashSubDir, trashFiles[0]), 'utf-8');
    expect(trashedContent).toContain('Do something.');
  });

  it('skips command installs for hard-deprecated gemini', () => {
    const home = makeTempHome();
    writeSystemCommand(home, 'plan', '---\ndescription: Plan something\n---\nPlan the work.');
    scaffoldInstalledVersion(home, 'gemini', '1.0.0');

    const install = runCommandsExpression(home, "installCommandToVersion('gemini', '1.0.0', 'plan', 'copy')") as { success: boolean; skipped?: boolean; skipReason?: string };

    const commandsDir = path.join(versionHomePath(home, 'gemini', '1.0.0'), '.gemini', 'commands');
    expect(install).toEqual({
      success: true,
      skipped: true,
      skipReason: 'gemini@1.0.0: /plan not supported for this agent version',
    });
    expect(fs.existsSync(path.join(commandsDir, 'plan.toml'))).toBe(false);
  });

  it('returns success without touching trash when the command does not exist', () => {
    const home = makeTempHome();
    scaffoldInstalledVersion(home, 'claude', '1.0.0');

    const result = runCommandsExpression(
      home,
      "removeCommandFromVersion('claude', '1.0.0', 'nonexistent')"
    ) as { success: boolean };
    expect(result.success).toBe(true);

    expect(fs.existsSync(path.join(trashCommandsDir(home), 'claude'))).toBe(false);
  });

  it('trash directory structure is <trashCommandsDir>/<agent>/<version>/<commandName>/', () => {
    const home = makeTempHome();
    writeSystemCommand(home, 'scope-test', '---\ndescription: Scope test\n---\nBody.');
    scaffoldInstalledVersion(home, 'claude', '2.0.0');

    runCommandsExpression(home, "installCommandToVersion('claude', '2.0.0', 'scope-test', 'copy')");
    runCommandsExpression(home, "removeCommandFromVersion('claude', '2.0.0', 'scope-test')");

    expect(fs.existsSync(trashCommandsDir(home))).toBe(true);
    expect(fs.existsSync(path.join(trashCommandsDir(home), 'claude'))).toBe(true);
    expect(fs.existsSync(path.join(trashCommandsDir(home), 'claude', '2.0.0'))).toBe(true);
    expect(fs.existsSync(path.join(trashCommandsDir(home), 'claude', '2.0.0', 'scope-test'))).toBe(true);
    const files = fs.readdirSync(path.join(trashCommandsDir(home), 'claude', '2.0.0', 'scope-test'));
    expect(files).toHaveLength(1);
  });
});

describe('diffVersionCommands orphan detection', () => {
  it('reports a command in the version home that is absent from central as an orphan', () => {
    const home = makeTempHome();
    writeSystemCommand(home, 'kept', '---\ndescription: Kept command\n---\nKeep this.');
    scaffoldInstalledVersion(home, 'claude', '1.0.0');
    runCommandsExpression(home, "installCommandToVersion('claude', '1.0.0', 'kept', 'copy')");

    const commandsDir = path.join(versionHomePath(home, 'claude', '1.0.0'), '.claude', 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'orphan.md'), '# orphan', 'utf-8');

    const diff = runCommandsExpression(home, "diffVersionCommands('claude', '1.0.0')") as {
      matched: string[];
      toAdd: string[];
      toUpdate: string[];
      orphans: string[];
    };
    expect(diff.orphans).toEqual(['orphan']);
    expect(diff.matched).toEqual(['kept']);
    expect(diff.toAdd).toEqual([]);
  });
});
