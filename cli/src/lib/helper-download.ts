/** Shared on-demand download and verification for the macOS helper `.app` bundles shipped as
 * signed, notarized release assets on each helper's own tag (see `helper-versions.ts`). Each zip
 * is checked against its `.sha256` and code signature (Team ID, notarization) before install. */

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getCacheDir } from './state.js';
import { parseSha256Asset, sha256File } from './sha256-asset.js';
import { helperTag, type HelperName } from './helper-versions.js';

/** GitHub repo whose `<helper>/v<version>` releases carry the helper assets. This is the slug,
 * not the npm package name; the repo was renamed to `agi-cli`, so do not rely on GitHub's rename
 * redirect. The sha256 and codesign checks are what actually protect the download. */
export const HELPER_RELEASE_REPO = 'phnx-labs/agi-cli';
/** Apple Developer ID Team every helper must be signed by ("Developer ID
 *  Application: Muqit Nawaz"). Defense in depth on top of `spctl` notarization. */
export const EXPECTED_TEAM_ID = '2HTP252L87';

/** One helper's identity + verification policy — everything that differs between
 *  the computer helper and the menu-bar helper. */
export interface HelperSpec {
  /** Which helper this is: the key into the independent release train (`helper-versions.ts`),
   * making the URL a function of the helper's version, not the CLI's. */
  helper: HelperName;
  /** The zipped `.app` release asset name, e.g. `ComputerHelper.app.zip`. */
  assetName: string;
  /** The bundle directory name once extracted, e.g. `ComputerHelper.app`. */
  appName: string;
  /** Cache dir components under `getCacheDir()`, e.g. `['computer', 'mac-helper']`. */
  cacheSubdir: string[];
  /** Developer ID Team the bundle must be signed by. */
  expectedTeamId: string;
  /** When set, the designated requirement must pin this CFBundleIdentifier as well as
   * `expectedTeamId`. */
  expectedBundleId?: string;
  /** Local-build command named in the "asset missing" error, for a repo checkout. */
  localBuildHint: string;
}

/** Cache dir for a downloaded helper, one subdir per release tag. */
export function helperCacheDir(spec: HelperSpec, version: string): string {
  return path.join(getCacheDir(), ...spec.cacheSubdir, `v${version}`);
}

/** Release-asset URLs for one helper build at that helper's own tag `<helper>/v<version>` (e.g.
 * `menubar/v1.0.0`), never the CLI's `v<cliVersion>`; */
export function helperAssetUrls(spec: HelperSpec, version: string): { zip: string; sha256: string } {
  const base = `https://github.com/${HELPER_RELEASE_REPO}/releases/download/${helperTag(spec.helper, version)}`;
  // Asset names must not contain spaces: GitHub rewrites a space to a dot on upload, so a spaced
  // name 404s forever (`Agents CLI.app.zip` was served as `Agents.CLI.app.zip`). Use an underscore,
  // which GitHub preserves.
  if (spec.assetName.includes(' ')) {
    throw new Error(
      `helper asset name ${JSON.stringify(spec.assetName)} contains a space; GitHub rewrites it to a dot on `
      + 'upload, so this URL would always 404. Use an underscore instead.',
    );
  }
  return { zip: `${base}/${spec.assetName}`, sha256: `${base}/${spec.assetName}.sha256` };
}

/** Extract `TeamIdentifier=XXXX` from `codesign -dv --verbose=4` output (which is
 *  emitted on stderr). Returns null when absent (ad-hoc / unsigned). */
export function parseTeamId(codesignInfo: string): string | null {
  return codesignInfo.match(/TeamIdentifier=([A-Z0-9]+)/)?.[1] ?? null;
}

/** Read the bundle's designated requirement string (`codesign -d --requirements -`).
 *  codesign writes it to stdout, but capture both streams so a diagnostic on
 *  stderr can never make the pin-check read empty and falsely pass. */
