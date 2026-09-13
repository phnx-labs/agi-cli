/**
 * `lib/storage` — the surface-agnostic core the managed-storage surfaces share:
 *
 *   - {@link selection}  the ONE managed-vs-BYO selection policy.
 *   - {@link visibility} the ONE visibility model + product default (`me`).
 *
 * Consume the SELECTION + VISIBILITY POLICY from here; keep each surface's typed,
 * `kind`-tagged backend adapter (endpoint, namespace, covers) in that surface's
 * own module. `agents traces` (`lib/traces/`) and the `sessions` backup sync are
 * the current adapters. (Artifact sharing was an adapter too, until it moved to
 * the standalone `artifacts` CLI, PHNX-3992.)
 */

export {
  type StorageBackendKind,
  type StorageSelectionOpts,
  selectStorageBackendKind,
  isManagedSelection,
} from './selection.js';

export {
  type ShareVisibility,
  type VisibilityFlags,
  PUBLISH_VISIBILITY_LEVELS,
  EDITABLE_VISIBILITY_LEVELS,
  MANAGED_DEFAULT_VISIBILITY,
  BYO_DEFAULT_VISIBILITY,
  defaultVisibilityForBackend,
  explicitVisibility,
  resolveVisibility,
  publishVisibility,
} from './visibility.js';
