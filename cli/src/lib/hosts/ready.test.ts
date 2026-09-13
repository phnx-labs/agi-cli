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
import { decodeRenderedPowershell } from './remote-cmd.test-fixture.js';

const MARK = '@@AGENTS_READY@@';

/** Decode the PowerShell script off a `-EncodedCommand` remote command. */
const decodeWindows = decodeRenderedPowershell;

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

describe('viewAgentSignedIn', () => {
  const view = JSON.stringify([{ agent: 'codex', versions: [{ signedIn: false }, { signedIn: true }] }]);
  it('reads the per-version sign-in split from agents view JSON', () => {
    expect(viewAgentSignedIn(view, 'codex')).toBe(true);
    expect(viewAgentSignedIn(view, 'claude')).toBeUndefined();
    expect(viewAgentSignedIn('not json', 'codex')).toBeUndefined();
  });

  it('rejects signed-in versions that are capped', () => {
    const view = JSON.stringify([{ agent: 'codex', versions: [
      { signedIn: true, usageStatus: 'rate_limited' },
      { signedIn: true, usageStatus: 'out_of_credits' },
    ] }]);
    expect(viewAgentSignedIn(view, 'codex')).toBe(false);
  });

  it('keeps signed-out login targets picker-eligible but rejects throttled-only devices', () => {
    const signedOut = JSON.stringify([{ agent: 'codex', versions: [
      { signedIn: false, usageStatus: null },
      { signedIn: true, usageStatus: 'rate_limited' },
    ] }]);
    const throttled = JSON.stringify([{ agent: 'codex', versions: [
      { signedIn: true, usageStatus: 'rate_limited' },
      { signedIn: true, usageStatus: 'out_of_credits' },
    ] }]);
    expect(viewAgentAccountEligibility(signedOut, 'codex')).toEqual({
      signedIn: false,
      pickerEligible: true,
    });
    expect(viewAgentAccountEligibility(throttled, 'codex')).toEqual({
      signedIn: false,
      pickerEligible: false,
    });
  });

  it('keeps a remotely revoked credential picker-eligible without ranking it as ready', () => {
    const view = JSON.stringify([{ agent: 'claude', versions: [
      { signedIn: true, authVerdict: 'revoked', usageStatus: 'available' },
    ] }]);
    expect(viewAgentAccountEligibility(view, 'claude')).toEqual({
      signedIn: false,
      pickerEligible: true,
    });
  });

  it('rejects readiness whose auth or usage evidence is stale', () => {
    const now = Date.parse('2026-09-04T12:00:00Z');
    const stale = JSON.stringify([{ agent: 'claude', versions: [{
      signedIn: true,
      launchable: true,
      authVerdict: 'live',
      authCheckedAt: now - 21 * 60_000,
      usageStatus: 'available',
      usageCapturedAt: new Date(now - 41 * 60_000).toISOString(),
    }] }]);
    expect(viewAgentAccountEligibility(stale, 'claude', now)).toEqual({ signedIn: false, pickerEligible: false });

    const fresh = JSON.stringify([{ agent: 'claude', versions: [{
      signedIn: true,
      launchable: true,
      authVerdict: 'live',
      authCheckedAt: now - 60_000,
      usageStatus: 'available',
      usageCapturedAt: new Date(now - 60_000).toISOString(),
    }] }]);
    expect(viewAgentAccountEligibility(fresh, 'claude', now)).toEqual({ signedIn: true, pickerEligible: true });
  });
});

