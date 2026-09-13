/**
 * Placement — one model for "where does the body run?"
 *
 * The CLI grew several doors that all mean execution target:
 *   run --device / --lease / --box / --cloud
 *   routines --placement / --run-on / hostStrategy
 *   monitors --run-on (body) vs --device (owner — NOT placement)
 *   teams --device (teammate pin)
 *   cloud run --provider host
 *
 * This module is the shared vocabulary. Old flags remain; --where is a
 * thin alias on `agents run` that expands into them. Docs and help teach
 * the matrix; stores stay separate (device registry, lease boxes, cloud).
 *
 * Owner (who may fire / evaluate) is NOT placement — see monitors.
 */

/** Where a job body executes. */
type PlacementKind = 'local' | 'device' | 'fleet' | 'cloud' | 'lease';

/**
 * Canonical placement object.
 *
 *   kind: local  — this machine
 *   kind: device — named box or affinity pick (target: name | "auto")
 *   kind: fleet  — pick one online device at fire time (routines)
 *   kind: cloud  — vendor cloud dispatch
 *   kind: lease  — disposable crabbox (target: optional backend)
 */
export interface Placement {
  kind: PlacementKind;
  /** Device/host name, "auto", lease backend, or undefined. */
  target?: string;
  /** Flag or path that produced this (errors / diagnostics). */
  source: string;
}

/** Run-flag bag the placement parser understands. */
interface RunPlacementFlags {
  where?: string;
  host?: string;
  device?: string;
  on?: string;
  computer?: string;
  lease?: string | boolean;
  box?: string;
  /** --cloud: vendor cloud placement (the agent's native cloud provider). */
  cloud?: boolean;
  /** --provider: refines the cloud placement; not a placement on its own. */
  provider?: string;
}

export class PlacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlacementError';
  }
}

const KINDS: ReadonlySet<string> = new Set(['local', 'device', 'fleet', 'cloud', 'lease', 'host']);

/**
 * Parse a `--where` / placement spec string.
 *
 * Accepted forms:
 *   local
 *   device[:name] | host[:name]   (bare name → device:<name>)
 *   device:auto | auto | host:auto
 *   fleet
 *   cloud
 *   lease[:backend]
 */
export function parseWhereSpec(raw: string, source = '--where'): Placement {
  const spec = raw.trim();
  if (!spec) {
    throw new PlacementError(`${source} requires a value (local | device:<name> | auto | lease | cloud | fleet)`);
  }

  const lower = spec.toLowerCase();
  if (lower === 'local') return { kind: 'local', source };
  if (lower === 'auto') return { kind: 'device', target: 'auto', source };
  if (lower === 'fleet') return { kind: 'fleet', source };
  if (lower === 'cloud') return { kind: 'cloud', source };
  if (lower === 'lease') return { kind: 'lease', source };

  const colon = spec.indexOf(':');
  if (colon === -1) {
    // Bare token that is not a reserved kind → device target.
    if (KINDS.has(lower)) {
      // "device" / "host" alone means device with no pin (invalid for run).
      throw new PlacementError(
        `${source} ${spec}: name a target (device:<name>, device:auto) or use local|lease|cloud|fleet`,
      );
    }
    return { kind: 'device', target: spec, source };
  }

  const head = spec.slice(0, colon).toLowerCase();
  const tail = spec.slice(colon + 1).trim();
  if (!tail) {
    throw new PlacementError(`${source} ${spec}: missing target after ':'`);
  }

  if (head === 'device' || head === 'host') {
    return { kind: 'device', target: tail, source };
  }
  if (head === 'lease') {
    return { kind: 'lease', target: tail, source };
  }
  if (head === 'cloud') {
    return { kind: 'cloud', target: tail, source };
  }
  if (head === 'fleet') {
    return { kind: 'fleet', target: tail, source };
  }

  throw new PlacementError(
    `${source} ${spec}: unknown kind '${head}' (use local | device:<name> | auto | lease[:backend] | cloud | fleet)`,
  );
}

