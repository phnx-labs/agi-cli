/** Tests for subagent soft-delete (prune): removeSubagentFromVersion trashes orphans (Claude +
 * OpenClaw), diffVersionSubagents detects orphans against the discovered set, listSubagentsForAgent
 * finds both formats. No mocking: real temp dirs, cleaned up in finally. */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

import {
  removeSubagentFromVersion,
  listSubagentsForAgent,
  transformSubagentForClaude,
  syncSubagentToOpenclaw,
  parseSubagentFrontmatter,
} from '../subagents.js';
import { getVersionsDir, getTrashSubagentsDir } from '../state.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
function mkTemp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

/** Build a minimal subagent source directory with AGENT.md frontmatter. */
function makeSubagentSourceDir(base: string, name: string, description = 'Test agent'): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'AGENT.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nInstructions here.`,
  );
  return dir;
}

// ── removeSubagentFromVersion — Claude format ─────────────────────────────────

describe('removeSubagentFromVersion (claude)', () => {
  it('soft-deletes a Claude subagent .md file to trash and returns success', () => {
    const agent = 'claude';
    const testVersion = `0.0.0-test-${crypto.randomBytes(4).toString('hex')}`;
    const versionDir = path.join(getVersionsDir(), agent, testVersion);
    const agentsDir = path.join(versionDir, 'home', '.claude', 'agents');
    const subagentName = 'my-researcher';
    const agentFile = path.join(agentsDir, `${subagentName}.md`);
    const trashDir = path.join(getTrashSubagentsDir(), agent, testVersion, subagentName);

    try {
      // Set up a fake Claude agents dir with a subagent file.
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(
        agentFile,
        '---\nname: my-researcher\ndescription: Research agent\n---\n\nDo research.',
      );

      const result = removeSubagentFromVersion(agent, testVersion, subagentName);
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();

      // Original file is gone.
      expect(fs.existsSync(agentFile)).toBe(false);

      // Trash received exactly one timestamped copy of the .md file.
      expect(fs.existsSync(trashDir)).toBe(true);
      const entries = fs.readdirSync(trashDir);
      expect(entries.length).toBe(1);
      // Entry should be named {subagentName}.md.{timestamp}
      expect(entries[0]).toMatch(new RegExp(`^${subagentName}\\.md\\.`));
    } finally {
      if (fs.existsSync(versionDir)) {
        fs.rmSync(versionDir, { recursive: true, force: true });
      }
      if (fs.existsSync(trashDir)) {
        fs.rmSync(trashDir, { recursive: true, force: true });
      }
    }
  });

  it('returns success when Claude subagent file does not exist (idempotent)', () => {
    const agent = 'claude';
    const testVersion = `0.0.0-test-${crypto.randomBytes(4).toString('hex')}`;

    // No setup — the file simply does not exist.
    const result = removeSubagentFromVersion(agent, testVersion, 'ghost-agent');
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('trash structure is ~/.agents/.trash/subagents/{agent}/{version}/{name}/{name}.md.{stamp}', () => {
    const agent = 'claude';
    const testVersion = `0.0.0-test-${crypto.randomBytes(4).toString('hex')}`;
    const versionDir = path.join(getVersionsDir(), agent, testVersion);
    const agentsDir = path.join(versionDir, 'home', '.claude', 'agents');
    const subagentName = 'writer';
    const agentFile = path.join(agentsDir, `${subagentName}.md`);
    const expectedTrashDir = path.join(getTrashSubagentsDir(), agent, testVersion, subagentName);

    try {
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(agentFile, '---\nname: writer\ndescription: Write stuff\n---\n\nWrite.');

      removeSubagentFromVersion(agent, testVersion, subagentName);

      expect(fs.existsSync(expectedTrashDir)).toBe(true);
      const entries = fs.readdirSync(expectedTrashDir);
      expect(entries.length).toBe(1);
      // Stamp format: ISO datetime with colons/dots replaced by dashes.
      const stamp = entries[0].replace(`${subagentName}.md.`, '');
      expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
    } finally {
      if (fs.existsSync(versionDir)) {
        fs.rmSync(versionDir, { recursive: true, force: true });
      }
      if (fs.existsSync(expectedTrashDir)) {
        fs.rmSync(expectedTrashDir, { recursive: true, force: true });
      }
    }
  });
});

// ── removeSubagentFromVersion — OpenClaw format ───────────────────────────────

describe('removeSubagentFromVersion (openclaw)', () => {
  it('soft-deletes an OpenClaw subagent directory to trash and returns success', () => {
    const agent = 'openclaw';
    const testVersion = `0.0.0-test-${crypto.randomBytes(4).toString('hex')}`;
    const versionDir = path.join(getVersionsDir(), agent, testVersion);
    const openclawDir = path.join(versionDir, 'home', '.openclaw');
    const subagentName = 'my-coder';
    const subagentDir = path.join(openclawDir, subagentName);
    const trashDir = path.join(getTrashSubagentsDir(), agent, testVersion, subagentName);

    try {
      // Set up a fake OpenClaw subagent directory with AGENTS.md.
      fs.mkdirSync(subagentDir, { recursive: true });
      fs.writeFileSync(
        path.join(subagentDir, 'AGENTS.md'),
        '---\nname: my-coder\ndescription: Coding agent\n---\n\nWrite code.',
      );
      fs.writeFileSync(
        path.join(subagentDir, 'extra.md'),
        '# Extra file',
      );

      const result = removeSubagentFromVersion(agent, testVersion, subagentName);
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();

      // Original directory is gone.
      expect(fs.existsSync(subagentDir)).toBe(false);

      // Trash received one timestamped subdirectory containing the full directory.
      expect(fs.existsSync(trashDir)).toBe(true);
      const stamps = fs.readdirSync(trashDir);
      expect(stamps.length).toBe(1);

      // The renamed directory (at trashDir/stamp) is the original subagent dir
      // containing both files.
      const trashedContents = path.join(trashDir, stamps[0]);
      // OpenClaw: the entire directory was moved, so AGENTS.md should be inside.
      expect(fs.existsSync(path.join(trashedContents, 'AGENTS.md'))).toBe(true);
      expect(fs.existsSync(path.join(trashedContents, 'extra.md'))).toBe(true);
    } finally {
      if (fs.existsSync(versionDir)) {
        fs.rmSync(versionDir, { recursive: true, force: true });
      }
      if (fs.existsSync(trashDir)) {
        fs.rmSync(trashDir, { recursive: true, force: true });
      }
    }
  });

  it('returns success when OpenClaw subagent directory does not exist (idempotent)', () => {
    const agent = 'openclaw';
    const testVersion = `0.0.0-test-${crypto.randomBytes(4).toString('hex')}`;

    const result = removeSubagentFromVersion(agent, testVersion, 'nonexistent-agent');
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

// ── listSubagentsForAgent ─────────────────────────────────────────────────────

describe('listSubagentsForAgent', () => {
  it('discovers Claude subagents from flat .md files in .claude/agents/', () => {
    const home = mkTemp('subagents-claude-list-');
    const agentsDir = path.join(home, '.claude', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    // Write two valid subagent .md files.
    fs.writeFileSync(
      path.join(agentsDir, 'researcher.md'),
      '---\nname: researcher\ndescription: Research agent\n---\n\nDo research.',
    );
    fs.writeFileSync(
      path.join(agentsDir, 'writer.md'),
      '---\nname: writer\ndescription: Writing agent\n---\n\nWrite things.',
    );

    // Non-.md file should be ignored.
    fs.writeFileSync(path.join(agentsDir, 'ignore.txt'), 'not an agent');

    const subagents = listSubagentsForAgent('claude', home);

    expect(subagents).toHaveLength(2);
    const names = subagents.map(s => s.name).sort();
    expect(names).toEqual(['researcher', 'writer']);
  });

  it('skips Claude .md files without valid frontmatter', () => {
    const home = mkTemp('subagents-claude-nofront-');
    const agentsDir = path.join(home, '.claude', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    // Valid file.
    fs.writeFileSync(
      path.join(agentsDir, 'valid.md'),
      '---\nname: valid\ndescription: OK\n---\n\nInstructions.',
    );
    // File with no frontmatter.
    fs.writeFileSync(
      path.join(agentsDir, 'no-front.md'),
      'Just plain markdown without frontmatter.',
    );

    const subagents = listSubagentsForAgent('claude', home);

    expect(subagents).toHaveLength(1);
    expect(subagents[0].name).toBe('valid');
  });

  it('returns empty array when .claude/agents/ does not exist', () => {
    const home = mkTemp('subagents-claude-empty-');
    // Do NOT create .claude/agents/

    const subagents = listSubagentsForAgent('claude', home);
    expect(subagents).toEqual([]);
  });

  it('discovers OpenClaw subagents from .openclaw/{name}/AGENTS.md directories', () => {
    const home = mkTemp('subagents-openclaw-list-');
    const openclawDir = path.join(home, '.openclaw');

    // Set up two valid OpenClaw subagent directories.
    for (const name of ['coder', 'reviewer']) {
      const dir = path.join(openclawDir, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'AGENTS.md'),
        `---\nname: ${name}\ndescription: ${name} agent\n---\n\nInstructions.`,
      );
    }

    // A directory without AGENTS.md should be skipped.
    const emptyDir = path.join(openclawDir, 'no-agents-md');
    fs.mkdirSync(emptyDir, { recursive: true });
    fs.writeFileSync(path.join(emptyDir, 'something.txt'), 'not an agent');

    // A file (not a directory) should be skipped.
    fs.writeFileSync(path.join(openclawDir, 'flat-file.md'), 'flat');

    const subagents = listSubagentsForAgent('openclaw', home);

    expect(subagents).toHaveLength(2);
    const names = subagents.map(s => s.name).sort();
    expect(names).toEqual(['coder', 'reviewer']);
  });

  it('parses frontmatter from OpenClaw AGENTS.md when present', () => {
    const home = mkTemp('subagents-openclaw-front-');
    const dir = path.join(home, '.openclaw', 'my-agent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '---\nname: my-agent\ndescription: Custom desc\n---\n\nInstructions.',
    );

    const subagents = listSubagentsForAgent('openclaw', home);
    expect(subagents).toHaveLength(1);
    expect(subagents[0].frontmatter.name).toBe('my-agent');
    expect(subagents[0].frontmatter.description).toBe('Custom desc');
  });

  it('falls back to first content line as description when OpenClaw AGENTS.md has no frontmatter', () => {
    const home = mkTemp('subagents-openclaw-nofm-');
    const dir = path.join(home, '.openclaw', 'bare-agent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '\nThis is the description line.\n\nMore content here.',
    );

    const subagents = listSubagentsForAgent('openclaw', home);
    expect(subagents).toHaveLength(1);
    expect(subagents[0].frontmatter.description).toBe('This is the description line.');
  });

  it('returns empty array when .openclaw/ does not exist', () => {
    const home = mkTemp('subagents-openclaw-empty-');
    // Do NOT create .openclaw/

    const subagents = listSubagentsForAgent('openclaw', home);
    expect(subagents).toEqual([]);
  });
});

// ── transformSubagentForClaude ────────────────────────────────────────────────

describe('transformSubagentForClaude', () => {
  it('produces valid Claude .md with YAML frontmatter + body', () => {
    const base = mkTemp('subagents-transform-');
    const subagentDir = makeSubagentSourceDir(base, 'coder', 'Coding specialist');

    const result = transformSubagentForClaude(subagentDir);

    // Must start with ---
    expect(result.startsWith('---\n')).toBe(true);
    // Must include name and description from frontmatter
    expect(result).toContain('name: coder');
    expect(result).toContain('description: Coding specialist');
    // Must include the body text
    expect(result).toContain('Instructions here.');
  });

  it('appends additional .md files as titled sections', () => {
    const base = mkTemp('subagents-transform-extra-');
    const subagentDir = makeSubagentSourceDir(base, 'tester');
    // Add an extra .md file.
    fs.writeFileSync(
      path.join(subagentDir, 'SOUL.md'),
      'Be thorough. Be honest.',
    );

    const result = transformSubagentForClaude(subagentDir);

    // SOUL.md should appear as a section.
    expect(result).toContain('## Soul');
    expect(result).toContain('Be thorough. Be honest.');
  });

  it('throws when AGENT.md has no valid frontmatter', () => {
    const base = mkTemp('subagents-transform-nofront-');
    const dir = path.join(base, 'bad-agent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'AGENT.md'), 'No frontmatter here.');

    expect(() => transformSubagentForClaude(dir)).toThrow();
  });
});

// ── syncSubagentToOpenclaw ────────────────────────────────────────────────────

describe('syncSubagentToOpenclaw', () => {
  it('copies all files and renames AGENT.md to AGENTS.md', () => {
    const base = mkTemp('subagents-sync-openclaw-');
    const subagentDir = makeSubagentSourceDir(base, 'analyst');
    // Add an extra file.
    fs.writeFileSync(path.join(subagentDir, 'SOUL.md'), 'Soul content.');

    const targetDir = path.join(base, 'target');

    const result = syncSubagentToOpenclaw(subagentDir, targetDir);

    expect(result.success).toBe(true);
    // AGENT.md renamed to AGENTS.md.
    expect(fs.existsSync(path.join(targetDir, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'AGENT.md'))).toBe(false);
    // Extra file preserved.
    expect(fs.existsSync(path.join(targetDir, 'SOUL.md'))).toBe(true);
  });

  it('creates the target directory if it does not exist', () => {
    const base = mkTemp('subagents-sync-mkdir-');
    const subagentDir = makeSubagentSourceDir(base, 'builder');
    const targetDir = path.join(base, 'deep', 'nested', 'target');

    const result = syncSubagentToOpenclaw(subagentDir, targetDir);

    expect(result.success).toBe(true);
    expect(fs.existsSync(targetDir)).toBe(true);
  });
});

// ── parseSubagentFrontmatter edge cases ──────────────────────────────────────

describe('parseSubagentFrontmatter', () => {
  it('returns null for a non-existent file', () => {
    expect(parseSubagentFrontmatter('/tmp/absolutely-does-not-exist.md')).toBeNull();
  });

  it('returns null when file has no YAML frontmatter block', () => {
    const dir = mkTemp('subagents-fm-');
    const filePath = path.join(dir, 'plain.md');
    fs.writeFileSync(filePath, '# No frontmatter\n\nJust content.');

    expect(parseSubagentFrontmatter(filePath)).toBeNull();
  });

  it('parses optional model and color fields when present', () => {
    const dir = mkTemp('subagents-fm-optional-');
    const filePath = path.join(dir, 'full.md');
    fs.writeFileSync(
      filePath,
      '---\nname: full\ndescription: Full agent\nmodel: claude-opus-4-5\ncolor: blue\n---\n\nBody.',
    );

    const result = parseSubagentFrontmatter(filePath);
    expect(result).not.toBeNull();
    expect(result!.model).toBe('claude-opus-4-5');
    expect(result!.color).toBe('blue');
  });

  it('returns null when frontmatter block is not properly closed', () => {
    const dir = mkTemp('subagents-fm-unclosed-');
    const filePath = path.join(dir, 'unclosed.md');
    fs.writeFileSync(filePath, '---\nname: broken\ndescription: No closing\nContent starts here.');

    expect(parseSubagentFrontmatter(filePath)).toBeNull();
  });
});
