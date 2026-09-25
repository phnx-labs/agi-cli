import { readFileSync } from 'fs';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseUptime,
  parseVmStat,
  parseLinuxMemInfo,
  parseNcpu,
  parseDf,
  parseProbeOutput,
  parseWinProbeOutput,
  headroom,
  fmtBytes,
  fleetCapacity,
  localProbeInvocation,
  probeBudgetMs,
  probeDeviceStats,
  PROBE_SNIPPET,
  PROBE_TIMEOUT_MS,
  RELAYED_PROBE_TIMEOUT_MS,
  WIN_PROBE_TIMEOUT_MS,
  type DeviceStats,
} from './health.js';
import type { DeviceProfile } from './registry.js';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`testdata/${name}`, import.meta.url)), 'utf-8');

describe('parseUptime', () => {
  it('reads the macOS "load averages:" form', () => {
    expect(parseUptime('12:34  up 3 days, 1:02, 4 users, load averages: 1.83 2.01 1.95').loadAvg1).toBe(1.83);
  });
  it('reads the linux "load average:" (comma-separated) form', () => {
    expect(parseUptime(' 19:30:01 up 40 days,  2:14,  0 users,  load average: 0.20, 0.34, 0.31').loadAvg1).toBe(0.2);
  });
  it('handles comma as the decimal separator (some locales)', () => {
    expect(parseUptime('load average: 0,68, 0,50, 0,40').loadAvg1).toBe(0.68);
  });
  it('returns nothing when there is no load line', () => {
    expect(parseUptime('garbage')).toEqual({});
  });
});

describe('parseLinuxMemInfo', () => {
  it('computes used% and total/free bytes from MemTotal/MemAvailable', () => {
    const out = 'MemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:   14417920 kB\n';
    const m = parseLinuxMemInfo(out);
    expect(Math.round(m.memPercent!)).toBe(12); // (16384000 - 14417920) / 16384000
    expect(m.memTotalBytes).toBe(16384000 * 1024);
    expect(m.memFreeBytes).toBe(14417920 * 1024);
  });
  it('returns nothing without MemAvailable', () => {
    expect(parseLinuxMemInfo('MemTotal: 16384000 kB')).toEqual({});
  });
});

describe('parseVmStat', () => {
  it('counts inactive + speculative as available, not used (macOS reclaims them)', () => {
    const out = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                          100000.',
      'Pages active:                        250000.',
      'Pages inactive:                      100000.',
      'Pages speculative:                    50000.',
      'Pages wired down:                    100000.',
      'Pages occupied by compressor:         50000.',
    ].join('\n');
    const m = parseVmStat(out);
    // used = 400000; available = free(100000)+inactive(100000)+speculative(50000)=250000
    // total = 650000 -> 400000/650000 = 61.5%
    expect(Math.round(m.memPercent!)).toBe(62);
    expect(m.memTotalBytes).toBe(650000 * 16384);
    expect(m.memFreeBytes).toBe(250000 * 16384);
  });
  it('still works when inactive/speculative are absent (older vm_stat)', () => {
    const out = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                          100000.',
      'Pages active:                        250000.',
      'Pages wired down:                    100000.',
      'Pages occupied by compressor:         50000.',
    ].join('\n');
    const m = parseVmStat(out);
    // used = 400000, total = 500000 -> 80%
    expect(Math.round(m.memPercent!)).toBe(80);
    expect(m.memFreeBytes).toBe(100000 * 16384);
  });
  it('returns nothing when a required page class is missing', () => {
    expect(parseVmStat('Pages free: 100.')).toEqual({});
  });
});

describe('parseNcpu', () => {
  it('reads a bare integer (nproc / hw.ncpu)', () => {
    expect(parseNcpu('16\n').ncpu).toBe(16);
  });
  it('rejects non-positive / garbage', () => {
    expect(parseNcpu('0')).toEqual({});
    expect(parseNcpu('nope')).toEqual({});
  });
});

