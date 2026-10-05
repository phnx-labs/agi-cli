/** Front-door safety guard for `agents packages materialize` (PHNX-3838). The materializer is
 * destination-agnostic, so this refuses dangerous destinations: `..`, a dangling protected live
 * home, the live home ROOT or inside `~/.claude`/`.codex`/`.opencode`, `@latest`. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertWithin, realpathExistingPrefix } from '../paths.js';
import { VERSION_RE } from '../agent-spec/primitives.js';

/** The three harness homes a portable schema-v3 package can be materialized into. */
export const PORTABLE_HARNESSES = ['claude', 'codex', 'opencode'] as const;
type PortableHarness = (typeof PORTABLE_HARNESSES)[number];

function isPortableHarness(value: string): value is PortableHarness {
  return (PORTABLE_HARNESSES as readonly string[]).includes(value);
}

/** Thrown for a bad front-door argument (harness / version / output home). Never `process.exit`. */
export class MaterializeGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaterializeGuardError';
  }
}

/** Reject a harness that is not one of the three portable homes, with a message naming it. */
export function assertPortableHarness(harness: string): PortableHarness {
  if (!isPortableHarness(harness)) {
    throw new MaterializeGuardError(
      `Unsupported capability: '${harness}' is not a portable-agent harness (${PORTABLE_HARNESSES.join(', ')}).`,
    );
  }
  return harness;
}

/** Reject a non-exact harness version (empty, malformed, or `@latest`). */
export function assertExactHarnessVersion(version: string): string {
  if (!version || version === 'latest' || !VERSION_RE.test(version)) {
    throw new MaterializeGuardError(
      `Invalid harness version '${version}'. Pass an exact harness version (not @latest).`,
    );
  }
  return version;
}

/** True when `raw` still contains a `..` segment after splitting on both separators. */
function outputHomeHasDotDot(raw: string): boolean {
  return raw.split(/[\\/]/).includes('..');
}

/** The absolute path a DANGLING symlink chain points at, else null. `realpathExistingPrefix`
 * doesn't follow a dangling leaf link, so `~/.claude` to an absent target passes containment, yet
 * `mkdirSync(recursive)` follows it and re-points the live home. Bounded hops defuse cycles. */
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

/** Fails CLOSED when a protected live harness home is a DANGLING symlink, refusing EVERY output
 * home: `mkdirSync(recursive)` would follow it, and an absent target can't be `realpath`'d, so
 * comparing names needs per-volume case/Unicode collation (APFS folds U+017F as `s`). */
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

/** The canonical EXISTING live harness home to forbid, per harness: `realpathExistingPrefix` of
 * each `~/.<harness>`. Both sides are `realpath`-canonical, so a byte-exact compare is exact
 * identity. A DANGLING home never reaches here (assertNoDanglingLiveHome fails first). */
function liveHarnessHomes(realHome: string): { harness: PortableHarness; live: string }[] {
  return PORTABLE_HARNESSES.map((name) => ({
    harness: name,
    live: realpathExistingPrefix(path.join(realHome, `.${name}`)),
  }));
}

/** Resolves `--output-home` to an absolute path, refusing a target that climbs out of cwd, uses
 * `..`, is the live home root, or is inside a live harness home; a dangling protected home refuses
 * EVERY output home. Convenience only: the real invariant is in `materializeAgentPackage`. */
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
  // Fail closed first: a dangling protected home makes EVERY output home unsafe,
  // and its absent target has no realpath-canonical spelling to compare against.
  assertNoDanglingLiveHome(realHome);
  // The materializer appends the harness config dir to outputHome, so the live
  // home ROOT would write straight into ~/.claude etc.
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
