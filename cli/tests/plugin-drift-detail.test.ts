import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describePluginDrift } from '../src/lib/doctor-diff.js';
import type { DiscoveredPlugin } from '../src/lib/types.js';

let TMP: string;
let centralRoot: string;
let mirrorDir: string;

function plugin(version: string): DiscoveredPlugin {
  return { name: 'code', root: centralRoot, manifest: { version } } as unknown as DiscoveredPlugin;
}

function writePluginTree(root: string, version: string, skills: string[], commands: string[], opts: { badSkillsField?: boolean } = {}): void {
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  const manifest: Record<string, unknown> = { name: 'code', version };
  if (opts.badSkillsField) manifest.skills = skills;
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2));
  for (const s of skills) {
    fs.mkdirSync(path.join(root, 'skills', s), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', s, 'SKILL.md'), `# ${s}\n`);
  }
  fs.mkdirSync(path.join(root, 'commands'), { recursive: true });
  for (const c of commands) fs.writeFileSync(path.join(root, 'commands', `${c}.md`), `# ${c}\n`);
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-drift-'));
  centralRoot = path.join(TMP, 'central');
  mirrorDir = path.join(TMP, 'mirror');
});
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('describePluginDrift', () => {
  it('returns null when the mirror faithfully matches source', () => {
    writePluginTree(centralRoot, '0.7.0', ['loop', 'review'], ['commit']);
    writePluginTree(mirrorDir, '0.7.0', ['loop', 'review'], ['commit']);
    expect(describePluginDrift(plugin('0.7.0'), mirrorDir)).toBeNull();
  });

  it('reports a stale mirror version', () => {
    writePluginTree(centralRoot, '0.7.0', ['loop'], ['commit']);
    writePluginTree(mirrorDir, '0.6.1', ['loop'], ['commit']);
    expect(describePluginDrift(plugin('0.7.0'), mirrorDir)).toBe('0.6.1→0.7.0');
  });

  it('names skills the mirror is missing', () => {
    writePluginTree(centralRoot, '0.7.0', ['loop', 'ship', 'learn'], ['commit']);
    writePluginTree(mirrorDir, '0.7.0', ['loop'], ['commit']);
    expect(describePluginDrift(plugin('0.7.0'), mirrorDir)).toBe('missing skills: learn, ship');
  });

  it('names commands the mirror is missing', () => {
    writePluginTree(centralRoot, '0.7.0', ['loop'], ['commit', 'ship']);
    writePluginTree(mirrorDir, '0.7.0', ['loop'], ['commit']);
    expect(describePluginDrift(plugin('0.7.0'), mirrorDir)).toBe('missing command: ship');
  });

  it('flags an invalid (bare-name skills) mirror manifest', () => {
    writePluginTree(centralRoot, '0.6.1', ['loop'], ['commit']);
    writePluginTree(mirrorDir, '0.6.1', ['loop'], ['commit'], { badSkillsField: true });
    expect(describePluginDrift(plugin('0.6.1'), mirrorDir)).toBe('invalid manifest');
  });

  it('combines version + missing-content into one detail string', () => {
    writePluginTree(centralRoot, '0.7.0', ['loop', 'ship'], ['commit', 'learn']);
    writePluginTree(mirrorDir, '0.6.1', ['loop'], ['commit']);
    expect(describePluginDrift(plugin('0.7.0'), mirrorDir)).toBe('0.6.1→0.7.0, missing skill: ship, missing command: learn');
  });

  it('reports a wholly absent mirror', () => {
    writePluginTree(centralRoot, '0.7.0', ['loop'], ['commit']);
    expect(describePluginDrift(plugin('0.7.0'), path.join(TMP, 'nope'))).toBe('mirror missing');
  });
});
