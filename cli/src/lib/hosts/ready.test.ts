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

// PHNX-4116: ONE readiness gate. The box that RUNS computes `runReady`
// (`collectRunCandidates` → `readinessFromCandidate` over its native slots AND
// version homes); the dispatcher READS that answer off `agents view --json` and
// never re-derives freshness. These lock the placement seam
// (`viewAgentAccountEligibility` reads `runReady`, the probe maps it into the
// signal `resolveDeviceAuto` gates on).
describe('viewAgentAccountEligibility / viewAgentSignedIn — one readiness gate (PHNX-4116)', () => {
  const runReadyRow = (runReady: unknown, agent = 'claude') =>
    JSON.stringify([{ agent, runReady }]);

  it('reads runReady.ready as the sign-in gate; a ready box needs no reason', () => {
    const view = runReadyRow({ ready: true, reason: 'ready (work)', accounts: [{ name: 'work', ready: true, reason: 'ready' }] });
    expect(viewAgentSignedIn(view, 'claude')).toBe(true);
    expect(viewAgentAccountEligibility(view, 'claude')).toEqual({ signedIn: true, pickerEligible: true });
  });

  it('undefined for an unlisted agent or non-JSON', () => {
    const view = runReadyRow({ ready: true, reason: 'ready (work)', accounts: [] });
    expect(viewAgentSignedIn(view, 'codex')).toBeUndefined();
    expect(viewAgentSignedIn('not json', 'claude')).toBeUndefined();
  });

  it('a signed_out-only box is not ready but stays picker-eligible (launching it IS the login flow) and surfaces its reason', () => {
    const view = runReadyRow({ ready: false, reason: 'all signed_out', accounts: [{ name: 'work', ready: false, reason: 'signed_out' }] });
    expect(viewAgentAccountEligibility(view, 'claude')).toEqual({
      signedIn: false,
      pickerEligible: true,
      reason: 'all signed_out',
    });
  });

  it('a revoked-only box stays picker-eligible — a re-login clears a revoked token', () => {
    const view = runReadyRow({ ready: false, reason: 'all revoked', accounts: [{ name: 'work', ready: false, reason: 'revoked' }] });
    expect(viewAgentAccountEligibility(view, 'claude')).toEqual({
      signedIn: false,
      pickerEligible: true,
      reason: 'all revoked',
    });
  });

  it('a throttled-only box is neither ready nor picker-eligible — a login cannot clear a rate limit', () => {
    const view = runReadyRow({ ready: false, reason: 'all rate_limited', accounts: [{ name: 'work', ready: false, reason: 'rate_limited' }] });
    expect(viewAgentAccountEligibility(view, 'claude')).toEqual({
      signedIn: false,
      pickerEligible: false,
      reason: 'all rate_limited',
    });
  });

  it('a mixed box (one throttled, one signed out) stays picker-eligible on the signed-out account', () => {
    const view = runReadyRow({
      ready: false,
      reason: 'rate_limited, signed_out',
      accounts: [
        { name: 'a', ready: false, reason: 'rate_limited' },
        { name: 'b', ready: false, reason: 'signed_out' },
      ],
    });
    expect(viewAgentAccountEligibility(view, 'claude')).toEqual({
      signedIn: false,
      pickerEligible: true,
      reason: 'rate_limited, signed_out',
    });
  });

  // The stale-usage / dead-auth re-derivation is GONE: the box that runs already
  // decided, so a synced-only worker whose usage lags is never refused here — the
  // fleet-wide usage-sync lag that read as "no ready device" while `--device
  // <name>` launched fine (PHNX-4116). runReady.ready carries the verdict as-is.
  it('trusts a ready verdict even with no per-version usage evidence (the synced-worker case)', () => {
    const view = runReadyRow({ ready: true, reason: 'ready (work)', accounts: [{ name: 'work', ready: true, reason: 'ready' }] });
    expect(viewAgentAccountEligibility(view, 'claude')).toEqual({ signedIn: true, pickerEligible: true });
  });
});

