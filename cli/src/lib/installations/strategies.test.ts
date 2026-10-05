/** Strategy selection must be driven by the agent registry's declared shape, not an agent id, so
 * `agents update` covers every harness `agents add` manages, including later ones. These tests
 * derive expectations from `AGENTS`; a hardcoded harness list would just move the drift. */
import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { AGENTS, ALL_AGENT_IDS, isSelfUpdatingAgent } from '../agents.js';
import { getBinaryPath, isGlobalBinaryAgent } from './versions.js';
import { installationDir } from './store.js';
import { assertValidRelease, selectUpdateStrategy, supportsPinnedUpdate } from './strategies.js';

/** Every harness `agents add` can install — i.e. everything with an install path. */
const INSTALLABLE = ALL_AGENT_IDS.filter((id) => AGENTS[id].npmPackage || AGENTS[id].installScript);

/** Mirrors the production probe: is the swappable link farm the real launch target? */
function linkFarmIsLaunchTarget(agent: (typeof ALL_AGENT_IDS)[number]): boolean {
  const probe = '0.0.0-probe';
  return getBinaryPath(agent, probe)
    === path.join(installationDir(agent, probe), 'node_modules', '.bin', AGENTS[agent].cliCommand);
}

/** Harnesses this command can update in place today. */
const SUPPORTED = INSTALLABLE.filter(
  (id) => AGENTS[id].npmPackage || isGlobalBinaryAgent(id) || linkFarmIsLaunchTarget(id)
);

describe('selectUpdateStrategy', () => {
  it('covers every harness agents add can install, or says why not', () => {
    expect(INSTALLABLE.length).toBeGreaterThan(10);
    for (const agent of SUPPORTED) {
      expect(() => selectUpdateStrategy(agent), agent).not.toThrow();
    }
    // Nothing is silently skipped: an unsupported harness throws (asserted below).
    expect(SUPPORTED.length).toBeGreaterThanOrEqual(INSTALLABLE.length - 1);
  });

  it('routes each harness by its declared capability, never by id', () => {
    for (const agent of INSTALLABLE) {
      if (!SUPPORTED.includes(agent)) continue;
      const expected = AGENTS[agent].npmPackage
        ? 'npm-package'
        : isGlobalBinaryAgent(agent)
          ? 'global-binary'
          : 'install-script';
      expect(selectUpdateStrategy(agent).id, agent).toBe(expected);
    }
  });

  it('refuses a harness whose binary is not in the version dir it would swap', () => {
    // Swapping the link farm would leave the real launch target untouched, so
    // recording a new release would be a lie. grok is the case today; the check
    // is derived from getBinaryPath, so it covers any future one.
    const outside = INSTALLABLE.filter(
      (id) => !AGENTS[id].npmPackage && !isGlobalBinaryAgent(id) && !linkFarmIsLaunchTarget(id)
    );
    expect(outside.length).toBeGreaterThan(0);
    for (const agent of outside) {
      expect(() => selectUpdateStrategy(agent), agent).toThrow(/outside the managed version directory/);
    }
  });

  it('prefers the npm package when a harness declares both a package and a script', () => {
    // kimi is the case; assert the property rather than the id so a second such
    // harness is covered automatically.
    const both = INSTALLABLE.filter((id) => AGENTS[id].npmPackage && AGENTS[id].installScript);
    expect(both.length).toBeGreaterThan(0);
    for (const agent of both) {
      expect(selectUpdateStrategy(agent).id, agent).toBe('npm-package');
    }
  });

  it('marks a strategy transactional only when the release can be staged per-installation', () => {
    for (const agent of SUPPORTED) {
      const strategy = selectUpdateStrategy(agent);
      // Only npm packages can be fetched into a sibling dir and swapped in; the
      // installer-driven harnesses mutate a location the vendor owns.
      expect(strategy.transactional, agent).toBe(strategy.id === 'npm-package');
      // A shared binary is exactly the global-binary case, and it is what makes
      // an update fan out to sibling installations.
      expect(strategy.sharedBinary, agent).toBe(strategy.id === 'global-binary');
    }
  });

  it('fails loud for a harness with no install path instead of no-opping', () => {
    const unmanaged = ALL_AGENT_IDS.find((id) => !AGENTS[id].npmPackage && !AGENTS[id].installScript);
    if (!unmanaged) return; // every harness is installable today; nothing to assert
    expect(() => selectUpdateStrategy(unmanaged)).toThrow(/not installed by agents-cli/);
  });
});

describe('supportsPinnedUpdate', () => {
  it('is true exactly for harnesses with a pinnable release', () => {
    for (const agent of INSTALLABLE) {
      const pinnable = !!AGENTS[agent].npmPackage || !isSelfUpdatingAgent(agent);
      expect(supportsPinnedUpdate(agent), agent).toBe(pinnable);
    }
  });
});

describe('assertValidRelease', () => {
  it('accepts the release tokens the install path accepts', () => {
    for (const release of ['latest', 'oldest', '2.1.220', '0.2.111-beta.1']) {
      expect(() => assertValidRelease(release)).not.toThrow();
    }
  });

  it('rejects a token that could escape a path or a package spec', () => {
    for (const release of ['../../etc', 'a; rm -rf /', '..']) {
      expect(() => assertValidRelease(release), release).toThrow(/Invalid release/);
    }
  });
});
