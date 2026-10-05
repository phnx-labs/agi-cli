import { describe, expect, it } from 'vitest';
import {
  buildFleetAttentionItems,
  buildFleetHealthReport,
  freshnessFooter,
  platformGroupLabel,
  renderFleetMatrix,
  renderFleetSummary,
  renderFleetWarnings,
  shortVersion,
  type FleetHealthRow,
} from './health-report.js';
import { stripAnsi } from '../session/width.js';

function row(overrides: Partial<FleetHealthRow> & { name: string }): FleetHealthRow {
  return {
    name: overrides.name,
    platform: overrides.platform ?? 'linux',
    version: overrides.version ?? '1.2.3',
    stats: overrides.stats,
    error: overrides.error,
    skipped: overrides.skipped,
    clis: overrides.clis ?? {
      codex: { installed: true, path: '/bin/codex', error: null },
    },
    sync: overrides.sync ?? [
      { agent: 'codex', version: '0.1.0', status: 'fresh', isDefault: true },
    ],
    orphans: overrides.orphans ?? [],
    auth: overrides.auth,
    online: overrides.online,
    lastSeen: overrides.lastSeen,
    inventory: overrides.inventory,
  };
}

function clis(installed: number, total: number): FleetHealthRow['clis'] {
  const out: FleetHealthRow['clis'] = {};
  for (let i = 0; i < total; i++) {
    out[`agent${i}`] = { installed: i < installed, path: i < installed ? '/bin/x' : null, error: null };
  }
  return out;
}

describe('buildFleetHealthReport', () => {
  it('rolls up unreachable, drift, CLI gaps, and version skew', () => {
    const report = buildFleetHealthReport([
      row({ name: 'a', version: '1.0.0' }),
      row({
        name: 'b',
        version: '1.0.1',
        clis: { codex: { installed: false, path: null, error: 'missing' } },
        sync: [{ agent: 'codex', version: '0.1.0', status: 'stale', isDefault: true }],
      }),
      row({ name: 'c', error: 'timed out' }),
    ], new Date('2026-07-17T00:00:00.000Z'));

    expect(report.generatedAt).toBe('2026-07-17T00:00:00.000Z');
    expect(report.hasWarnings).toBe(true);
    expect(report.hasDrift).toBe(true);
    expect(report.warnings.map((w) => w.kind)).toEqual([
      'unreachable',
      'drift',
      'cli',
      'version-skew',
    ]);
  });

  it('emits a per-device divergence warning when a remote inventory lacks a local resource (RUSH-2027)', () => {
    const emptyKinds = {
      commands: [], skills: [], hooks: [], rules: [], mcp: [],
      permissions: [], subagents: [], plugins: [], workflows: [], memory: [],
    };
    const report = buildFleetHealthReport(
      [
        row({ name: 'zion', inventory: { resources: { ...emptyKinds, plugins: ['swarm'] }, agentVersions: {}, repos: { agents: null, system: null } } }),
        row({ name: 'yosemite-s0', inventory: { resources: { ...emptyKinds }, agentVersions: {}, repos: { agents: null, system: null } } }),
      ],
      new Date('2026-08-01T00:00:00.000Z'),
      { self: 'zion' },
    );
    const div = report.warnings.find((w) => w.kind === 'divergence');
    expect(div).toBeDefined();
    expect(div!.devices).toEqual(['yosemite-s0']);
    expect(div!.message).toContain('yosemite-s0 diverges from zion');
    expect(report.hasWarnings).toBe(true);
  });

  it('does not emit a divergence warning when no self baseline is provided', () => {
    const emptyKinds = {
      commands: [], skills: [], hooks: [], rules: [], mcp: [],
      permissions: [], subagents: [], plugins: [], workflows: [], memory: [],
    };
    const report = buildFleetHealthReport([
      row({ name: 'zion', inventory: { resources: { ...emptyKinds, plugins: ['swarm'] }, agentVersions: {}, repos: { agents: null, system: null } } }),
      row({ name: 'box', inventory: { resources: { ...emptyKinds }, agentVersions: {}, repos: { agents: null, system: null } } }),
    ]);
    expect(report.warnings.some((w) => w.kind === 'divergence')).toBe(false);
  });
});

describe('fleet health renderers', () => {
  it('renders a warnings rollup and matrix without ANSI-sensitive assertions', () => {
    const report = buildFleetHealthReport([
      row({ name: 'fresh-box' }),
      row({
        name: 'drift-box',
        sync: [{ agent: 'codex', version: '0.1.0', status: 'never-synced', isDefault: true }],
      }),
    ], new Date('2026-07-17T00:00:00.000Z'));

    const warnings = stripAnsi(renderFleetWarnings(report).join('\n'));
    const matrix = stripAnsi(renderFleetMatrix(report).join('\n'));
    expect(warnings).toContain('Fleet warnings');
    expect(warnings).toContain('sync drift');
    expect(matrix).toContain('Fleet status');
    expect(matrix).toContain('fresh-box');
    expect(matrix).toContain('drift-box');
    expect(matrix).toContain('cold');
    const mlines = matrix.split('\n');
    const header = mlines.find((l) => l.includes('Device'))!;
    const dataRow = mlines.find((l) => l.includes('fresh-box'))!;
    expect(header.indexOf('Device')).toBe(dataRow.indexOf('fresh-box'));
  });
});