function readDesignatedRequirement(appPath: string): string {
  const r = spawnSync('/usr/bin/codesign', ['-d', '--requirements', '-', appPath], { encoding: 'utf8' });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

/** Pure predicate behind the DR pin: does the requirement string pin both the expected
 * CFBundleIdentifier and the Developer ID Team? Null when it does, else an actionable message. */
export function checkDesignatedRequirement(req: string, bundleId: string, teamId: string): string | null {
  const trimmed = req.trim();
  const shown = trimmed ? JSON.stringify(trimmed.slice(0, 200)) : '<none>';
  if (!trimmed.includes(`identifier "${bundleId}"`)) {
    return (
      `helper designated requirement does not pin bundle id "${bundleId}" (read: ${shown}). ` +
      `Installing it would revoke the Accessibility grant. Refusing to install.`
    );
  }
  if (!trimmed.includes(teamId)) {
    return (
      `helper designated requirement does not pin Developer ID Team ${teamId} (read: ${shown}). ` +
      `Installing it would revoke the Accessibility grant. Refusing to install.`
    );
  }
  return null;
}

/** Verifies the bundle's designated requirement pins the expected CFBundleIdentifier and
 * Developer ID Team. macOS re-validates each new version against it to keep an Accessibility
 * grant alive across upgrades, so a bundle dropping either pin would silently revoke the grant. */
function verifyDesignatedRequirement(appPath: string, bundleId: string, teamId: string): void {
  const err = checkDesignatedRequirement(readDesignatedRequirement(appPath), bundleId, teamId);
  if (err) throw new Error(err);
}

/** Verifies a helper `.app` is intact, signed by the expected Developer ID Team, pinned by its
 * DR (menu-bar helper), and notarized. Throws with an actionable message on any failure; a
 * downloaded bundle is never trusted without this. */
export function verifyHelperApp(appPath: string, spec: HelperSpec): void {
  // 1. Structural + signature integrity.
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' });
  } catch (e) {
    throw new Error(`code signature invalid for ${appPath}: ${(e as Error).message}`);
  }

  // Team identity must be our Developer ID. `codesign -dv` writes details to STDERR even on
  // success, so read stderr; spawnSync captures both streams, whereas execFileSync returns only the
  // empty stdout and would falsely reject every validly signed helper.
  const dv = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', appPath], { encoding: 'utf8' });
  const info = `${dv.stdout ?? ''}${dv.stderr ?? ''}`;
  const team = parseTeamId(info);
  if (team !== spec.expectedTeamId) {
    throw new Error(
      `helper signed by unexpected Team (${team ?? 'none'}), expected ${spec.expectedTeamId}. Refusing to install.`,
    );
  }

  // 3. Designated-requirement pin (menu-bar helper only) — before the Gatekeeper
  //    assessment so a DR mismatch fails with its specific, actionable message
  //    rather than a generic Gatekeeper rejection.
  if (spec.expectedBundleId) {
    verifyDesignatedRequirement(appPath, spec.expectedBundleId, spec.expectedTeamId);
  }

  // 4. Notarization / Gatekeeper — confirms Apple stapled a notarization ticket.
  try {
    execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose', appPath], { stdio: 'pipe' });
  } catch (e) {
    throw new Error(
      `helper is not notarized / rejected by Gatekeeper: ${(e as Error).message}. Refusing to install.`,
    );
  }
}

/** Downloads a helper release asset for `version`, verifies sha256, extracts the `.app`, and
 * verifies its signature (plus DR pin if required). Returns the extracted bundle path. A
 * missing asset is a hard error naming the exact tag, never a fallback to another release. */
export async function downloadHelperApp(spec: HelperSpec, version: string): Promise<string> {
  const dir = helperCacheDir(spec, version);
  const cachedApp = path.join(dir, spec.appName);
  if (fs.existsSync(cachedApp)) {
    // Re-verify a cached bundle cheaply; a tampered cache must not be trusted.
    verifyHelperApp(cachedApp, spec);
    return cachedApp;
  }

  // Name the HELPER's tag, not `v${version}`: after the per-helper split that
  // string was a tag that does not exist, so a 404 pointed the reader at the
  // wrong place to look.
  const tag = helperTag(spec.helper, version);
  const { zip: zipUrl, sha256: shaUrl } = helperAssetUrls(spec, version);
  const missing = (status: number, url: string) =>
    new Error(
      `no ${spec.assetName} release asset for tag ${tag} (HTTP ${status} on ${url}). ` +
        `The macOS helper ships as a GitHub release asset on its own helper tag; ` +
        `from a repo checkout you can stage it locally instead: ${spec.localBuildHint}`,
    );

  // Checksum first: it is tiny and 404s fast when the tag has no assets.
  const shaRes = await fetch(shaUrl, { signal: AbortSignal.timeout(30_000) });
  if (!shaRes.ok) throw missing(shaRes.status, shaUrl);
  const expected = parseSha256Asset(await shaRes.text());

  console.error(`Downloading ${spec.assetName} ${tag} from GitHub releases...`);
  const zipRes = await fetch(zipUrl, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!zipRes.ok || !zipRes.body) throw missing(zipRes.status, zipUrl);

  fs.mkdirSync(dir, { recursive: true });
  const partial = path.join(dir, `${spec.assetName}.download`);
  try {
    await pipeline(
      Readable.fromWeb(zipRes.body as unknown as import('stream/web').ReadableStream),
      fs.createWriteStream(partial),
    );
    const actual = await sha256File(partial);
    if (actual !== expected) {
      throw new Error(`sha256 mismatch for ${zipUrl}: expected ${expected}, got ${actual}`);
    }
    // Extract the zip (created with `ditto -c -k --keepParent`, so it contains
    // <appName>/ at top level) into the version cache dir.
    fs.rmSync(cachedApp, { recursive: true, force: true });
    execFileSync('/usr/bin/ditto', ['-x', '-k', partial, dir], { stdio: 'pipe' });
    if (!fs.existsSync(cachedApp)) {
      throw new Error(`extracted asset did not contain ${spec.appName}`);
    }
    verifyHelperApp(cachedApp, spec);
  } finally {
    fs.rmSync(partial, { force: true });
  }
  return cachedApp;
}
