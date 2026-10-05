import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectAgentsBinaryShadows, sameFile } from './binary-shadow.js';

describe('detectAgentsBinaryShadows', () => {
  const savedPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = savedPath ?? '';
  });

  function withSystemPath(tmpDir: string): string {
    return `${tmpDir}${path.delimiter}${savedPath ?? ''}`;
  }

  function binaryPath(tmpDir: string, name: string): string {
    return path.join(tmpDir, process.platform === 'win32' ? `${name}.cmd` : name);
  }

  function writeBinary(file: string, output: string): void {
    const contents = process.platform === 'win32'
      ? `@echo off\r\necho ${output}\r\n`
      : `#!/bin/sh\necho ${output}\n`;
    fs.writeFileSync(file, contents, { mode: 0o755 });
  }

  it('returns empty when only the current agents binary exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-shadow-one-'));
    const agents = binaryPath(tmpDir, 'agents');
    writeBinary(agents, 'current');
    process.env.PATH = withSystemPath(tmpDir);
    try {
      expect(detectAgentsBinaryShadows(agents, [])).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects a shadowing binary earlier on PATH', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-shadow-path-'));
    const realAgents = binaryPath(tmpDir, 'real-agents');
    const shadowAgents = binaryPath(tmpDir, 'agents');
    writeBinary(realAgents, 'real');
    writeBinary(shadowAgents, 'shadow');
    process.env.PATH = withSystemPath(tmpDir);
    try {
      const shadows = detectAgentsBinaryShadows(realAgents, []);
      expect(shadows).toHaveLength(1);
      expect(sameFile(shadows[0].path, shadowAgents)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects a latent shadow in a well-known install directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-shadow-wellknown-'));
    const realAgents = binaryPath(tmpDir, 'agents');
    const shadowDir = path.join(tmpDir, 'extra-bin');
    const shadowAgents = binaryPath(shadowDir, 'agents');
    writeBinary(realAgents, 'real');
    fs.mkdirSync(shadowDir, { recursive: true });
    writeBinary(shadowAgents, 'shadow');
    process.env.PATH = withSystemPath(tmpDir);
    try {
      const shadows = detectAgentsBinaryShadows(realAgents, [shadowDir]);
      expect(shadows.some((s) => s.path === shadowAgents)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
