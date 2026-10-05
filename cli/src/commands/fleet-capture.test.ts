import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

let testHome = '';

afterEach(() => {
  if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
  testHome = '';
});

function guardedHome(): void {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-fleet-capture-home-'));
  const systemDir = path.join(testHome, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
}

function run(args: string[], extraEnv: Record<string, string> = {}): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('bun', [INDEX, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: testHome,
      USERPROFILE: testHome,
      AGENTS_NO_UPDATE_CHECK: '1',
      AGENTS_NO_USAGE_TRACK: '1',
      ...extraEnv,
    },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

const SELF = 'capture-self';

function env(): Record<string, string> {
  return {
    AGENTS_DEVICES_DIR: path.join(testHome, '.agents', '.history', 'devices'),
    AGENTS_SYNC_MACHINE_ID: SELF,
  };
}

function registerDevice(name: string): void {
  const dir = path.join(testHome, '.agents', '.history', 'devices');
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const profile = {
    name,
    platform: 'macos',
    shell: 'posix',
    user: 'someone',
    address: { via: 'tailscale', dnsName: `${name}.example.ts.net` },
    auth: { method: 'key' },
    createdAt: now,
    updatedAt: now,
  };
  const p = path.join(dir, 'registry.json');
  const reg = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
  reg[name] = profile;
  fs.writeFileSync(p, JSON.stringify(reg));
}

function writePins(name: string, agents: Record<string, string>): void {
  const dir = path.join(testHome, '.agents', '.history', 'devices');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `pins-${name}.json`), JSON.stringify({ agents }, null, 2) + '\n');
}

describe('fleet capture --from-pins (machine-local pins)', () => {
  it('records THIS machine’s pins from the pins file', () => {
    guardedHome();
    registerDevice(SELF);
    writePins(SELF, { claude: '2.1.0' });

    const r = run(['devices', 'capture', '--from-pins'], env());
    expect(r.status, r.stderr).toBe(0);
    const central = fs.readFileSync(path.join(testHome, '.agents', 'agents.yaml'), 'utf-8');
    expect(central).toContain(`${SELF}:`);
    expect(central).toContain('claude@latest');
  });

  it('--device <peer> fails loud instead of recording nothing', () => {
    guardedHome();
    registerDevice(SELF);
    registerDevice('mac-mini');
    writePins(SELF, { claude: '2.1.0' });

    const r = run(['devices', 'capture', '--from-pins', '--device', 'mac-mini'], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('peer pins are machine-local');
    const centralPath = path.join(testHome, '.agents', 'agents.yaml');
    if (fs.existsSync(centralPath)) {
      expect(fs.readFileSync(centralPath, 'utf-8')).not.toContain('claude@latest');
    }
  });
});