// One-release fallback: an older remote CLI emits no `runReady`. signedIn = any
// launchable version (`isLaunchableSignedIn`, PHNX-3466); pickerEligible is
// permissive — the remote's own run path makes the finer call.
describe('viewAgentAccountEligibility — older-CLI fallback without runReady (PHNX-4116)', () => {
  it('signedIn = any launchable version; pickerEligible = true', () => {
    const launchable = JSON.stringify([{ agent: 'claude', versions: [{ signedIn: true, launchable: true }] }]);
    expect(viewAgentAccountEligibility(launchable, 'claude')).toEqual({ signedIn: true, pickerEligible: true });

    const notLaunchable = JSON.stringify([{ agent: 'claude', versions: [{ signedIn: true, launchable: false }] }]);
    expect(viewAgentAccountEligibility(notLaunchable, 'claude')).toEqual({ signedIn: false, pickerEligible: true });
  });

  it('one launchable version carries the device even when a sibling only inherits the global login', () => {
    const view = JSON.stringify([{ agent: 'claude', versions: [
      { signedIn: true, launchable: false },
      { signedIn: true, launchable: true },
    ] }]);
    expect(viewAgentAccountEligibility(view, 'claude')).toEqual({ signedIn: true, pickerEligible: true });
  });

  it('falls back to signedIn for a CLI old enough to omit launchable too', () => {
    const view = JSON.stringify([{ agent: 'codex', versions: [{ signedIn: false }, { signedIn: true }] }]);
    expect(viewAgentSignedIn(view, 'codex')).toBe(true);
    const out = JSON.stringify([{ agent: 'codex', versions: [{ signedIn: false }] }]);
    expect(viewAgentAccountEligibility(out, 'codex')).toEqual({ signedIn: false, pickerEligible: true });
  });

  it('undefined when the agent row carries neither runReady nor a boolean signedIn', () => {
    const view = JSON.stringify([{ agent: 'claude', versions: [{}] }]);
    expect(viewAgentAccountEligibility(view, 'claude')).toEqual({ signedIn: undefined, pickerEligible: undefined });
  });

  // #3705: the fallback must keep the pre-PHNX-4116 throttle exclusion, or a
  // throttled-but-launchable old-CLI worker reads signedIn: true and slips into
  // `--device auto`'s pick during a rolling upgrade. A FRESH rate_limit
  // disqualifies; a STALE one is unverified, not disqualifying.
  it('a FRESH rate_limited launchable version is not signed in (throttle exclusion restored)', () => {
    const now = Date.now();
    const view = JSON.stringify([{ agent: 'claude', versions: [{
      signedIn: true,
      launchable: true,
      usageStatus: 'rate_limited',
      usageCapturedAt: new Date(now - 60_000).toISOString(), // 1 min old — fresh
    }] }]);
    expect(viewAgentAccountEligibility(view, 'claude', now)).toEqual({ signedIn: false, pickerEligible: false });
    // The default-`now` entry point (`viewAgentSignedIn`) agrees — a fresh
    // reading is fresh under Date.now() too.
    expect(viewAgentSignedIn(view, 'claude')).toBe(false);
  });

  it('a STALE rate_limited launchable version is unverified, so it stays signed in', () => {
    const now = Date.now();
    const view = JSON.stringify([{ agent: 'claude', versions: [{
      signedIn: true,
      launchable: true,
      usageStatus: 'rate_limited',
      usageCapturedAt: new Date(now - 60 * 60_000).toISOString(), // 1 h old — stale
    }] }]);
    expect(viewAgentAccountEligibility(view, 'claude', now)).toEqual({ signedIn: true, pickerEligible: true });
    expect(viewAgentSignedIn(view, 'claude')).toBe(true);
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
    // With the dispatcher's usage envelope on stdin, the silent ingest runs FIRST
    // (PHNX-4116) and the version/marker/listing shape after it is unchanged.
    expect(buildReadyProbeCommand(undefined, { ingestUsage: true })).toBe(
      `bash -lc 'agents __usage-ingest 2>/dev/null; agents --version 2>/dev/null; printf '\\''\\n${MARK}\\n'\\''; agents view --json 2>/dev/null || agents list 2>/dev/null'`,
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
    // The agents.ps1 shim drops ssh-piped stdin, so the ingest arm reads the
    // payload into a temp file and hands the verb `--from <path>` (PHNX-4116).
    const ingesting = decodeWindows(buildReadyProbeCommand('windows', { ingestUsage: true }));
    expect(ingesting.startsWith(`$ProgressPreference = 'SilentlyContinue'; $in = [Console]::In.ReadToEnd(); $tmp = $null; try { $tmp = [System.IO.Path]::GetTempFileName(); [System.IO.File]::WriteAllText($tmp, $in); agents __usage-ingest --from $tmp 2>$null } finally { if ($tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } }; agents --version 2>$null; Write-Output "${MARK}"`)).toBe(true);
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
