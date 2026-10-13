import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureLeadDir, leadPaths, leadRoot, listLeadProjects } from './paths.js';

describe('Lead paths', () => {
  it('keeps everything under ~/.agents/lead/<project> and gitignores the root', () => {
    const p = ensureLeadDir('paths-demo');
    expect(p.dir).toBe(path.join(leadRoot(), 'paths-demo'));
    expect(p.socket).toBe(path.join(p.dir, 'host.sock'));
    expect(fs.readFileSync(path.join(leadRoot(), '.gitignore'), 'utf-8')).toBe('*\n');
    expect(listLeadProjects()).toContain('paths-demo');
    expect(listLeadProjects()).not.toContain('confirms');
  });

  it('rejects unsafe project names', () => {
    expect(() => leadPaths('../etc')).toThrow(/Invalid project name/);
  });
});