describe('Auth column + freshness', () => {
  it('renders a compact per-host auth cell and includes an Auth header', () => {
    const report = buildFleetHealthReport([
      row({ name: 'live-box', auth: { live: 4, present: 0, degraded: 0, revoked: 0, total: 4, oldestCheckedAt: 1000 } }),
      row({ name: 'mixed-box', auth: { live: 2, present: 3, degraded: 1, revoked: 1, total: 7, oldestCheckedAt: 1000 } }),
      row({ name: 'nocache-box' }),
    ]);
    const lines = renderFleetMatrix(report).map(stripAnsi);
    expect(lines.find((l) => l.includes('Device'))).toContain('Auth');
    expect(lines.find((l) => l.includes('live-box'))).toContain('●4');
    const mixed = lines.find((l) => l.includes('mixed-box'))!;
    expect(mixed).toContain('●2');
    expect(mixed).toContain('·3');
    expect(mixed).toContain('◐1');
    expect(mixed).toContain('○1');
    expect(lines.find((l) => l.includes('nocache-box'))).toContain('—');
  });

  it('sizes the Auth column so a wide mixed-auth cell never misaligns later columns', () => {
    // Regression: a full `●2 ·3 ◐1 ○1` cell (11 display cells) overflowed a hard-coded 9-wide
    // slot, shoving Version/Load-Mem/Note right. With the same name width and version, Version
    // must start at the same column in the wide-auth row and the em-dash row.
    const report = buildFleetHealthReport([
      row({ name: 'aaaa', version: '9.9.9', auth: { live: 2, present: 3, degraded: 1, revoked: 1, total: 7, oldestCheckedAt: 1 } }),
      row({ name: 'bbbb', version: '9.9.9' }),
    ]);
    const lines = renderFleetMatrix(report).map(stripAnsi);
    const wide = lines.find((l) => l.includes('aaaa'))!;
    const narrow = lines.find((l) => l.includes('bbbb'))!;
    expect(wide.indexOf('9.9.9')).toBe(narrow.indexOf('9.9.9'));
  });

  it('does not paint present (unverified) accounts as degraded ◐', () => {
    const report = buildFleetHealthReport([
      row({ name: 'unprobeable', auth: { live: 0, present: 6, degraded: 0, revoked: 0, total: 6, oldestCheckedAt: 1000 } }),
    ]);
    const cell = renderFleetMatrix(report).map(stripAnsi).find((l) => l.includes('unprobeable'))!;
    expect(cell).toContain('·6');
    expect(cell).not.toContain('◐');
  });

  it('freshnessFooter dates both stats and auth and points at --refresh', () => {
    const now = 100_000;
    const foot = freshnessFooter([
      row({ name: 'a', stats: { host: 'a', reachable: true, fetchedAt: now - 120_000 } as never,
            auth: { live: 1, present: 0, degraded: 0, revoked: 0, total: 1, oldestCheckedAt: now - 300_000 } }),
    ], now);
    expect(foot).toContain('stats 2m ago');
    expect(foot).toContain('auth 5m ago');
    expect(foot).toContain('--refresh');
    expect(foot).toContain('--live');
  });

  it('freshnessFooter returns null when no row carries a timestamp', () => {
    expect(freshnessFooter([row({ name: 'a' })])).toBeNull();
  });
});

describe('summary view helpers (RUSH-1966)', () => {
  it('shortVersion collapses dev builds and passes released semver through', () => {
    expect(shortVersion('0.0.0-dev.867dea00-dirty')).toBe('dev-dirty');
    expect(shortVersion('0.0.0-dev.867dea00')).toBe('dev');
    expect(shortVersion('1.20.74')).toBe('1.20.74');
    expect(shortVersion(null)).toBe('—');
    expect(shortVersion(undefined)).toBe('—');
  });

  it('platformGroupLabel buckets by OS family', () => {
    expect(platformGroupLabel('macos')).toBe('macOS');
    expect(platformGroupLabel('darwin')).toBe('macOS');
    expect(platformGroupLabel('linux')).toBe('Linux');
    expect(platformGroupLabel('windows')).toBe('Windows');
    expect(platformGroupLabel('win32')).toBe('Windows');
    expect(platformGroupLabel(undefined)).toBe('Other');
  });
});

