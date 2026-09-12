/**
 * The allow list is the security boundary of `agents computer`, and PHNX-4075
 * moved it to the seam: the standalone engine enforces whatever agents-cli
 * renders into the policy file and has no way to second-guess it. A rule this
 * parser wrongly ADMITS is an app an agent can drive that the user never
 * authorized; one it wrongly DROPS is a broken workflow.
 *
 * Exercised against real permission-group YAML on disk through the same
 * `AGENTS_USER_PERMISSIONS_DIR` / `AGENTS_SYSTEM_PERMISSIONS_DIR` seams the CLI
 * itself reads — no mocking of the resolution layer.
 */
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

/** Write real group YAML into a real directory and point the resolver at it. */
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
    // The section tracker is what makes this true; a naive whole-file regex
    // would turn a deny rule into a grant, which is the worst possible failure
    // for this parser.
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
    // Resource resolution is user-over-system; the allow list must not quietly
    // union a system group the user deliberately overrode.
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
