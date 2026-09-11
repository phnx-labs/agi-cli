import { describe, it, expect } from 'vitest';
import {
  parseReadyProbe,
  viewHasAgent,
  viewAgentAccountEligibility,
  viewAgentSignedIn,
  viewAgentVersions,
  viewHasAgentVersion,
  isConcreteVersionPin,
  missingPinnedVersionMessage,
  evaluateHostAgentInstall,
  buildProbeCommand,
  buildRemoteVersionCommand,
  buildBootstrapCommand,
  buildReadyProbeCommand,
  type ReadyProbe,
} from './ready.js';
import { decodePowershell } from './remote-cmd.js';

const MARK = '@@AGENTS_READY@@';

/** Decode the PowerShell script off a `-EncodedCommand` remote command. */
function decodeWindows(cmd: string): string {
  const m = cmd.match(/^powershell -NoProfile -EncodedCommand (\S+)$/);
  expect(m, `not an encoded PowerShell command: ${cmd}`).not.toBeNull();
  return decodePowershell(m![1]);
}

describe('ReadyProbe.timedOut — timeout vs unreachable distinction', () => {
  it('timedOut is absent on a successful probe', () => {
    const p: ReadyProbe = parseReadyProbe(`2.1.170\n${MARK}\nClaude\n`);
    expect(p.timedOut).toBeUndefined();
    expect(p.reachable).toBe(true);
  });

  it('timedOut is absent on a probe that got a non-timeout empty response', () => {
    // ssh connected but the sentinel never came (auth failure, wrong command, etc.)
    const p: ReadyProbe = parseReadyProbe('');
    expect(p.timedOut).toBeUndefined();
    expect(p.reachable).toBe(false);
  });

  it('parseReadyProbe never sets timedOut — that path is readyProbe-only', () => {
    // timedOut is set only by readyProbe() when sshExec signals a timeout kill.
    // parseReadyProbe() is a pure stdout parser and must never set it, regardless
    // of what stdout looks like. The sshExec timedOut detection is exercised by
    // the ssh-exec.test.ts PATH-stub tests.
    for (const stdout of ['', `2.1.170\n${MARK}\n`, `\n${MARK}\n`, 'garbage\nno-marker']) {
      expect(parseReadyProbe(stdout).timedOut).toBeUndefined();
    }
  });
});