describe('buildFleetAttentionItems (only real, actionable problems)', () => {
  const stale = [{ agent: 'codex', version: '0.1.0', status: 'stale' as const, isDefault: true }];

  it('flags a genuinely-offline box, but NOT an unknown/unconfigured one', () => {
    const report = buildFleetHealthReport([
      row({ name: 'down', online: 'offline', lastSeen: '2026-07-28T00:00:00.000Z' }),
      row({ name: 'never-set-up', online: 'unknown' }),
      row({ name: 'up', online: 'online' }),
    ]);
    const items = buildFleetAttentionItems(report, Date.parse('2026-07-31T00:00:00.000Z'));
    const offline = items.filter((i) => i.glyph === 'offline');
    expect(offline.map((i) => i.subject)).toEqual(['down']);
    expect(offline[0].detail).toContain('last seen');
    expect(offline[0].fix).toBe('check the box');
  });

  it('merges config drift and a stark CLI gap into one `agents fleet apply` item per box', () => {
    const report = buildFleetHealthReport([
      row({ name: 'multi', online: 'online', sync: stale, clis: clis(1, 9) }),
    ]);
    const items = buildFleetAttentionItems(report);
    const apply = items.filter((i) => i.fix === 'agents fleet apply --device multi');
    expect(apply).toHaveLength(1);
    expect(apply[0].detail).toContain('config drift');
    expect(apply[0].detail).toContain('only 1 of 9');
  });

  it('does not flag a normal partial CLI install (6 of 9) — only a stark gap', () => {
    const report = buildFleetHealthReport([
      row({ name: 'normal', online: 'online', clis: clis(6, 9) }),
    ]);
    expect(buildFleetAttentionItems(report)).toEqual([]);
  });

  it('summarizes version skew as one line with per-version counts', () => {
    const report = buildFleetHealthReport([
      row({ name: 'a', online: 'online', version: '1.20.73' }),
      row({ name: 'b', online: 'online', version: '1.20.73' }),
      row({ name: 'c', online: 'online', version: '1.20.74' }),
    ]);
    const skew = buildFleetAttentionItems(report).find((i) => i.subject === 'version skew')!;
    expect(skew.detail).toBe('2× 1.20.73 · 1× 1.20.74');
    expect(skew.fix).toBe('agents upgrade --fleet');
  });

  it('a fully-healthy fleet has zero attention items', () => {
    const report = buildFleetHealthReport([
      row({ name: 'a', online: 'online', version: '1.20.74', clis: clis(9, 9) }),
      row({ name: 'b', online: 'online', version: '1.20.74', clis: clis(9, 9) }),
    ]);
    expect(buildFleetAttentionItems(report)).toEqual([]);
  });
});

describe('renderFleetSummary (default view)', () => {
  it('leads with the online/offline rollup and groups rows by OS, highlighting this machine', () => {
    const report = buildFleetHealthReport([
      row({ name: 'zion', platform: 'macos', online: 'online', version: '1.20.74',
        stats: { host: 'zion', reachable: true, loadPercent: 23, memPercent: 49, fetchedAt: 1000 } as never }),
      row({ name: 'linux-box', platform: 'linux', online: 'online', version: '1.20.74',
        stats: { host: 'linux-box', reachable: true, loadPercent: 2, memPercent: 15, fetchedAt: 1000 } as never }),
      row({ name: 'down', platform: 'linux', online: 'offline', version: '1.20.74', lastSeen: '2026-07-28T00:00:00.000Z' }),
    ]);
    const lines = renderFleetSummary(report, { self: 'zion', now: 2000 }).map(stripAnsi);
    const text = lines.join('\n');
    expect(text).toContain('2 online');
    expect(text).toContain('1 offline');
    expect(text).toContain('macOS');
    expect(text).toContain('Linux');
    const selfLine = lines.find((l) => l.includes('← this machine'))!;
    expect(selfLine).toContain('▸');
    expect(selfLine).toContain('zion');
    const downLine = lines.find((l) => l.includes('down'))!;
    expect(downLine).toContain('offline');
    expect(downLine).toContain('last seen');
    expect(text).toContain('--verbose');
  });

  it('a healthy fleet reads short: rollup + an all-clear line, no NEEDS ATTENTION block', () => {
    const report = buildFleetHealthReport([
      row({ name: 'a', online: 'online', version: '1.20.74', clis: clis(9, 9) }),
    ]);
    const text = renderFleetSummary(report, { self: 'a' }).map(stripAnsi).join('\n');
    expect(text).toContain('Everything looks healthy.');
    expect(text).not.toContain('NEEDS ATTENTION');
  });

  it('demotes orphaned versions to a single footer nudge toward prune, not a per-row column', () => {
    const report = buildFleetHealthReport([
      row({ name: 'a', online: 'online', orphans: [{ agent: 'codex', version: '0.1.0', commands: 1, skills: 0, hooks: 0 }] }),
    ]);
    const text = renderFleetSummary(report, {}).map(stripAnsi).join('\n');
    expect(text).toContain('1 device carries orphaned versions');
    expect(text).toContain('agents prune');
  });
});
