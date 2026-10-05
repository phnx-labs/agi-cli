import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadComputerAllowList } from './policy.js';

const tempDirs: string[] = [];
const saved = {
  user: process.env.AGENTS_USER_PERMISSIONS_DIR,
  system: process.env.AGENTS_SYSTEM_PERMISSIONS_DIR,
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ['AGENTS_USER_PERMISSIONS_DIR', saved.user],
    ['AGENTS_SYSTEM_PERMISSIONS_DIR', saved.system],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function withGroups(groups: { user?: Record<string, string>; system?: Record<string, string> }): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-computer-policy-'));
  tempDirs.push(root);
  for (const layer of ['user', 'system'] as const) {
    const dir = path.join(root, layer, 'groups');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(groups[layer] ?? {})) {
      fs.writeFileSync(path.join(dir, name), body);
    }
  }
  process.env.AGENTS_USER_PERMISSIONS_DIR = path.join(root, 'user');
  process.env.AGENTS_SYSTEM_PERMISSIONS_DIR = path.join(root, 'system');
}

describe('loadComputerAllowList', () => {
  it('collects Computer(<bundle-id>) rules from a group\'s allow list', () => {
    withGroups({
      user: {
        'computer.yaml': [
          'name: computer',
          'allow:',
          '  - "Computer(com.apple.notes)"',
          '  - "Computer(com.apple.finder)"',
          '',
        ].join('\n'),
      },
    });
    expect(loadComputerAllowList()).toEqual(['com.apple.finder', 'com.apple.notes']);
  });

  it('is deny-by-default: no groups means an empty allow list, never a wildcard', () => {
    withGroups({});
    expect(loadComputerAllowList()).toEqual([]);
  });

  it('ignores non-Computer rules, so an unrelated group cannot widen the list', () => {
    withGroups({
      user: {
        'dev.yaml': [
          'name: dev',
          'allow:',
          '  - "Bash(git status:*)"',
          '  - "Read(//**)"',
          '',
        ].join('\n'),
      },
    });
    expect(loadComputerAllowList()).toEqual([]);
  });

  it('only honors the allow: section — a rule under deny: must not be admitted', () => {
    withGroups({
      user: {
        'computer.yaml': [
          'name: computer',
          'allow:',
          '  - "Computer(com.apple.notes)"',
          'deny:',
          '  - "Computer(com.apple.keychainaccess)"',
          '',
        ].join('\n'),
      },
    });
    expect(loadComputerAllowList()).toEqual(['com.apple.notes']);
  });

  it('unions across layers and de-duplicates', () => {
    withGroups({
      user: { 'a.yaml': 'name: a\nallow:\n  - "Computer(com.apple.notes)"\n' },
      system: { 'b.yaml': 'name: b\nallow:\n  - "Computer(com.apple.mail)"\n  - "Computer(com.apple.notes)"\n' },
    });
    expect(loadComputerAllowList()).toEqual(['com.apple.mail', 'com.apple.notes']);
  });

  it('lets the USER layer win a filename collision', () => {
    withGroups({
      user: { 'computer.yaml': 'name: computer\nallow:\n  - "Computer(com.apple.notes)"\n' },
      system: { 'computer.yaml': 'name: computer\nallow:\n  - "Computer(com.apple.systempreferences)"\n' },
    });
    expect(loadComputerAllowList()).toEqual(['com.apple.notes']);
  });

  it('tolerates CRLF line endings', () => {
    withGroups({ user: { 'c.yaml': 'name: c\r\nallow:\r\n  - "Computer(com.apple.notes)"\r\n' } });
    expect(loadComputerAllowList()).toEqual(['com.apple.notes']);
  });

  it('skips a non-YAML file rather than parsing it as a group', () => {
    withGroups({
      user: {
        'README.md': 'allow:\n  - "Computer(com.evil.app)"\n',
        'ok.yml': 'name: ok\nallow:\n  - "Computer(com.apple.notes)"\n',
      },
    });
    expect(loadComputerAllowList()).toEqual(['com.apple.notes']);
  });
});
