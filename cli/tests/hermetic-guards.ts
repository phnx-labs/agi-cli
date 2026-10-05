
export function shouldEnableCiTestProfile(env: NodeJS.ProcessEnv): boolean {
  // Attestation producers need CI timeouts without arming real-home leak guards on an active machine.
  return env.CI === 'true' || env.AGENTS_ATTEST_PRODUCER === '1';
}

export function shouldArmHermeticGuards(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CI) && env.AGENTS_ATTEST_PRODUCER !== '1';
}
