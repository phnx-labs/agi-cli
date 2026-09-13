/**
 * Front-door safety guard for `agents packages materialize` (PHNX-3838).
 *
 * The canonical materializer ({@link materializeAgentPackage} in
 * `agent-spec/materialize.ts`) writes into whatever `outputHome` it is handed —
 * that is its job, and it must stay destination-agnostic so Factory / Prix Cloud
 * can point it at any ephemeral home. Refusing a *dangerous* destination is a
 * CLI-front-door concern, not a materializer concern, so it lives here:
 *
 *   - the target may not climb out of cwd (relative) or carry a `..` segment;
 *   - if any protected live harness home (`~/.claude`, `~/.codex`, `~/.opencode`)
 *     is a DANGLING symlink or dangling chain, EVERY output home is refused —
 *     fail closed (see {@link assertNoDanglingLiveHome});
 *   - the target may not be the operator's live home ROOT, nor — or sit inside —
 *     an EXISTING live `~/.claude`, `~/.codex`, or `~/.opencode` home;
 *   - the harness must be one of the three portable homes;
 *   - the harness version must be an exact version, never `@latest`.
 *
 * The live-home ROOT refusal is load-bearing: the materializer appends the
 * harness config dir (`.claude`/`.codex`/`.opencode`) to `outputHome`, so an
 * `outputHome` of `$HOME` itself would land straight in the operator's live
 * `~/.claude`. And because a symlink (`outputHome` itself, or any ancestor)
 * pointing at `$HOME` re-opens the same hole — `path.resolve` normalizes `..`
 * but never follows links — the check canonicalizes the existing ancestors with
 * `realpath` before comparing.
 *
 * Kept beside the command (not inside it) so the live-home refusal is
 * unit-testable without spawning the whole CLI.
 */
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

/**
 * The absolute path a DANGLING symlink chain ultimately points at, or `null`
 * when `p` is not a symlink or its chain resolves to an existing file.
 *
 * `realpathExistingPrefix` deliberately does NOT follow a dangling LEAF link — it
 * resolves the link's parent and re-appends the basename — so `~/.claude` → an
 * absent target canonicalizes to the literal `~/.claude`, and the target itself
 * sails past every containment compare. Yet the materializer's very first act is
 * `fs.mkdirSync(outputHome, { recursive: true })`, which FOLLOWS that link and
 * creates the target, re-pointing the operator's live `~/.claude` at the
 * materialized tree. So the guard treats a dangling protected home as a fail-
 * closed condition (see {@link assertNoDanglingLiveHome}). A live symlink (its
 * target exists) resolves cleanly through `realpathExistingPrefix`, hence the
 * `!fs.existsSync` gate returns `null` for it. Relative links resolve against
 * each hop's own directory; a bounded hop budget defuses a symlink cycle
 * (returning the best-effort endpoint, which still reads as dangling → refused).
 */
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

/**
 * Fail CLOSED when any protected live harness home (`~/.claude`, `~/.codex`,
 * `~/.opencode`) is a DANGLING symlink or dangling symlink chain — refusing
 * EVERY output home, not merely one that aliases the dangling target.
 *
 * Why refuse the whole operation instead of the aliasing path alone: the
 * materializer's first act is `fs.mkdirSync(outputHome, { recursive: true })`,
 * which FOLLOWS the link and creates its absent target, re-pointing the
 * operator's live `~/.<harness>` at the materialized tree. To refuse only the
 * aliasing output home we would have to decide whether the requested path and
 * the dangling target name the SAME file — but the target does not exist, so it
 * cannot be `realpath`'d, and its identity then depends on the destination
 * volume's own case/Unicode collation, which is per-volume and NOT knowable from
 * the path text. An independent macOS review confirmed this directly: NFC +
 * `toLowerCase` is not APFS case folding (APFS treats e.g. U+017F ſ and ASCII `s`
 * as identical, which `toLowerCase` does not), and an OS-derived case-sensitivity
 * flag is wrong for per-volume semantics. Rather than approximate an unknowable
 * collation, the guard refuses outright until the operator repairs the dangling
 * home. A dangling protected home is an abnormal state, so this over-rejects
 * nothing a healthy environment relies on; the EXISTING-home comparison stays
 * exact because `realpath` gives it a trustworthy canonical spelling.
 */
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

/**
 * The canonical EXISTING live harness home to forbid, per harness: the
 * `realpathExistingPrefix` of each `~/.<harness>`. For a live symlink this is the
 * real on-disk target (so `--output-home ~/.claude` and its resolved dir both
 * match); for a plain dir, or a home that does not exist at all, it is the
 * literal `~/.<harness>` path. Because both this and the candidate output home
 * are canonicalized with `realpath`, a byte-exact compare is exact filesystem
 * identity — `realpath` returns the volume's own on-disk spelling, so two paths
 * naming the same file collapse to the same string with no need to approximate
 * the volume's case/Unicode collation. A DANGLING `~/.<harness>` never reaches
 * here: {@link assertNoDanglingLiveHome} fails closed first, precisely because
 * its absent target has no realpath-canonical spelling to compare against.
 */
function liveHarnessHomes(realHome: string): { harness: PortableHarness; live: string }[] {
  return PORTABLE_HARNESSES.map((name) => ({
    harness: name,
    live: realpathExistingPrefix(path.join(realHome, `.${name}`)),
  }));
}

/**
 * Resolve `--output-home` to an absolute path, refusing a target that climbs out
 * of cwd (relative), uses a `..` segment, IS the live home root, or targets (or
 * sits inside) an existing live Claude/Codex/OpenCode home — after canonicalizing
 * symlinks in the existing ancestors so a symlinked target/ancestor can't alias
 * `$HOME`. Every rejection carries a `Path escape:` prefix so callers surface one
 * consistent reason.
 *
 * If any protected home is instead a DANGLING symlink or chain, the function
 * fails closed and refuses EVERY output home (via {@link assertNoDanglingLiveHome}),
 * because the absent target it points at has no canonical spelling to compare a
 * candidate against and the materializer's first `mkdir -p` would follow the link
 * and re-create the operator's live home there (PHNX-3838). The existing-home
 * comparison uses a byte-exact `===` / `startsWith` on two `realpath`-canonical
 * paths, which is exact filesystem identity — no approximation of the volume's
 * case/Unicode collation, which an independent macOS review showed cannot be
 * reproduced in JS from the path text.
 *
 * This is a front-door convenience guard. The load-bearing containment invariant
 * (that no per-resource write/delete escapes the output home — including through
 * a symlink planted at the harness-config-dir join point, which this function
 * cannot see because the materializer forms that child itself) is enforced in
 * `materializeAgentPackage`, so a direct (non-CLI) caller is protected too.
 */
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
