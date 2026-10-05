/** Which build of each native helper this CLI expects and where its release lives, decoupling
 * helper distribution from CLI releases. Entries are floors (newest >= floor may resolve), bumped
 * deliberately when tested; never derive them from `getCliVersion()`. */

/** The helpers that have their own release train. */
export type HelperName = 'menubar';

/** One helper's release identity. */
interface HelperRelease {
  /** Tag prefix — the release is `<tagPrefix>/v<version>`. */
  tagPrefix: string;
  /** Lowest helper build this CLI is known to work with. Resolution may pick a newer build,
   * never an older one. */
  floor: string;
}

/** Floors by helper. `menubar` starts at 1.0.0, version 1 of its independent release train. The
 * keychain (PHNX-3989) and computer (PHNX-4075) helpers left with their standalone CLIs; a floor
 * for a helper this CLI never downloads would be a lying table. */
export const HELPER_RELEASES: Readonly<Record<HelperName, HelperRelease>> = {
  menubar: { tagPrefix: 'menubar', floor: '1.7.0' },
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
