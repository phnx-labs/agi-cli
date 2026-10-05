
export function shouldEnableCiTestProfile(env: NodeJS.ProcessEnv): boolean {

  return env.CI === 'true' || env.AGENTS_ATTEST_PRODUCER === '1';
}

export function shouldArmHermeticGuards(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CI) && env.AGENTS_ATTEST_PRODUCER !== '1';
}
