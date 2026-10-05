/** RUSH-3007: `CI` controlled vitest's extended hookTimeout profile (RUSH-2970) and setup.ts's leak
 * tripwires on the real ~/.agents (valid only on real CI). CI=true by hand on a live box
 * false-failed 129/129 files; AGENTS_ATTEST_PRODUCER=1 opts into the first only. */

/** vitest.config.ts: should this run get the extended-timeout test profile? */
export function shouldEnableCiTestProfile(env: NodeJS.ProcessEnv): boolean {
  return env.CI === 'true' || env.AGENTS_ATTEST_PRODUCER === '1';
}

/** tests/setup.ts: should the real-~/.agents leak tripwires arm this run? */
export function shouldArmHermeticGuards(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CI) && env.AGENTS_ATTEST_PRODUCER !== '1';
}
