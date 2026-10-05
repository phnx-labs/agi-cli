import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertWithin, realpathExistingPrefix } from '../paths.js';
import { VERSION_RE } from '../agent-spec/primitives.js';

export const PORTABLE_HARNESSES = ['claude', 'codex', 'opencode'] as const;
type PortableHarness = (typeof PORTABLE_HARNESSES)[number];

function isPortableHarness(value: string): value is PortableHarness {
  return (PORTABLE_HARNESSES as readonly string[]).includes(value);
}

export class MaterializeGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaterializeGuardError';
  }
}

export function assertPortableHarness(harness: string): PortableHarness {
  if (!isPortableHarness(harness)) {
    throw new MaterializeGuardError(
      `Unsupported capability: '${harness}' is not a portable-agent harness (${PORTABLE_HARNESSES.join(', ')}).`,
    );
  }
  return harness;
}

export function assertExactHarnessVersion(version: string): string {
  if (!version || version === 'latest' || !VERSION_RE.test(version)) {
    throw new MaterializeGuardError(
      `Invalid harness version '${version}'. Pass an exact harness version (not @latest).`,
    );
  }
  return version;
}

function outputHomeHasDotDot(raw: string): boolean {
  return raw.split(/[\\/]/).includes('..');
}

function danglingLinkChainTarget(p: string): string | null {
  let current = path.resolve(p);
  let followed = false;
  for (let hops = 0; hops < 40; hops++) {
    let dest: string;
    try {
      dest = fs.readlinkSync(current);
    } catch {
      return followed && !fs.existsSync(current) ? current : null;
    }
    followed = true;
    current = path.resolve(path.dirname(current), dest);
  }
  return current;
}

function assertNoDanglingLiveHome(realHome: string): void {
  for (const name of PORTABLE_HARNESSES) {
    if (danglingLinkChainTarget(path.join(realHome, `.${name}`)) !== null) {
      throw new MaterializeGuardError(
        `Path escape: the live .${name} home is a dangling symlink; refusing every output home until it is repaired ` +
          `(the materializer's mkdir -p would follow the link and re-create your live .${name} at its absent target)`,
      );
    }
  }
}

function liveHarnessHomes(realHome: string): { harness: PortableHarness; live: string }[] {
  return PORTABLE_HARNESSES.map((name) => ({
    harness: name,
    live: realpathExistingPrefix(path.join(realHome, `.${name}`)),
  }));
}

export function resolveOutputHome(raw: string, cwd = process.cwd(), home = os.homedir()): string {
  if (!raw || raw.includes('\0')) {
    throw new MaterializeGuardError('Path escape: output home is empty or contains a null byte');
  }
  if (outputHomeHasDotDot(raw)) {
    throw new MaterializeGuardError(`Path escape: ${raw}`);
  }
  const resolved = path.resolve(cwd, raw);
  if (!path.isAbsolute(raw)) {
    try {
      assertWithin(cwd, resolved);
    } catch {
      throw new MaterializeGuardError(`Path escape: ${raw}`);
    }
  }

  const canonical = realpathExistingPrefix(resolved);
  const realHome = realpathExistingPrefix(home);
  assertNoDanglingLiveHome(realHome);
  if (canonical === realHome) {
    throw new MaterializeGuardError('Path escape: output home must not be the live home directory');
  }
  for (const { harness, live } of liveHarnessHomes(realHome)) {
    if (canonical === live || canonical.startsWith(live + path.sep)) {
      throw new MaterializeGuardError(
        `Path escape: output home must not target the live .${harness} directory`,
      );
    }
  }
  return resolved;
}