describe('account slot readiness', () => {
  const now = Date.parse('2026-09-10T12:00:00Z');
  const view = (accounts: object[]) => JSON.stringify([{ agent: 'claude', versions: [{ signedIn: false }], accounts }]);
  const account = (over: object = {}) => {
    const row = { id: 'second', kind: 'native', harness: 'claude', verdict: 'live', checkedAt: new Date(now).toISOString(), usage: null, ...over };
    return { ...row, local: { verdict: row.verdict, checkedAt: row.checkedAt }, ...('local' in over ? { local: over.local } : {}) };
  };
  it('uses slots despite a broken shared binary home', () => {
    expect(viewAgentAccountEligibility(view([account({ verdict: 'missing' }), account()]), 'claude', now)).toMatchObject({ signedIn: true, pickerEligible: true });
    expect(viewAgentSignedIn('not json', 'claude')).toBeUndefined();
  });
  it('uses healthy local evidence despite a revoked peer aggregate', () => {
    const row = account({ verdict: 'revoked', local: { verdict: 'live', checkedAt: new Date(now).toISOString() } });
    expect(viewAgentAccountEligibility(view([row]), 'claude', now).accounts).toEqual(['second']);
    expect(() => evaluateHostAgentInstall(view([row]), { agent: 'claude', account: 'second' }, 'target')).not.toThrow();
  });
  it('refuses a peer-only live account and a stale local probe hidden by a fresh peer', () => {
    const absent = account({ local: { verdict: 'missing' } });
    expect(viewAgentAccountEligibility(view([absent]), 'claude', now).signedIn).toBe(false);
    expect(() => evaluateHostAgentInstall(view([absent]), { agent: 'claude', account: 'second' }, 'target')).toThrow('not provisioned');
    const stale = account({ local: { verdict: 'live', checkedAt: new Date(now - 60 * 60_000).toISOString() } });
    expect(viewAgentAccountEligibility(view([stale]), 'claude', now).signedIn).toBe(false);
  });
  it('does not infer account eligibility from versions', () => {
    expect(viewAgentSignedIn(JSON.stringify([{ agent: 'claude', versions: [{ signedIn: true }] }]), 'claude')).toBeUndefined();
    expect(viewAgentSignedIn(view([]), 'claude')).toBe(false);
  });
  it('admits a provisioned provider without a usage endpoint', () => {
    expect(viewAgentAccountEligibility(view([account({ kind: 'provider', verdict: 'ready', checkedAt: null })]), 'claude', now).signedIn).toBe(true);
  });
  it.each(['missing', 'revoked', 'expired'])('keeps %s accounts for explicit sign-in only', (verdict) => {
    expect(viewAgentAccountEligibility(view([account({ verdict })]), 'claude', now)).toMatchObject({ signedIn: false, pickerEligible: true });
  });
  it('refuses exhausted accounts', () => {
    expect(viewAgentAccountEligibility(view([account({ verdict: 'rate_limited' })]), 'claude', now)).toMatchObject({ signedIn: false, pickerEligible: false });
  });
  it.each([null, undefined, 'invalid', new Date(now - 41 * 60_000).toISOString()])('refuses usage without a usable capture time: %s', (capturedAt) => {
    expect(viewAgentAccountEligibility(view([account({ usage: { status: 'available', capturedAt } })]), 'claude', now).signedIn).toBe(false);
  });
  it('accepts recent synced snapshots independently of the display stale flag', () => {
    expect(viewAgentAccountEligibility(view([account({ usage: { status: 'available', stale: true, capturedAt: new Date(now - 16 * 60_000).toISOString() } })]), 'claude', now).signedIn).toBe(true);
  });
  it('refuses stale authentication', () => {
    expect(viewAgentAccountEligibility(view([account({ checkedAt: new Date(now - 60 * 60_000).toISOString() })]), 'claude', now).signedIn).toBe(false);
  });
});

describe('parseReadyProbe', () => {
  it('parses version + agent listing from one compound probe', () => {
    const stdout = `2.1.170\n${MARK}\nClaude (balanced)\nCodex (balanced)\n`;
    const p = parseReadyProbe(stdout);
    expect(p.reachable).toBe(true);
    expect(p.version).toBe('2.1.170');
    expect(p.view).toContain('Claude');
  });

  it('strips a leading v from the version', () => {
    expect(parseReadyProbe(`v2.1.170\n${MARK}\nClaude`).version).toBe('2.1.170');
  });

  it('reports reachable-but-not-installed when the version half is empty', () => {
    // agents-cli missing: `agents --version` printed nothing, but the login
    // shell still ran our printf so the marker (and thus reachability) is intact.
    const p = parseReadyProbe(`\n${MARK}\n`);
    expect(p.reachable).toBe(true);
    expect(p.version).toBeNull();
  });

  it('treats a missing marker as unreachable (ssh never ran our shell)', () => {
    const p = parseReadyProbe('');
    expect(p.reachable).toBe(false);
    expect(p.version).toBeNull();
    expect(p.view).toBe('');
  });
});

describe('viewHasAgent', () => {
  const view = 'Claude (balanced) 2.1.170\nCodex (balanced) 0.134.0';
  it('matches an installed agent case-insensitively', () => {
    expect(viewHasAgent(view, 'claude')).toBe(true);
    expect(viewHasAgent(view, 'codex')).toBe(true);
  });
  it('does not match an absent agent', () => {
    expect(viewHasAgent(view, 'gemini')).toBe(false);
  });
});

