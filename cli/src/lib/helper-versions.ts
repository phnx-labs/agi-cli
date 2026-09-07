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
export type HelperName = 'menubar' | 'computer-mac' | 'computer-win';

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
 * of its independent release train. The keychain helper moved with the
 * standalone `secrets` engine (PHNX-3989) — it downloads and verifies its own
 * helper release now, off this table entirely.
 */
export const HELPER_RELEASES: Readonly<Record<HelperName, HelperRelease>> = {
  menubar: { tagPrefix: 'menubar', floor: '1.0.0' },
  'computer-mac': { tagPrefix: 'computer-mac', floor: '1.0.0' },
  // The Windows helper is a bare .exe, not an .app bundle, so it does not share
  // helper-download.ts's zip/codesign/notarize machinery -- but it has the same
  // URL problem, so it shares the tag namespace and the floor.
  'computer-win': { tagPrefix: 'computer-win', floor: '1.0.0' },
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
