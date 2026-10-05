import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CODEX_AUTO_PROFILE,
  CODEX_EDIT_PROFILE,
  CODEX_PLAN_PROFILE,
  codexEditWritableRoots,
  codexPermissionProfileConfig,
  codexPolicyArgs,
  modeForRemoteDispatch,
  modeWasImplicit,
} from './codex-policy.js';

describe('codexPolicyArgs', () => {
  it('keeps plan read-only while enabling network and on-request approval', () => {
    const args = codexPolicyArgs('plan');
    expect(args).toContain('approval_policy="on-request"');
    expect(args).toContain(`default_permissions="${CODEX_PLAN_PROFILE}"`);
    expect(args.join(' ')).toContain('extends = ":read-only"');
    expect(args.join(' ')).toContain('network = { enabled = true, allow_local_binding = true }');
    expect(args.join(' ')).not.toContain('workspace_roots');
  });

  it('gives edit the workspace, managed state, caches, and network', () => {
    const args = codexPolicyArgs('edit', ['/tmp/cache', '/tmp/cache', '/tmp/agents']);
    expect(args).toContain(`default_permissions="${CODEX_EDIT_PROFILE}"`);
    expect(args.join(' ')).toContain('extends = ":workspace"');
    expect(args.join(' ')).toContain('workspace_roots = { "/tmp/cache" = true, "/tmp/agents" = true }');
    expect(args.join(' ')).toContain('network = { enabled = true, allow_local_binding = true }');
  });

  it('gives auto the same sandbox as edit but never prompts', () => {
    const auto = codexPolicyArgs('auto', ['/tmp/agents']);
    expect(auto).toContain('approval_policy="never"');
    expect(auto).toContain(`default_permissions="${CODEX_AUTO_PROFILE}"`);
    expect(auto.join(' ')).toContain('extends = ":workspace"');
    expect(auto.join(' ')).toContain('workspace_roots = { "/tmp/agents" = true }');
    expect(auto.join(' ')).toContain('network = { enabled = true, allow_local_binding = true }');
    expect(auto).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('emits a byte-identical sandbox for auto and edit', () => {
    const roots = ['/tmp/agents', '/tmp/cache'];
    expect(codexPermissionProfileConfig('auto', roots))
      .toBe(codexPermissionProfileConfig('edit', roots));
  });

  it('keeps skip as the only sandbox and approval bypass', () => {
    expect(codexPolicyArgs('skip')).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
  });
});

describe('codexEditWritableRoots (repo .agents writable root)', () => {
  let tmp: string;
  let repo: string;
  let worktreeCwd: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-edit-roots-'));
    repo = path.join(tmp, 'agents-cli');
    worktreeCwd = path.join(repo, '.agents', 'worktrees', 'slug', 'apps', 'cli');
    fs.mkdirSync(worktreeCwd, { recursive: true });
  });

  afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('adds the existing repo .agents dir for a worktree cwd', () => {
    expect(codexEditWritableRoots(worktreeCwd)).toContain(path.join(repo, '.agents'));
  });

  it('flows that root into the edit policy workspace_roots', () => {
    const args = codexPolicyArgs('edit', codexEditWritableRoots(worktreeCwd));
    expect(args.join(' ')).toContain(`${JSON.stringify(path.join(repo, '.agents'))} = true`);
  });

  it('does not add a repo .agents that does not exist', () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    expect(codexEditWritableRoots(plain)).not.toContain(path.join(plain, '.agents'));
  });
});

describe('mode provenance', () => {
  it('preserves omitted versus explicit mode across remote dispatch', () => {
    expect(modeForRemoteDispatch('plan', 'default')).toBeUndefined();
    expect(modeForRemoteDispatch('plan', 'cli')).toBe('plan');
    expect(modeForRemoteDispatch('edit', 'config')).toBe('edit');
  });

  it.each(['plan', 'edit', 'auto', 'skip'])('does not replace an inherited %s resume mode', (mode) => {
    expect(modeForRemoteDispatch(mode, 'implied')).toBe(mode);
    expect(modeWasImplicit('implied', false)).toBe(false);
  });
});

describe('codexPermissionProfileConfig', () => {
  it('quotes writable root keys as TOML strings', () => {
    expect(codexPermissionProfileConfig('edit', ['/tmp/a path'])).toContain('"/tmp/a path" = true');
  });
});