describe('parseDf', () => {
  it('parses captured Linux df output and derives usage from total/free blocks', () => {
    const disk = parseDf(fixture('df-linux.txt'));
    expect(disk.diskTotalBytes).toBe(1967215868 * 1024);
    expect(disk.diskFreeBytes).toBe(1725239864 * 1024);
    expect(disk.diskUsedPercent).toBeCloseTo(((1967215868 - 1725239864) / 1967215868) * 100);
  });

  it('parses captured macOS df output without reading the rounded Capacity column', () => {
    const disk = parseDf(fixture('df-macos.txt'));
    expect(disk.diskTotalBytes).toBe(1942700368 * 1024);
    expect(disk.diskFreeBytes).toBe(1151328936 * 1024);
    expect(disk.diskUsedPercent).toBeCloseTo(((1942700368 - 1151328936) / 1942700368) * 100);
  });

  it('returns no disk signal for an unparseable row', () => {
    expect(parseDf('Filesystem blocks used available')).toEqual({});
  });
});

describe('probe invocation', () => {
  it('keeps all four POSIX segments in one sh -c invocation', () => {
    expect(PROBE_SNIPPET.split('---AGSTAT---')).toHaveLength(4);
    expect(localProbeInvocation('linux')).toEqual({ file: 'sh', args: ['-c', PROBE_SNIPPET] });
    expect(localProbeInvocation('darwin')).toEqual({ file: 'sh', args: ['-c', PROBE_SNIPPET] });
  });
});

describe('parseProbeOutput', () => {
  it('assembles load, ncpu, normalized load%, and mem% (linux)', () => {
    const stdout = [
      'load average: 4.00, 3.0, 2.0',
      '---AGSTAT---',
      'MemTotal:       10000 kB\nMemAvailable:    2000 kB',
      '---AGSTAT---',
      '16',
      '---AGSTAT---',
      fixture('df-linux.txt').trim(),
    ].join('\n');
    const s = parseProbeOutput('box', stdout, 111);
    expect(s.loadAvg1).toBe(4);
    expect(s.ncpu).toBe(16);
    expect(s.loadPercent).toBeCloseTo(25); // 4/16
    expect(Math.round(s.memPercent!)).toBe(80);
    expect(s.diskTotalBytes).toBe(1967215868 * 1024);
    expect(s.reachable).toBe(true);
    expect(s.fetchedAt).toBe(111);
  });
  it('leaves loadPercent undefined when ncpu is unknown', () => {
    const stdout = ['load average: 2.0, 1, 1', '---AGSTAT---', 'MemTotal: 100 kB\nMemAvailable: 50 kB', '---AGSTAT---', 'oops'].join('\n');
    expect(parseProbeOutput('box', stdout, 0).loadPercent).toBeUndefined();
  });
});

describe('parseWinProbeOutput', () => {
  it('reads captured Win32_LogicalDisk output', () => {
    const s = parseWinProbeOutput('win-mini', fixture('win32-logical-disk.txt'), 111);
    expect(s.diskFreeBytes).toBe(592998400 * 1024);
    expect(s.diskTotalBytes).toBe(999480320 * 1024);
    expect(s.diskUsedPercent).toBeCloseTo(((999480320 - 592998400) / 999480320) * 100);
  });

  it('reads cpu%, memory, and core count from the labeled line', () => {
    const s = parseWinProbeOutput('uranus', 'AGWINSTAT load=12.5 freeKb=44447908 totalKb=66875660 ncpu=32\n', 111);
    expect(s.loadPercent).toBe(12.5);
    expect(s.ncpu).toBe(32);
    expect(Math.round(s.memPercent!)).toBe(34); // (66875660 - 44447908) / 66875660
    expect(s.memTotalBytes).toBe(66875660 * 1024);
    expect(s.memFreeBytes).toBe(44447908 * 1024);
    expect(s.loadAvg1).toBeUndefined();
    expect(s.reachable).toBe(true);
    expect(s.fetchedAt).toBe(111);
    expect(s.diskTotalBytes).toBeUndefined();
  });
  it('tolerates a $null LoadPercentage (empty load field) — mem still counts', () => {
    const s = parseWinProbeOutput('uranus', 'AGWINSTAT load= freeKb=1000 totalKb=2000 ncpu=8\n', 0);
    expect(s.loadPercent).toBeUndefined();
    expect(s.memPercent).toBe(50);
    expect(s.ncpu).toBe(8);
  });
  it('parses the marker line even with progress noise around it', () => {
    const s = parseWinProbeOutput('uranus', 'Preparing modules for first use.\nAGWINSTAT load=3 freeKb=100 totalKb=400 ncpu=4\n', 0);
    expect(s.loadPercent).toBe(3);
    expect(Math.round(s.memPercent!)).toBe(75);
  });
  it('degrades to reachable-with-no-stats when the marker line is missing', () => {
    const s = parseWinProbeOutput('uranus', 'garbage output', 0);
    expect(s.reachable).toBe(true);
    expect(s.loadPercent).toBeUndefined();
    expect(s.memPercent).toBeUndefined();
    expect(s.ncpu).toBeUndefined();
  });
});