/** First non-empty host-family flag value (host / device / on / computer). */
export function hostFamilyTarget(flags: RunPlacementFlags): string | undefined {
  for (const v of [flags.host, flags.device, flags.on, flags.computer]) {
    if (v) return v;
  }
  return undefined;
}

/**
 * Resolve placement from run flags. `--where` wins only when no other
 * placement flag is set; mixing is a PlacementError.
 */
export function placementFromRunFlags(flags: RunPlacementFlags): Placement {
  const where = flags.where?.trim();
  const hostT = hostFamilyTarget(flags);
  const hasLease = flags.lease !== undefined && flags.lease !== false;
  const hasBox = !!flags.box;
  const hasCloud = flags.cloud === true;

  const placementFlags: string[] = [];
  if (where) placementFlags.push('--where');
  if (hostT) placementFlags.push('--device');
  if (hasLease) placementFlags.push('--lease');
  if (hasBox) placementFlags.push('--box');
  if (hasCloud) placementFlags.push('--cloud');

  if (placementFlags.length > 1) {
    throw new PlacementError(
      `Conflicting placement flags: ${placementFlags.join(' + ')}. ` +
        `Use one door — prefer --where (device:<name> | auto | lease | cloud | local).`,
    );
  }

  if (where) return parseWhereSpec(where, '--where');
  if (hasCloud) return { kind: 'cloud', target: flags.provider, source: '--cloud' };
  if (hasBox) return { kind: 'lease', target: flags.box, source: '--box' };
  if (hasLease) {
    const backend = typeof flags.lease === 'string' ? flags.lease : undefined;
    return { kind: 'lease', target: backend, source: '--lease' };
  }
  if (hostT) return { kind: 'device', target: hostT, source: '--device' };
  return { kind: 'local', source: 'default' };
}

/**
 * Expand a resolved placement into the concrete run option fields the
 * existing dispatch paths already understand. Pure — does not mutate input.
 *
 * `fleet` is not valid for a bare `agents run` (it is a routines placement);
 * it throws so callers fail loud.
 */
export function expandPlacementToRunFlags(
  placement: Placement,
): Pick<RunPlacementFlags, 'host' | 'device' | 'lease' | 'box' | 'cloud' | 'provider'> {
  switch (placement.kind) {
    case 'local':
      return {};
    case 'device':
      if (!placement.target) {
        throw new PlacementError(`${placement.source}: device placement needs a target (name or auto)`);
      }
      // Canonical host flag; --device is an alias of the same path.
      return { host: placement.target };
    case 'lease':
      // --box reuses a warm slug; --where lease[:backend] / --lease provisions.
      if (placement.source === '--box') return { box: placement.target };
      return placement.target ? { lease: placement.target } : { lease: true };
    case 'cloud':
      // Vendor cloud placement — `--where cloud[:provider]` expands to the
      // --cloud flag (+ --provider refinement) the run action dispatches on.
      return placement.target ? { cloud: true, provider: placement.target } : { cloud: true };
    case 'fleet':
      throw new PlacementError(
        `fleet placement is for routines (agents routines add … --placement fleet), not agents run. ` +
          `Use --where device:auto for an affinity pick, or --where device:<name>.`,
      );
  }
}

/** Map routines hostStrategy (+ optional host) onto the shared Placement. */
export function placementFromHostStrategy(
  strategy: 'local' | 'host' | 'fleet' | 'cloud',
  host?: string,
): Placement {
  switch (strategy) {
    case 'local':
      return { kind: 'local', source: 'hostStrategy:local' };
    case 'host':
      return { kind: 'device', target: host, source: 'hostStrategy:host' };
    case 'fleet':
      return { kind: 'fleet', source: 'hostStrategy:fleet' };
    case 'cloud':
      return { kind: 'cloud', source: 'hostStrategy:cloud' };
  }
}

/** One-line human form for logs / help. */
export function formatPlacement(p: Placement): string {
  if (p.kind === 'local') return 'local';
  if (p.target) return `${p.kind}:${p.target}`;
  return p.kind;
}
