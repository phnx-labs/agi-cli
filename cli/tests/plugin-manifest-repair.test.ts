/** Tests for the Claude-invalid plugin-manifest auto-repair: a bare-name `skills`/`commands` field
 * makes Claude Code silently reject the whole plugin, so the repair strips them. `./` entries stay,
 * the `agents` field is never touched, write-back is idempotent. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  repairableManifestFields,
  repairPluginManifestFile,
} from '../src/lib/plugins/plugin-marketplace.js';

let TMP: string;
let manifestPath: string;

function write(manifest: unknown): void {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}
function read(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-repair-'));
  manifestPath = path.join(TMP, '.claude-plugin', 'plugin.json');
});
afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('repairableManifestFields', () => {
  it('flags a bare-name skills array', () => {
    expect(repairableManifestFields({ name: 'code', skills: ['loop', 'review'] })).toEqual(['skills']);
  });

  it('flags a bare-name string (non-array) commands field', () => {
    expect(repairableManifestFields({ name: 'code', commands: 'commit' })).toEqual(['commands']);
  });

  it('flags both skills and commands when both are bare', () => {
    expect(repairableManifestFields({ skills: ['a'], commands: ['b'] })).toEqual(['skills', 'commands']);
  });

  it('leaves "./"-relative entries alone', () => {
    expect(repairableManifestFields({ skills: ['./skills/loop'], commands: ['./commands/commit'] })).toEqual([]);
  });

  it('never touches the agents field even when bare (agents-cli AgentId[])', () => {
    // ["claude","codex"] is agents-cli's legitimate targeting list, NOT a Claude
    // path field. Stripping it would destroy real metadata.
    expect(repairableManifestFields({ name: 'code', agents: ['claude', 'codex'] })).toEqual([]);
  });

  it('returns [] for a clean manifest', () => {
    expect(repairableManifestFields({ name: 'code', version: '0.7.0' })).toEqual([]);
  });
});

describe('repairPluginManifestFile', () => {
  it('strips the bad field and preserves everything else', () => {
    write({ name: 'code', version: '0.6.1', description: 'd', author: { name: 'x' }, skills: ['loop'] });
    const dropped = repairPluginManifestFile(manifestPath);
    expect(dropped).toEqual(['skills']);
    const after = read();
    expect(after.skills).toBeUndefined();
    expect(after).toMatchObject({ name: 'code', version: '0.6.1', description: 'd', author: { name: 'x' } });
  });

  it('is idempotent — a second pass is a no-op', () => {
    write({ name: 'code', skills: ['loop'] });
    expect(repairPluginManifestFile(manifestPath)).toEqual(['skills']);
    expect(repairPluginManifestFile(manifestPath)).toEqual([]);
  });

  it('dryRun reports the fix without writing', () => {
    write({ name: 'code', skills: ['loop'] });
    const dropped = repairPluginManifestFile(manifestPath, { dryRun: true });
    expect(dropped).toEqual(['skills']);
    expect(read().skills).toEqual(['loop']); // unchanged on disk
  });

  it('does not rewrite a clean manifest', () => {
    write({ name: 'code', version: '0.7.0' });
    const before = fs.statSync(manifestPath).mtimeMs;
    expect(repairPluginManifestFile(manifestPath)).toEqual([]);
    expect(fs.statSync(manifestPath).mtimeMs).toBe(before);
  });

  it('returns [] for a missing file', () => {
    expect(repairPluginManifestFile(path.join(TMP, 'nope.json'))).toEqual([]);
  });

  it('leaves an unparseable manifest untouched', () => {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, '{ not json');
    expect(repairPluginManifestFile(manifestPath)).toEqual([]);
    expect(fs.readFileSync(manifestPath, 'utf-8')).toBe('{ not json');
  });
});
