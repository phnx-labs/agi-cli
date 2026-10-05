import type { AgentId } from '../types.js';

/** Schema version of the on-disk installation record. Bump only for a change a previous CLI
 * could not read; INSTALLATION_SCHEMA is asserted on read so a newer record fails loud rather
 * than being misread. */
export const INSTALLATION_SCHEMA = 1;

/** File name of the record, written at the root of a version dir. */
export const INSTALLATION_RECORD_FILE = 'installation.json';

/** One entry in an installation's release history, appended on every successful update so
 * `agents update --json` can report where a frozen installation came from without consulting
 * the vendor. */
export interface InstallationRelease {
  /** The vendor release that was live for this span. */
  releaseVersion: string;
  /** ISO-8601 timestamp at which this release became live. */
  at: string;
}

/** A frozen agent installation: its identity (`id`, `label`) is stable for life, while the
 * vendor release (`releaseVersion`) moves only on `agents update`. Persisted references name
 * the label, so a release change never breaks them. */
export interface Installation {
  schema: number;
  /** Opaque, stable, never reused. Survives every update. */
  id: string;
  agent: AgentId;
  /** The addressable name of this installation: the version-dir basename and the token users
   * type in `agents update <agent>@<label>`; frozen at creation. */
  label: string;
  /** The vendor release currently installed on disk. Moves on update. */
  releaseVersion: string;
  createdAt: string;
  updatedAt: string;
  /** Newest last. Always non-empty: creation seeds it with the first release. */
  history: InstallationRelease[];
  /** How the automatic-update pass treats this installation: `'latest'` rides the pass,
   * `'pinned'` excludes it (set by `--to <concrete>`, cleared by `--to latest`). Absent means
   * `'latest'`. Read via `effectiveUpdatePolicy`, never directly. */
  updatePolicy?: UpdatePolicy;
}

/** See {@link Installation.updatePolicy}. */
export type UpdatePolicy = 'latest' | 'pinned';

/** How an installation's release is replaced; selected from the agent registry's capabilities,
 * never an agent id (see `selectUpdateStrategy`). */
export type UpdateStrategyId =
  /** Agent ships an npm package: a pinnable release staged into the version dir. */
  | 'npm-package'
  /** One global self-updating binary shared by every installation of the agent. */
  | 'global-binary'
  /** An official install script with no pinnable version, re-imported per install. */
  | 'install-script';

/** Outcome of a single `agents update` run against one installation. */
export interface UpdateOutcome {
  installation: Installation;
  strategy: UpdateStrategyId;
  fromRelease: string;
  toRelease: string;
  /** True when the resolved target already matched the installed release. */
  unchanged: boolean;
  /** No swap occurred because activity, cancellation, or policy prevented it. */
  deferred?: string;
  /** Installations other than the target whose recorded release also moved because the strategy
   * replaced a binary they share (global-binary only). */
  alsoUpdated: Installation[];
}