// PHNX-3466: `--device auto` remote placement must judge a box by the SAME strict
// per-version launchability the LOCAL candidate uses (`collectRunCandidates` →
// `isLaunchableSignedIn`), not the display `signedIn` that inherits the global
// HOME login. The signal rides `agents view --json`'s new per-version `launchable`
// field; these lock the placement seam (`viewAgentAccountEligibility` reads it,
// `probeRemoteReadiness` maps it into the signal `resolveDeviceAuto` gates on).
describe('viewAgentAccountEligibility — launchable gates remote placement (PHNX-3466)', () => {
  it('EXCLUDES a version signed-in-but-not-launchable (inherits global login, empty version home)', () => {
    // The exact bug: the version home has no per-version credential, so it only
    // *inherits* the active/global HOME login. `signedIn` reads true (who is
    // logged in) but the isolated launch dies at spawn — `launchable` is false.
    const view = JSON.stringify([{ agent: 'claude', versions: [
      { signedIn: true, launchable: false, usageStatus: 'available' },
    ] }]);
    expect(viewAgentAccountEligibility(view, 'claude')).toEqual({
      // Not ready → excluded from the non-picker `--device auto` candidate set.
      signedIn: false,
      // Still picker-eligible: launching it IS the per-version login flow.
      pickerEligible: true,
    });
  });

  it('keeps a blind-but-launchable worker eligible (per-version credential, no usage snapshot — RUSH-2392)', () => {
    // A worker box with a real per-version setup-token credential but whose usage
    // endpoint 403s (no snapshot → usageStatus null). launchable is true, so it
    // stays a valid placement target — the "unverified stays eligible" rule.
    const view = JSON.stringify([{ agent: 'claude', versions: [
      { signedIn: true, launchable: true, usageStatus: null },
    ] }]);
    expect(viewAgentAccountEligibility(view, 'claude')).toEqual({
      signedIn: true,
      pickerEligible: true,
    });
  });

  it('falls back to signedIn on an older remote CLI that omits launchable (no rolling-fleet regression)', () => {
    // A remote CLI predating the field emits no `launchable`; the gate must read
    // `signedIn` exactly as it did before — a signed-in version stays eligible.
    const legacyView = JSON.stringify([{ agent: 'claude', versions: [
      { signedIn: true, usageStatus: 'available' },
    ] }]);
    expect(viewAgentAccountEligibility(legacyView, 'claude')).toEqual({
      signedIn: true,
      pickerEligible: true,
    });
    // ...and a signed-out legacy version stays excluded-but-picker-eligible.
    const legacyOut = JSON.stringify([{ agent: 'claude', versions: [{ signedIn: false }] }]);
    expect(viewAgentAccountEligibility(legacyOut, 'claude')).toEqual({
      signedIn: false,
      pickerEligible: true,
    });
  });

  it('a box whose only launchable version is throttled is neither ready nor picker-eligible', () => {
    // launchable:true but rate_limited → not ready, and not picker-eligible
    // (a login cannot clear a throttle — only a window reset). Matches the
    // signed-in-but-capped semantics for the launchable signal.
    const view = JSON.stringify([{ agent: 'claude', versions: [
      { signedIn: true, launchable: true, usageStatus: 'rate_limited' },
    ] }]);
    expect(viewAgentAccountEligibility(view, 'claude')).toEqual({
      signedIn: false,
      pickerEligible: false,
    });
  });

  it('one launchable version keeps the device eligible even when a sibling only inherits the global login', () => {
    // Real multi-version box: v1 empty home (launchable:false), v2 real
    // per-version login (launchable:true). The device can run claude, so it must
    // stay eligible — the launchable version carries it.
    const view = JSON.stringify([{ agent: 'claude', versions: [
      { signedIn: true, launchable: false, usageStatus: 'available' },
      { signedIn: true, launchable: true, usageStatus: 'available' },
    ] }]);
    expect(viewAgentAccountEligibility(view, 'claude')).toEqual({
      signedIn: true,
      pickerEligible: true,
    });
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
    const script = decodeWindows(buildRemoteVersionCommand('windows'));
    // The npm `agents.ps1` shim is bypassed — it splats `$args` into native
    // node.exe, which is where PowerShell 5.1 loses arguments.
    expect(script).not.toContain("& 'agents'");
    expect(script).toMatch(/\$zi\.Arguments\s*=\s*\$zr\s*\+\s*'--version'/);
    expect(script).toContain('exit $zq');
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
