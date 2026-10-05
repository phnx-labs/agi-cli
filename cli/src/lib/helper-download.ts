
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getCacheDir } from './state.js';
import { parseSha256Asset, sha256File } from './sha256-asset.js';
import { helperTag, type HelperName } from './helper-versions.js';

export const HELPER_RELEASE_REPO = 'phnx-labs/agi-cli';
export const EXPECTED_TEAM_ID = '2HTP252L87';

export interface HelperSpec {
  helper: HelperName;
  assetName: string;
  appName: string;
  cacheSubdir: string[];
  expectedTeamId: string;
  expectedBundleId?: string;
  localBuildHint: string;
}

export function helperCacheDir(spec: HelperSpec, version: string): string {
  return path.join(getCacheDir(), ...spec.cacheSubdir, `v${version}`);
}

// Helpers ship independently on their own tag; never derive assets from the CLI release tag.
export function helperAssetUrls(spec: HelperSpec, version: string): { zip: string; sha256: string } {
  const base = `https://github.com/${HELPER_RELEASE_REPO}/releases/download/${helperTag(spec.helper, version)}`;
  if (spec.assetName.includes(' ')) {
    throw new Error(
      `helper asset name ${JSON.stringify(spec.assetName)} contains a space; GitHub rewrites it to a dot on `
      + 'upload, so this URL would always 404. Use an underscore instead.',
    );
  }
  return { zip: `${base}/${spec.assetName}`, sha256: `${base}/${spec.assetName}.sha256` };
}

export function parseTeamId(codesignInfo: string): string | null {
  return codesignInfo.match(/TeamIdentifier=([A-Z0-9]+)/)?.[1] ?? null;
}

// The requirement, not merely a valid signature, preserves the Accessibility identity grant.
function readDesignatedRequirement(appPath: string): string {
  const r = spawnSync('/usr/bin/codesign', ['-d', '--requirements', '-', appPath], { encoding: 'utf8' });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

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

function verifyDesignatedRequirement(appPath: string, bundleId: string, teamId: string): void {
  const err = checkDesignatedRequirement(readDesignatedRequirement(appPath), bundleId, teamId);
  if (err) throw new Error(err);
}

// Verification is signature, Developer Team, designated requirement, then Gatekeeper.
export function verifyHelperApp(appPath: string, spec: HelperSpec): void {
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' });
  } catch (e) {
    throw new Error(`code signature invalid for ${appPath}: ${(e as Error).message}`);
  }

  const dv = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', appPath], { encoding: 'utf8' });
  const info = `${dv.stdout ?? ''}${dv.stderr ?? ''}`;
  const team = parseTeamId(info);
  if (team !== spec.expectedTeamId) {
    throw new Error(
      `helper signed by unexpected Team (${team ?? 'none'}), expected ${spec.expectedTeamId}. Refusing to install.`,
    );
  }

  if (spec.expectedBundleId) {
    verifyDesignatedRequirement(appPath, spec.expectedBundleId, spec.expectedTeamId);
  }

  try {
    execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose', appPath], { stdio: 'pipe' });
  } catch (e) {
    throw new Error(
      `helper is not notarized / rejected by Gatekeeper: ${(e as Error).message}. Refusing to install.`,
    );
  }
}

export async function downloadHelperApp(spec: HelperSpec, version: string): Promise<string> {
  const dir = helperCacheDir(spec, version);
  const cachedApp = path.join(dir, spec.appName);
  if (fs.existsSync(cachedApp)) {
    // Re-verify cached bundles on every use; cache presence is not an integrity signal.
    verifyHelperApp(cachedApp, spec);
    return cachedApp;
  }

  const tag = helperTag(spec.helper, version);
  const { zip: zipUrl, sha256: shaUrl } = helperAssetUrls(spec, version);
  const missing = (status: number, url: string) =>
    new Error(
      `no ${spec.assetName} release asset for tag ${tag} (HTTP ${status} on ${url}). ` +
        `The macOS helper ships as a GitHub release asset on its own helper tag; ` +
        `from a repo checkout you can stage it locally instead: ${spec.localBuildHint}`,
    );

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
