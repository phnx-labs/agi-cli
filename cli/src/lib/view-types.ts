import type { ConfiguredModelSource } from './models.js';
import type { ProfileSummary } from './profiles.js';
import type { AgentId } from './types.js';
import type { AuthVerdict } from './auth-health.js';
import type { AccountListEntryJson } from './account-catalog.js';

export type SyncState = 'synced' | 'new' | 'modified' | 'deleted';

export interface ViewJsonVersion {
  /** Stable installation label; retained for existing machine consumers. */
  version: string;
  /** Actual vendor release, independent of the stable installation label. */
  releaseVersion?: string;
  isDefault: boolean;
  isolated: boolean;
  isIsolatedDefault: boolean;
  signedIn: boolean;
  /** Whether this version home can actually spawn a signed-in agent (`isLaunchableSignedIn`), unlike
   * display `signedIn`, which is true when it only inherits the global login. `--device auto` gates
   * on this (PHNX-3466); older remotes fall back to `signedIn`. */
  launchable: boolean;
  /** Live cached authentication verdict for this installed version. */
  authVerdict: AuthVerdict | null;
  /** Epoch milliseconds when authVerdict was last checked, or null if absent. */
  authCheckedAt: number | null;
  email: string | null;
  accountId?: string | null;
  organizationType?: string | null;
  organizationName?: string | null;
  plan: string | null;
  usageStatus: 'available' | 'rate_limited' | 'out_of_credits' | null;
  /** ISO timestamp of the usage snapshot behind usageStatus, or null if absent. */
  usageCapturedAt: string | null;
  overageCredits?: { amount: number; currency: string } | null;
  /** Human-readable reason a usage snapshot is absent: a refresh failure or "not collected yet".
   * Always a full sentence, never the internal `'stale'` sentinel (PHNX-3348). */
  usageError?: string | null;
  windows: Array<{
    key: 'session' | 'week' | 'sonnet_week' | 'month';
    label?: string;
    usedPercent: number;
    resetsAt: string | null;
  }>;
  unavailable?: {
    reason: 'session_limit' | 'out_of_credits';
    resetsAt?: string;
  };
  lastActive: string | null;
  path: string;
  configuredModel?: { model: string; source: ConfiguredModelSource } | null;
  resources?: VersionResourcesJson;
}

/** Whether a `run` here would find a launch-ready account, from the router's own enumeration
 * (`collectRunCandidates`, incl. native slots), not `versions[]` (PHNX-4116). `--device auto`
 * reads this from `agents view --json` so dispatcher and runner agree. */
export interface ViewJsonRunReady {
  /** At least one account is launch-ready right now. */
  ready: boolean;
  /** When ready, names a ready account (`ready (work)`); when not, the aggregate exclusion reason
   * (`all signed_out`, `no accounts`, or a comma list). */
  reason: string;
  /** Per-account verdict; `reason` is `'ready'` for a ready account, else the
   *  `readinessFromCandidate` reason (`signed_out`/`revoked`/`rate_limited`/…). */
  accounts: Array<{ name: string; ready: boolean; reason: string }>;
}

export interface ViewJsonAgent {
  agent: AgentId;
  versions: ViewJsonVersion[];
  /** The public JSON v2 account projection `accounts list --json` emits, never the internal catalog
   * row, so consumers (AGI EXT) read one shape. */
  accounts?: AccountListEntryJson[];
  /** The one run-readiness gate for this agent on this box (PHNX-4116); absent on older remote CLIs,
   * which fall back to per-version `launchable`. */
  runReady?: ViewJsonRunReady;
  harnesses: ProfileSummary[];
}

export type ResourceSection = 'commands' | 'skills' | 'mcp' | 'memory' | 'hooks' | 'workflows' | 'plugins';

export interface ResourceItemJson {
  name: string;
  scope?: 'user' | 'project';
  syncState?: SyncState;
  description?: string;
  ruleCount?: number;
}

export interface VersionResourcesJson {
  commands?: ResourceItemJson[];
  skills?: ResourceItemJson[];
  mcp?: ResourceItemJson[];
  memory?: ResourceItemJson[];
  hooks?: ResourceItemJson[];
  workflows?: ResourceItemJson[];
  plugins?: ResourceItemJson[];
}
