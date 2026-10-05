/** Contract every resource staleness checker implements; the aggregator in `../index.ts` calls only
 * `listNames`, `build` and `isFresh`. Entries are `unknown` on purpose: each checker round-trips
 * its own shape through JSON. */

export interface ResourceChecker {
  /** Stable identifier; matches the manifest field name. */
  readonly type: string;

  /** Names of every resource currently available across this checker's layers. */
  listNames(cwd: string): string[];

  /** Build a manifest entry for one name; null when no source file is found, so the aggregator
   * drops it and the name-set diff stays accurate. */
  build(name: string, cwd: string): unknown | null;

  /** Check whether a stored entry still reflects current source. Called only after the name set
   * matches; false triggers a re-sync. */
  isFresh(name: string, stored: unknown, cwd: string): boolean;
}

/** Strict-typed wrapper for checkers whose entry shape varies, avoiding `unknown` casts in
 * callers. */
export interface TypedResourceChecker<TEntry> extends ResourceChecker {
  build(name: string, cwd: string): TEntry | null;
  isFresh(name: string, stored: TEntry, cwd: string): boolean;
}
