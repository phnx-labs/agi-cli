import { describe, expect, test } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateShimScript } from './shims.js';

// Replicate machineId()/normalizeHost() so the fixture writes the device folder
// the shim will actually read.
function deviceId(): string {
  const raw = process.env.AGENTS_SYNC_MACHINE_ID || os.hostname();
  return raw.split('.')[0].trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'unknown';
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-devpin-test-'));
}

describe('shim resolves the MACHINE-LOCAL default pin', () => {
  test('generated shim reads the pins JSON, then the device doc, then central', () => {
    const script = generateShimScript('grok');
    expect(script).toContain('machine_id()');
    expect(script).toContain('.history/devices/pins-$(machine_id).json');
    // fallbacks: tracked device doc (unmigrated installs), then central (pre-split)
    expect(script).toContain('parse_agents_default "$AGENTS_USER_DIR/devices/$(machine_id)/agents.yaml"');
    expect(script).toContain('parse_agents_default "$AGENTS_USER_DIR/agents.yaml"');
  });

  // POSIX-only: the bash shim mechanism doesn't apply on Windows (which uses
  // .cmd shims), and the CI runner has no `bash`.
  test.skipIf(process.platform === 'win32')('runs the pinned version WITHOUT the "no default set" prompt', () => {
    const work = tmp();
    const userDir = path.join(work, '.agents');
    const mid = deviceId();

    // Default lives ONLY in the pins JSON (current layout) ...
    fs.mkdirSync(path.join(userDir, '.history', 'devices'), { recursive: true });
    fs.writeFileSync(
      path.join(userDir, '.history', 'devices', `pins-${mid}.json`),
      JSON.stringify({ agents: { grok: '0.2.32' } }, null, 2) + '\n',
    );
    // ... and the central agents.yaml has NO agents: section, like the real machine.
    fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'hooks: {}\n');
    fs.mkdirSync(path.join(userDir, '.history', 'versions', 'grok', '0.2.32', 'home', '.grok'), { recursive: true });

    // grok resolves its binary from ~/.grok/downloads; provide a fake one.
    const grokDl = path.join(work, '.grok', 'downloads');
    fs.mkdirSync(grokDl, { recursive: true });
    const fakeGrok = path.join(grokDl, 'grok-0.2.32');
    fs.writeFileSync(fakeGrok, '#!/bin/bash\necho DEVICE_PINNED_GROK_RAN\n');
    fs.chmodSync(fakeGrok, 0o755);

    // Materialize the shim; neutralize the baked AGENTS_BIN so the entrypoint
    // guard passes without a real dist build.
    const shimPath = path.join(work, 'grok');
    const script = generateShimScript('grok').replace(/^AGENTS_BIN=.*$/m, "AGENTS_BIN='/usr/bin/true'");
    fs.writeFileSync(shimPath, script);
    fs.chmodSync(shimPath, 0o755);

    const out = execFileSync('bash', [shimPath, '--hi'], {
      env: { ...process.env, AGENTS_USER_DIR: userDir, HOME: work, PATH: '/usr/bin:/bin' },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // The pins-file pin resolved → grok ran; the "no default set" branch never fired.
    expect(out).toContain('DEVICE_PINNED_GROK_RAN');
    expect(out).not.toContain('no default set');
  });

  test.skipIf(process.platform === 'win32')('falls back to the tracked device doc for an unmigrated install', () => {
    const work = tmp();
    const userDir = path.join(work, '.agents');
    const mid = deviceId();

    // No pins JSON; the pin lives only in the tracked device doc (pre-migration).
    fs.mkdirSync(path.join(userDir, 'devices', mid), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'devices', mid, 'agents.yaml'), 'agents:\n  grok: 0.2.32\n');
    fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'hooks: {}\n');
    fs.mkdirSync(path.join(userDir, '.history', 'versions', 'grok', '0.2.32', 'home', '.grok'), { recursive: true });

    const grokDl = path.join(work, '.grok', 'downloads');
    fs.mkdirSync(grokDl, { recursive: true });
    const fakeGrok = path.join(grokDl, 'grok-0.2.32');
    fs.writeFileSync(fakeGrok, '#!/bin/bash\necho DOC_PINNED_GROK_RAN\n');
    fs.chmodSync(fakeGrok, 0o755);

    const shimPath = path.join(work, 'grok');
    const script = generateShimScript('grok').replace(/^AGENTS_BIN=.*$/m, "AGENTS_BIN='/usr/bin/true'");
    fs.writeFileSync(shimPath, script);
    fs.chmodSync(shimPath, 0o755);

    const out = execFileSync('bash', [shimPath, '--hi'], {
      env: { ...process.env, AGENTS_USER_DIR: userDir, HOME: work, PATH: '/usr/bin:/bin' },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(out).toContain('DOC_PINNED_GROK_RAN');
    expect(out).not.toContain('no default set');
  });

  // Regression (PR #2482 review): an inline-empty `"agents": {}` map before an isolatedAgents
  // block must not leak. The old awk exited only on a standalone `}` line, scraping the isolated
  // pin as the global default; the shim must take the "no default set" path.
  test.skipIf(process.platform === 'win32')('an inline-empty agents map never leaks an isolatedAgents pin as the default', () => {
    const work = tmp();
    const userDir = path.join(work, '.agents');
    const mid = deviceId();

    fs.mkdirSync(path.join(userDir, '.history', 'devices'), { recursive: true });
    fs.writeFileSync(
      path.join(userDir, '.history', 'devices', `pins-${mid}.json`),
      JSON.stringify({ agents: {}, isolatedAgents: { grok: '9.9.9' } }, null, 2) + '\n',
    );
    // Sanity: the fixture really is the inline-empty shape.
    expect(fs.readFileSync(path.join(userDir, '.history', 'devices', `pins-${mid}.json`), 'utf-8'))
      .toContain('"agents": {}');
    fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'hooks: {}\n');
    fs.mkdirSync(path.join(userDir, '.history', 'versions', 'grok', '0.2.32', 'home', '.grok'), { recursive: true });

    const grokDl = path.join(work, '.grok', 'downloads');
    fs.mkdirSync(grokDl, { recursive: true });
    const fakeGrok = path.join(grokDl, 'grok-0.2.32');
    fs.writeFileSync(fakeGrok, '#!/bin/bash\necho SHOULD_NOT_RUN\n');
    fs.chmodSync(fakeGrok, 0o755);

    const shimPath = path.join(work, 'grok');
    const script = generateShimScript('grok').replace(/^AGENTS_BIN=.*$/m, "AGENTS_BIN='/usr/bin/true'");
    fs.writeFileSync(shimPath, script);
    fs.chmodSync(shimPath, 0o755);

    const r = spawnSync('bash', [shimPath, '--hi'], {
      env: { ...process.env, AGENTS_USER_DIR: userDir, HOME: work, PATH: '/usr/bin:/bin' },
      encoding: 'utf-8',
    });

    const out = (r.stdout ?? '') + (r.stderr ?? '');
    // No global default → the shim says so; the isolated 9.9.9 is never read
    // as the default (pre-fix it was), and grok never runs.
    expect(out).toContain('no default set');
    expect(out).not.toContain('9.9.9');
    expect(out).not.toContain('SHOULD_NOT_RUN');
  });
});