describe('headroom', () => {
  const at = (loadPercent?: number, memPercent?: number) =>
    headroom({ host: 'h', reachable: true, loadPercent, memPercent, fetchedAt: 0 });
  it('buckets by the worst of load and mem', () => {
    expect(at(5, 5)).toBe('idle');
    expect(at(5, 30)).toBe('light');
    expect(at(50, 5)).toBe('busy');
    expect(at(5, 90)).toBe('loaded');
  });
  it('is unknown when unreachable or statless', () => {
    expect(headroom(undefined)).toBe('unknown');
    expect(headroom({ host: 'h', reachable: false, fetchedAt: 0 })).toBe('unknown');
    expect(at(undefined, undefined)).toBe('unknown');
  });
});

describe('fmtBytes', () => {
  it('formats binary units with ≤1 decimal', () => {
    expect(fmtBytes(0)).toBe('0B');
    expect(fmtBytes(512 * 1024)).toBe('512K');
    expect(fmtBytes(64 * 1024 ** 3)).toBe('64G');
    expect(fmtBytes(1.5 * 1024 ** 4)).toBe('1.5T');
  });
  it('renders a dash for missing/invalid', () => {
    expect(fmtBytes(undefined)).toBe('—');
    expect(fmtBytes(-1)).toBe('—');
  });
});

describe('fleetCapacity', () => {
  it('sums cores and memory across reachable devices only', () => {
    const list: DeviceStats[] = [
      { host: 'a', reachable: true, ncpu: 16, memTotalBytes: 64e9, memFreeBytes: 40e9, fetchedAt: 0 },
      { host: 'b', reachable: true, ncpu: 20, memTotalBytes: 128e9, memFreeBytes: 100e9, fetchedAt: 0 },
      { host: 'c', reachable: false, ncpu: 8, memTotalBytes: 32e9, memFreeBytes: 8e9, fetchedAt: 0 }, // excluded
    ];
    const cap = fleetCapacity(list);
    expect(cap.reachable).toBe(2);
    expect(cap.cores).toBe(36);
    expect(cap.memTotalBytes).toBe(192e9);
    expect(cap.memFreeBytes).toBe(140e9);
  });
});

describe('specsFetchedAt is stamped on every reachable path (RUSH-3062)', () => {
  // retainHardwareFacts (RUSH-3096) carries specsFetchedAt forward across an
  // unreachable probe to say when the retained hardware facts were actually
  // observed. Any success path that forgets to stamp it degrades that
  // provenance to the coarser fetchedAt.
  it('windows: unparseable probe output still stamps it', () => {
    const s = parseWinProbeOutput('winbox', 'garbage that matches nothing', 1000);
    expect(s.reachable).toBe(true);
    expect(s.specsFetchedAt).toBe(1000);
  });

  it('posix: a probe whose df segment yields nothing still stamps it', () => {
    const SEP = '---AGSTAT---';
    const out = ['12:00:00 up 1 day, load average: 0.50, 0.4, 0.3', SEP, 'MemTotal: 16000000 kB\nMemAvailable: 8000000 kB', SEP, '8', SEP, ''].join('\n');
    const s = parseProbeOutput('box', out, 2000);
    expect(s.reachable).toBe(true);
    expect(s.diskTotalBytes).toBeUndefined();
    expect(s.specsFetchedAt).toBe(2000);
  });
});


/**
 * PHNX-3682 — a relayed peer needs a bigger probe budget than a direct one.
 *
 * The regression: one 2.5s budget was applied to every device, which is shorter
 * than a cold DERP-relayed SSH handshake (measured 1.7-6.6s across a 9-box
 * relayed fleet). `--device auto` then reported every healthy worker as
 * "unreachable" and refused to launch.
 */