describe('isConcreteVersionPin (RUSH-2313)', () => {
  it('accepts exact pins and rejects aliases / empty', () => {
    expect(isConcreteVersionPin('0.145.0')).toBe(true);
    expect(isConcreteVersionPin('2.1.207')).toBe(true);
    expect(isConcreteVersionPin('latest')).toBe(false);
    expect(isConcreteVersionPin('oldest')).toBe(false);
    expect(isConcreteVersionPin('pinned')).toBe(false);
    expect(isConcreteVersionPin('default')).toBe(false);
    expect(isConcreteVersionPin('all')).toBe(false);
    expect(isConcreteVersionPin('any')).toBe(false);
    expect(isConcreteVersionPin(undefined)).toBe(false);
    expect(isConcreteVersionPin('')).toBe(false);
    expect(isConcreteVersionPin('../../etc')).toBe(false);
  });
});

describe('viewAgentVersions / viewHasAgentVersion (RUSH-2313)', () => {
  const view = JSON.stringify([
    {
      agent: 'codex',
      versions: [
        { version: '0.146.0', signedIn: true },
        { version: '0.144.0', signedIn: false },
      ],
    },
    { agent: 'claude', versions: [{ version: '2.1.207' }] },
  ]);

  it('lists installed versions from agents view --json', () => {
    expect(viewAgentVersions(view, 'codex')).toEqual(['0.146.0', '0.144.0']);
    expect(viewAgentVersions(view, 'gemini')).toEqual([]);
    expect(viewAgentVersions('not json', 'codex')).toBeUndefined();
  });

  it('confirms a pin that is present and rejects a pin that is not', () => {
    expect(viewHasAgentVersion(view, 'codex', '0.146.0')).toBe(true);
    expect(viewHasAgentVersion(view, 'codex', '0.145.0')).toBe(false);
    expect(viewHasAgentVersion(view, 'gemini', '1.0.0')).toBe(false);
  });

  it('falls back to a whole-token match on text listings', () => {
    const text = 'Claude (balanced) 2.1.170\nCodex (balanced) 0.134.0';
    expect(viewHasAgentVersion(text, 'codex', '0.134.0')).toBe(true);
    expect(viewHasAgentVersion(text, 'codex', '0.145.0')).toBeUndefined();
    expect(viewHasAgentVersion(text, 'gemini', '0.134.0')).toBe(false);
  });
});

describe('evaluateHostAgentInstall — fail-loud pin (RUSH-2313)', () => {
  const view = JSON.stringify([
    { agent: 'codex', versions: [{ version: '0.146.0' }, { version: '0.144.0' }] },
  ]);

  it('throws naming host + pin + installed list when the pin is missing', () => {
    expect(() => evaluateHostAgentInstall(view, { agent: 'codex', version: '0.145.0' }, 'yosemite-s0'))
      .toThrow(/Pinned codex@0\.145\.0 is not installed on "yosemite-s0"/);
    expect(() => evaluateHostAgentInstall(view, { agent: 'codex', version: '0.145.0' }, 'yosemite-s0'))
      .toThrow(/Installed on that box: 0\.146\.0, 0\.144\.0/);
    expect(() => evaluateHostAgentInstall(view, { agent: 'codex', version: '0.145.0' }, 'yosemite-s0'))
      .toThrow(/agents ssh yosemite-s0 -- agents add codex@0\.145\.0/);
  });

  it('passes when the pin is present', () => {
    expect(evaluateHostAgentInstall(view, { agent: 'codex', version: '0.146.0' }, 'box').warnings).toEqual([]);
  });

  it('still only warns for a bare agent name (no pin)', () => {
    const r = evaluateHostAgentInstall(view, { agent: 'gemini' }, 'box');
    expect(r.warnings[0]).toMatch(/gemini.*may not be installed on "box"/);
  });

  it('does not preflight-check version aliases — remote resolves them', () => {
    // @latest on a box with no gemini would still warn about the agent, but
    // must not invent a "pinned gemini@latest is not installed" error.
    expect(() => evaluateHostAgentInstall(view, { agent: 'codex', version: 'latest' }, 'box'))
      .not.toThrow();
  });

  it('missingPinnedVersionMessage names the install command', () => {
    expect(missingPinnedVersionMessage('mac-mini', 'codex', '0.145.0', ['0.146.0'])).toBe(
      'Pinned codex@0.145.0 is not installed on "mac-mini". Installed on that box: 0.146.0. ' +
        'Install it on that box: agents ssh mac-mini -- agents add codex@0.145.0',
    );
  });
});

