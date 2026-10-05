import { describe, it, expect } from 'vitest';
import { remotePathExpr } from './remoteWorktree.js';

describe('remotePathExpr', () => {
  it('expands a bare ~ to "$HOME"', () => {
    expect(remotePathExpr('~')).toBe('"$HOME"');
  });

  it('expands ~/x to "$HOME"/<rest> so the host shell resolves it', () => {
    expect(remotePathExpr('~/.agents/repos/team')).toBe('"$HOME"/.agents/repos/team');
  });

  it('passes an absolute path through unchanged (no tilde, already safe)', () => {
    expect(remotePathExpr('/home/muqsit/src/agents-cli')).toBe('/home/muqsit/src/agents-cli');
  });

  it('passes a relative path through unchanged (no leading tilde)', () => {
    expect(remotePathExpr('src/agents-cli')).toBe('src/agents-cli');
  });

  it('keeps the tilde-suffix injection-safe (single-quotes shell metacharacters)', () => {
    expect(remotePathExpr('~/a b;rm -rf')).toBe(`"$HOME"/'a b;rm -rf'`);
  });
});