function device(over: Partial<DeviceProfile> = {}): DeviceProfile {
  return {
    name: 'box',
    platform: 'linux',
    shell: 'posix',
    address: { via: 'tailscale', ip: '100.64.0.1' },
    auth: { method: 'key' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('probeBudgetMs (PHNX-3682)', () => {
  it('gives a relayed peer the larger budget', () => {
    expect(probeBudgetMs(device({ tailscale: { online: true, direct: false, relay: 'sfo' } })))
      .toBe(RELAYED_PROBE_TIMEOUT_MS);
  });

  it('keeps the tight budget for a direct peer', () => {
    expect(probeBudgetMs(device({ tailscale: { online: true, direct: true } })))
      .toBe(PROBE_TIMEOUT_MS);
  });

  it('treats a device with no tailscale snapshot as unknown-path, not relayed', () => {
    // A `via:"manual"` device never gets a peer entry. Absence must not silently
    // widen its budget — that would slow every manual device's probe.
    expect(probeBudgetMs(device())).toBe(PROBE_TIMEOUT_MS);
  });

  it('keeps the windows budget, which already exceeds both', () => {
    expect(probeBudgetMs(device({ shell: 'powershell', platform: 'windows' })))
      .toBe(WIN_PROBE_TIMEOUT_MS);
    expect(WIN_PROBE_TIMEOUT_MS).toBeGreaterThan(PROBE_TIMEOUT_MS);
  });

  it('allows a relayed handshake the measured cold-path range', () => {
    // The slowest healthy box in the PHNX-3682 capture answered at 6588ms.
    expect(RELAYED_PROBE_TIMEOUT_MS).toBeGreaterThan(6_588);
  });
});

describe('probeDeviceStats reports a timeout apart from unreachable (PHNX-3682)', () => {
  it('sets timedOut when the real ssh probe exceeds its budget', async () => {
    // Real ssh, real timeout — 192.0.2.0/24 is TEST-NET-1 (RFC 5737) and
    // blackholes, so the client hangs until the budget kills it.
    const stats = await probeDeviceStats(
      device({ name: 'blackhole', address: { via: 'manual', ip: '192.0.2.1' } }),
      { timeoutMs: 1_200 },
    );
    expect(stats.reachable).toBe(false);
    expect(stats.timedOut).toBe(true);
  }, 20_000);
});

describe('buildProbeInvocation follows the operator platform, not the discovered shell', () => {
  // Real config read path: temp HOME + a per-device doc, fresh modules per test
  // (state.ts captures HOME at import time). A Windows-discovered box whose
  // sshd lands in WSL is configured `platform: linux`; the probe must then dial
  // the POSIX snippet on the POSIX budget — the PowerShell snippet fed to a
  // bash login shell yields empty stdout and a permanently "offline" row.
  let TMP = '';
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-health-probe-test-'));
    process.env.HOME = TMP;
    process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
    process.env.AGENTS_DEVICES_DIR = path.join(TMP, '.agents', '.history', 'devices');
  });
  afterEach(() => {
    process.env.HOME = savedHome;
    delete process.env.AGENTS_SYNC_MACHINE_ID;
    delete process.env.AGENTS_DEVICES_DIR;
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  async function fresh() {
    vi.resetModules();
    return import('./health.js');
  }

  const windowsDiscovered = (): DeviceProfile => device({
    name: 'jupiter',
    platform: 'windows',
    shell: 'powershell',
    address: { via: 'tailscale', dnsName: 'jupiter.example.ts.net' },
    tailscale: { online: true, direct: false, relay: 'sfo' },
  });

  it('dials the PowerShell snippet on the Windows budget when nothing overrides discovery', async () => {
    const h = await fresh();
    const inv = h.buildProbeInvocation(windowsDiscovered(), '/tmp/askpass.sh');
    expect(inv.isWin).toBe(true);
    expect(inv.budgetMs).toBe(h.WIN_PROBE_TIMEOUT_MS);
    expect(inv.args.at(-1)).toContain('powershell -NoProfile');
    expect(inv.args.at(-1)).not.toContain(h.PROBE_SNIPPET);
  });

  it('dials the POSIX snippet on the relayed POSIX budget once config says platform: linux', async () => {
    const dir = path.join(TMP, '.agents', 'devices', 'jupiter');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents.yaml'), 'config:\n  platform: linux\n  sshUser: caleb\n');
    const h = await fresh();
    const inv = h.buildProbeInvocation(windowsDiscovered(), '/tmp/askpass.sh');
    expect(inv.isWin).toBe(false);
    expect(inv.budgetMs).toBe(h.RELAYED_PROBE_TIMEOUT_MS);
    expect(inv.args.at(-1)).toContain(h.PROBE_SNIPPET);
    expect(inv.args.at(-1)).not.toContain('powershell -NoProfile');
    // The dial target follows the same resolved profile.
    expect(inv.args).toContain('caleb@jupiter.example.ts.net');
  });
});