describe('ready commands — POSIX branch unchanged', () => {
  it('probe uses uname, version/readyProbe/bootstrap use bash -lc', () => {
    expect(buildProbeCommand()).toBe('uname -s 2>/dev/null || echo unknown');
    expect(buildProbeCommand('linux')).toBe('uname -s 2>/dev/null || echo unknown');
    expect(buildRemoteVersionCommand('darwin')).toBe('bash -lc "agents --version 2>/dev/null"');
    expect(buildReadyProbeCommand()).toBe(
      `bash -lc 'agents --version 2>/dev/null; printf '\\''\\n${MARK}\\n'\\''; agents view --json 2>/dev/null || agents list 2>/dev/null'`,
    );
    expect(buildBootstrapCommand('@phnx-labs/agents-cli@2.1.170')).toBe(
      "bash -lc 'npm install -g @phnx-labs/agents-cli@2.1.170 2>&1 | tail -3; " +
        "if [ ! -d ~/.agents/.system ]; then agents setup 2>&1 | tail -3 || true; fi; agents --version'",
    );
  });
});

describe('ready commands — Windows branch speaks PowerShell', () => {
  it('probe runs a PowerShell OS check instead of uname', () => {
    const cmd = buildProbeCommand('windows');
    expect(cmd).not.toContain('uname');
    expect(decodeWindows(cmd)).toBe('[System.Environment]::OSVersion.Platform.ToString()');
  });

  it('version probe runs `agents --version` via PowerShell', () => {
    expect(decodeWindows(buildRemoteVersionCommand('windows'))).toBe("$ProgressPreference = 'SilentlyContinue'; & 'agents' '--version'; exit $LASTEXITCODE");
  });

  it('readyProbe emits the sentinel with Write-Output and branches on $LASTEXITCODE', () => {
    // Parser keys off the sentinel substring — this output must still parse.
    const script = decodeWindows(buildReadyProbeCommand('windows'));
    expect(script).toBe(
      `$ProgressPreference = 'SilentlyContinue'; agents --version 2>$null; Write-Output "${MARK}"; agents view --json 2>$null; if ($LASTEXITCODE -ne 0) { agents list 2>$null }`,
    );
    // The script's stdout shape (marker on its own line) round-trips through parseReadyProbe.
    const p = parseReadyProbe(`2.1.170\n${MARK}\nClaude (balanced)\n`);
    expect(p.reachable).toBe(true);
    expect(p.version).toBe('2.1.170');
  });

  it('bootstrap uses Select-Object -Last / Test-Path, never tail / [ -d ]', () => {
    const script = decodeWindows(buildBootstrapCommand('@phnx-labs/agents-cli@2.1.170', 'windows'));
    expect(script).toBe(
      "$ProgressPreference = 'SilentlyContinue'; " +
        "npm install -g '@phnx-labs/agents-cli@2.1.170' 2>&1 | Select-Object -Last 3; " +
        'if (-not (Test-Path "$HOME/.agents/.system")) { agents setup 2>&1 | Select-Object -Last 3 }; agents --version',
    );
    expect(script).not.toContain('tail -3');
    expect(script).not.toContain('[ ! -d');
  });
});

describe('target account provisioning', () => {
  it('accepts a provisioned native slot by ID or name but refuses missing slots', () => {
    const view = JSON.stringify([{ agent: 'codex', versions: [{ version: '1.2.3' }], accounts: [
      { id: 'id-second', name: 'second', verdict: 'unverified', local: { verdict: 'unverified' } },
      { id: 'id-missing', name: 'missing', verdict: 'missing' },
    ] }]);
    for (const account of ['id-second', 'second']) {
      expect(evaluateHostAgentInstall(view, { agent: 'codex', version: '1.2.3', account }, 'worker')).toEqual({ warnings: [] });
    }
    expect(() => evaluateHostAgentInstall(view, { agent: 'codex', account: 'missing' }, 'worker')).toThrow('not provisioned');
    expect(() => evaluateHostAgentInstall(view, { agent: 'codex', account: 'unknown' }, 'worker')).toThrow('not provisioned');
  });
});
