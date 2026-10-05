import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let TMP = '';

async function freshDrift() {
  vi.resetModules();
  return import('./config-drift.js');
}

function writeCentral(text: string) {
  fs.mkdirSync(path.join(TMP, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(TMP, '.agents', 'agents.yaml'), text);
}

const CANONICAL_HEADER = `# agents-cli metadata
# Auto-generated - do not edit manually
# https://github.com/phnx-labs/agi-cli
# yaml-language-server: $schema=https://raw.githubusercontent.com/phnx-labs/agi-cli/main/cli/schema/agents-yaml.schema.json

`;

describe('config drift detection (PHNX-3315 P3)', () => {
  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-config-drift-'));
    process.env.HOME = TMP;
    process.env.AGENTS_SYNC_MACHINE_ID = 'driftbox';
  });
  afterEach(() => {
    delete process.env.AGENTS_SYNC_MACHINE_ID;
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {  }
  });

  it('a drained box shows NO drift (canonical header, no central device-scoped blocks)', async () => {
    writeCentral(CANONICAL_HEADER + 'run:\n  claude:\n    strategy: balanced\n');
    const { detectConfigDrift, hasConfigDrift } = await freshDrift();
    const d = detectConfigDrift();
    expect(d.staleHeader).toBe(false);
    expect(d.centralLeaks).toEqual([]);
    expect(hasConfigDrift(d)).toBe(false);
  });

  it('flags a fresh box with no top-level file as clean (not drifted)', async () => {
    const { detectConfigDrift } = await freshDrift();
    const d = detectConfigDrift();
    expect(d.staleHeader).toBe(false);
    expect(d.centralLeaks).toEqual([]);
  });

  it('flags a STALE top-level header (the P1 frozen-header case)', async () => {
    writeCentral(
      '# agents-cli metadata\n' +
      '# Auto-generated - do not edit manually\n' +
      '# https://github.com/phnx-labs/agents-cli\n\n' +
      'run:\n  claude:\n    strategy: balanced\n',
    );
    const { detectConfigDrift, hasConfigDrift } = await freshDrift();
    const d = detectConfigDrift();
    expect(d.staleHeader).toBe(true);
    expect(hasConfigDrift(d)).toBe(true);
  });

  it('flags a lingering central browser: tombstone', async () => {
    writeCentral(CANONICAL_HEADER + 'browser:\n  work:\n    kind: cdp\n');
    const { detectConfigDrift } = await freshDrift();
    expect(detectConfigDrift().centralLeaks).toContain('browser');
  });

  it('flags lingering central fleet.discovery / fleet.ignored', async () => {
    writeCentral(
      CANONICAL_HEADER +
      'fleet:\n  discovery:\n    mac-mini: approved\n  ignored:\n    - name: old-box\n',
    );
    const { detectConfigDrift } = await freshDrift();
    const leaks = detectConfigDrift().centralLeaks;
    expect(leaks).toContain('fleet.discovery');
    expect(leaks).toContain('fleet.ignored');
  });

  it('flags a lingering central hosts: registry', async () => {
    writeCentral(CANONICAL_HEADER + 'hosts:\n  prod:\n    hostname: prod.example.com\n');
    const { detectConfigDrift } = await freshDrift();
    expect(detectConfigDrift().centralLeaks).toContain('hosts');
  });

  it('flags central device-scoped native accounts, but leaves fleet-shared ones central', async () => {
    writeCentral(
      CANONICAL_HEADER + 'accounts:\n  native:\n    acct-1:\n      scope: device\n      handle: me\n',
    );
    const { detectConfigDrift } = await freshDrift();
    expect(detectConfigDrift().centralLeaks).toContain('accounts (device-scoped)');

    writeCentral(
      CANONICAL_HEADER + 'accounts:\n  native:\n    acct-2:\n      scope: version\n      handle: shared\n',
    );
    const { detectConfigDrift: detect2 } = await freshDrift();
    expect(detect2().centralLeaks).not.toContain('accounts (device-scoped)');
  });
});
