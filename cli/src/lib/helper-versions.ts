
export type HelperName = 'menubar';

interface HelperRelease {
  tagPrefix: string;
  floor: string;
}

export const HELPER_RELEASES: Readonly<Record<HelperName, HelperRelease>> = {
  menubar: { tagPrefix: 'menubar', floor: '1.14.6' },
};

export function helperTag(helper: HelperName, version: string): string {
  const release = HELPER_RELEASES[helper];
  if (!release) throw new Error(`unknown helper '${helper}' (want: ${Object.keys(HELPER_RELEASES).join(', ')})`);
  return `${release.tagPrefix}/v${version}`;
}

export function helperFloor(helper: HelperName): string {
  const release = HELPER_RELEASES[helper];
  if (!release) throw new Error(`unknown helper '${helper}' (want: ${Object.keys(HELPER_RELEASES).join(', ')})`);
  return release.floor;
}
