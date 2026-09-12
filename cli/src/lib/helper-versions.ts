/**
 * Which build of each native helper this CLI expects, and where its release
 * lives — the module that decouples helper distribution from CLI releases.
 *
 * WHY THIS EXISTS. `helperAssetUrls` used to build
 * `releases/download/v${cliVersion}/<asset>`, keying every helper to the CLI's
 * own tag. That is coupled in BOTH directions and each one hurts:
 *
 *   - A CLI release had to re-stage every helper asset onto its new tag, or the
 *     download 404'd. That is what chained an ordinary release to a Mac.
 *   - A helper fix could not reach anyone without cutting a CLI release, because
 *     no URL existed that a shipped CLI would look at.
 *
 * Helpers now publish to their OWN tags (`<helper>/v<x.y.z>`) and this table
 * records the FLOOR — the build this CLI was tested against. A floor, not an
 * exact pin: a pin would fix the first problem and leave the second, since an
 * improved helper would still need a CLI release to be reachable. The floor is
 * what a channel manifest can later resolve *upward* from (newest >= floor),
 * without another rewrite of the download path.
 *
 * The floor is also the offline answer: it names an IMMUTABLE tag that always
 * exists, so a machine that cannot reach a manifest still has exactly one
 * correct URL rather than a guess.
 *
 * Bumping an entry here is a deliberate act — it says "this CLI has been tested
 * against that helper build". It is not a mirror of the CLI version and must
 * never be derived from `getCliVersion()`.
 */

/** The helpers that have their own release train. */
export type HelperName = 'menubar';

/** One helper's release identity. */
export interface HelperRelease {
  /** Tag prefix — the release is `<tagPrefix>/v<version>`. */
  tagPrefix: string;
  /**
   * Lowest helper build this CLI is known to work with. Resolution may pick a
   * NEWER build; it must never pick an older one.
   */
  floor: string;
}

/**
 * Floors, by helper.
 *
 * `menubar` starts at 1.0.0 — the first build published under its own tag
 * rather than the CLI's. It is not "version 1 of the helper"; it is version 1
 * of its independent release train.
 *
 * Two helper families have since left this table entirely, both for the same
 * reason: their engine became a standalone CLI that resolves and verifies its
 * OWN helper release. The keychain helper went with `secrets` (PHNX-3989); the
 * macOS and Windows computer helpers went with `computer` (PHNX-4075). A floor
 * recorded here for a helper this CLI never downloads would be a lying table —
 * it would claim a distribution responsibility agents-cli no longer has.
 */
export const HELPER_RELEASES: Readonly<Record<HelperName, HelperRelease>> = {
  menubar: { tagPrefix: 'menubar', floor: '1.3.0' },
};

/** The release tag for one helper at one version, e.g. `menubar/v1.0.0`. */
export function helperTag(helper: HelperName, version: string): string {
  const release = HELPER_RELEASES[helper];
  if (!release) throw new Error(`unknown helper '${helper}' (want: ${Object.keys(HELPER_RELEASES).join(', ')})`);
  return `${release.tagPrefix}/v${version}`;
}

/** The floor build for one helper — the version used when nothing resolves higher. */
export function helperFloor(helper: HelperName): string {
  const release = HELPER_RELEASES[helper];
  if (!release) throw new Error(`unknown helper '${helper}' (want: ${Object.keys(HELPER_RELEASES).join(', ')})`);
  return release.floor;
}
