import { describe, it, expect } from 'vitest';
import { planUmbrellaStages } from './sync-umbrella.js';

describe('planUmbrellaStages', () => {
  it('bare: fetch repos only, then reconcile (secrets are opt-in)', () => {
    expect(planUmbrellaStages({})).toEqual({
      fetchRepos: true, fetchSecrets: false, reconcile: true,
    });
  });

  it('--local: reconcile only, no fetch', () => {
    expect(planUmbrellaStages({ local: true })).toEqual({
      fetchRepos: false, fetchSecrets: false, reconcile: true,
    });
  });

  it('--local wins even if other flags are set', () => {
    expect(planUmbrellaStages({ local: true, repos: true, cloud: true })).toEqual({
      fetchRepos: false, fetchSecrets: false, reconcile: true,
    });
  });

  it('--cloud: fetch repos only, skip reconcile (secrets are opt-in)', () => {
    expect(planUmbrellaStages({ cloud: true })).toEqual({
      fetchRepos: true, fetchSecrets: false, reconcile: false,
    });
  });

  it('single selector (--secrets): fetch only that, then reconcile', () => {
    expect(planUmbrellaStages({ secrets: true })).toEqual({
      fetchRepos: false, fetchSecrets: true, reconcile: true,
    });
  });

  it('multiple selectors: fetch exactly those, then reconcile', () => {
    expect(planUmbrellaStages({ repos: true, secrets: true })).toEqual({
      fetchRepos: true, fetchSecrets: true, reconcile: true,
    });
  });

  it('selector + --cloud: fetch only the selected, skip reconcile', () => {
    expect(planUmbrellaStages({ repos: true, cloud: true })).toEqual({
      fetchRepos: true, fetchSecrets: false, reconcile: false,
    });
  });
});
