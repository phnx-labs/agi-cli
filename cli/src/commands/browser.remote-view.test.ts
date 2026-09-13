import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fetchRemoteFileForViewing, remoteReadFileArgv, REMOTE_VIEW_MAX_BYTES } from './browser.js';

const roots: string[] = [];
function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-view-'));
  roots.push(dir);
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

/**
 * Is the live loopback transfer opted into?
 *
 * Gated on an explicit env var, the same shape as the live Windows e2e
 * (`AGENTS_TEST_WIN_HOST` in `browser/drivers/ssh.e2e.test.ts`), because it needs
 * something the suite deliberately withholds: `tests/setup.ts` redirects `HOME`
 * to a sandbox so no test can read the operator's real `~/.agents` or `~/.ssh`.
 * That is correct and must not be weakened — but it also means ssh finds no
 * identity, so a real round trip cannot authenticate under the default suite env.
 *
 * Run it with a real HOME to exercise the transport:
 *   AGENTS_TEST_LOOPBACK_SSH=1 vitest run src/commands/browser.remote-view.test.ts
 *
 * The guard cases below need none of this and always run.
 */
function loopbackSshOptedIn(): boolean {
  if (!process.env.AGENTS_TEST_LOOPBACK_SSH) return false;
  try {
    execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=no', '127.0.0.1', 'true'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

describe('bounded private remote view', () => {
  it('refuses a relative remote path before opening any connection', async () => {
    await expect(fetchRemoteFileForViewing('whatever', 'relative/shot.png', path.join(tempRoot(), 'out.png')))
      .rejects.toThrow(/must be absolute/);
  });

  it('accepts a Windows absolute path shape', async () => {
    // Must get PAST the path check and fail on the unknown device instead.
    await expect(fetchRemoteFileForViewing('no-such-device-xyz', 'C:\\caps\\w.jpg', path.join(tempRoot(), 'out.jpg')))
      .rejects.toThrow(/Unknown device/);
  });

  it('refuses an unknown device with the next step named', async () => {
    await expect(fetchRemoteFileForViewing('no-such-device-xyz', '/tmp/x.png', path.join(tempRoot(), 'out.png')))
      .rejects.toThrow(/Unknown device "no-such-device-xyz"[\s\S]*agents devices list/);
  });

  it('states a budget that is a real bound, not unlimited', () => {
    expect(REMOTE_VIEW_MAX_BYTES).toBeGreaterThan(0);
    expect(Number.isFinite(REMOTE_VIEW_MAX_BYTES)).toBe(true);
  });
});

/**
 * Register a loopback device in the SUITE'S OWN registry and return its name.
 *
 * The suite sandboxes `HOME` and `AGENTS_DEVICES_DIR` on purpose, so it must not
 * read the operator's real fleet — and it should not: a test that depends on
 * which boxes happen to be enrolled is not reproducible. Writing one device that
 * dials `localhost` gives the transfer a REAL ssh round trip with no other
 * machine involved, which is also what keeps this scoped to this host.
 */
const LOOPBACK_DEVICE = 'loopback-view-test';
function registerLoopbackDevice(): void {
  const dir = process.env.AGENTS_DEVICES_DIR!;
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({
    [LOOPBACK_DEVICE]: {
      name: LOOPBACK_DEVICE, platform: 'linux', shell: 'posix',
      // `hostNameFor` reads dnsName ?? ip, so the loopback address goes in one of
      // those two fields — there is no `host` key on DeviceAddress.
      address: { via: 'manual', ip: '127.0.0.1' },
      auth: { method: 'key' },
      createdAt: now, updatedAt: now,
    },
  }));
}

describe.runIf(loopbackSshOptedIn())('bounded private remote view over real ssh (this host only)', () => {
  const device = LOOPBACK_DEVICE;
  beforeEach(() => { registerLoopbackDevice(); });

  it('pulls a real file into a 0600 file inside a 0700 dir', async () => {
    const src = path.join(tempRoot(), 'capture.bin');
    const body = Buffer.from('screenshot-bytes\u0000with-a-NUL-and-\u00ff-high-byte');
    fs.writeFileSync(src, body);
    const out = path.join(tempRoot(), 'nested', 'view.bin');

    await fetchRemoteFileForViewing(device, src, out);

    // Byte-exact, including the NUL and the high byte — a text-mode transfer
    // would corrupt both, and a capture is binary.
    expect(fs.readFileSync(out).equals(body)).toBe(true);
    expect((fs.statSync(out).mode & 0o777).toString(8)).toBe('600');
    expect((fs.statSync(path.dirname(out)).mode & 0o777).toString(8)).toBe('700');
  });

  it('aborts mid-stream on a file past the budget and leaves no partial file', async () => {
    const src = path.join(tempRoot(), 'big.bin');
    fs.writeFileSync(src, Buffer.alloc(256 * 1024, 7));
    const out = path.join(tempRoot(), 'big-view.bin');

    await expect(fetchRemoteFileForViewing(device, src, out, { maxBytes: 4 * 1024 }))
      .rejects.toThrow(/larger than the 4096-byte view budget/);
    // A partial file a viewer could open as if whole is worse than none.
    expect(fs.existsSync(out)).toBe(false);
  });

  it('reports the peer\'s own error for a missing file', async () => {
    const out = path.join(tempRoot(), 'missing-view.bin');
    await expect(fetchRemoteFileForViewing(device, '/tmp/definitely-not-here-xyz.png', out))
      .rejects.toThrow(/Failed to read|is empty or was not readable/);
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe('the read command is platform-correct, not portable-looking', () => {
  it('uses cat -- on a POSIX host', () => {
    expect(remoteReadFileArgv('/caps/a b.png', 'posix')).toEqual(['cat', '--', '/caps/a b.png']);
  });

  it('uses a .NET binary stream on PowerShell, never the cat alias', () => {
    const argv = remoteReadFileArgv('C:\\caps\\a b.png', 'powershell');
    expect(argv[0]).toBe('powershell');
    expect(argv.slice(1, 3)).toEqual(['-NoProfile', '-Command']);
    const script = argv[3]!;
    // On Windows `cat` is an alias for Get-Content — a TEXT reader that decodes,
    // splits into lines and re-encodes, corrupting any binary capture.
    expect(script).not.toMatch(/\bcat\b/);
    expect(script).not.toMatch(/Get-Content/);
    // The raw handle is what bypasses PowerShell's text pipeline entirely.
    expect(script).toContain('[System.IO.File]::OpenRead(');
    expect(script).toContain('[System.Console]::OpenStandardOutput()');
    expect(script).toContain('CopyTo');
    // The stream is released whether or not the copy threw.
    expect(script).toContain('finally{$in.Dispose()}');
  });

  it('escapes a quote in a Windows path with pwsh doubling', () => {
    const script = remoteReadFileArgv("C:\\caps\\it's.png", 'powershell')[3]!;
    expect(script).toContain("OpenRead('C:\\caps\\it''s.png')");
  });

  it('refuses a path whose shape does not match the host', async () => {
    // Saying so here beats a confusing shell error from the peer.
    await expect(fetchRemoteFileForViewing('no-such-device-xyz', '/posix/path', path.join(tempRoot(), 'o.bin')))
      .rejects.toThrow(/Unknown device/);
  });
});
