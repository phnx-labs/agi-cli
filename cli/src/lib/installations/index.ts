
export {
  type Installation,
  type InstallationRelease,
  type UpdateOutcome,
  type UpdateStrategyId,
  type UpdatePolicy,
} from './types.js';

export {
  createInstallation,
  listInstallations,
  recordRelease,
  MANAGED_INSTALLATION_LABEL,
  resolveManagedInstallation,
  ensureHarnessInstallation,
  type EnsureHarnessInstallationResult,
} from './store.js';

export {
  describeInstallation,
  resolveInstallation,
  type ResolveInstallationOptions,
} from './resolve.js';

export {
  selectUpdateStrategy,
  supportsPinnedUpdate,
  type UpdateStrategy,
} from './strategies.js';

export { updateInstallation, type UpdateInstallationOptions } from './update.js';

export {
  effectiveUpdatePolicy,
  isAutoUpdateEnabledForAgent,
  isGlobalAutoUpdateEnabled,
  rawAgentAutoUpdateSetting,
  rawGlobalAutoUpdateSetting,
  setAgentAutoUpdateEnabled,
  setGlobalAutoUpdateEnabled,
  setInstallationUpdatePolicy,
  unsetAgentAutoUpdateEnabled,
  unsetGlobalAutoUpdateEnabled,
} from './update-policy.js';

export {
  planAutoUpdates,
  runAutoUpdatePass,
  listInstallationSnapshots,
  type AutoUpdatePlanEntry,
  type AutoUpdatePassOutcome,
  type AutoUpdatePassOptions,
  type AutoUpdatePassResult,
} from './update-runtime.js';

export {
  installationLooksActive,
  isInstallationLikelyActive,
  realProcessSnapshot,
  type ProcessSnapshot,
} from './active-check.js';

export { recordLaunchLease, hasLiveLaunchLease } from './shims.js';
