
type PlacementKind = 'local' | 'device' | 'fleet' | 'cloud' | 'lease';

export interface Placement {
  kind: PlacementKind;
  target?: string;
  source: string;
}

interface RunPlacementFlags {
  where?: string;
  host?: string;
  device?: string;
  on?: string;
  computer?: string;
  lease?: string | boolean;
  box?: string;
  cloud?: boolean;
  provider?: string;
  local?: boolean;
}

export class PlacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlacementError';
  }
}

const KINDS: ReadonlySet<string> = new Set(['local', 'device', 'fleet', 'cloud', 'lease', 'host']);

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
    if (KINDS.has(lower)) {
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

export function hostFamilyTarget(flags: RunPlacementFlags): string | undefined {
  for (const v of [flags.host, flags.device, flags.on, flags.computer]) {
    if (v) return v;
  }
  return undefined;
}

export function placementFromRunFlags(flags: RunPlacementFlags): Placement {
  const where = flags.where?.trim();
  const hostT = hostFamilyTarget(flags);
  const hasLease = flags.lease !== undefined && flags.lease !== false;
  const hasBox = !!flags.box;
  const hasCloud = flags.cloud === true;
  const hasLocal = flags.local === true;

  const placementFlags: string[] = [];
  if (where) placementFlags.push('--where');
  if (hasLocal) placementFlags.push('--local');
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
  if (hasLocal) return { kind: 'local', source: '--local' };
  if (hasCloud) return { kind: 'cloud', target: flags.provider, source: '--cloud' };
  if (hasBox) return { kind: 'lease', target: flags.box, source: '--box' };
  if (hasLease) {
    const backend = typeof flags.lease === 'string' ? flags.lease : undefined;
    return { kind: 'lease', target: backend, source: '--lease' };
  }
  if (hostT) return { kind: 'device', target: hostT, source: '--device' };
  return { kind: 'local', source: 'default' };
}

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
      return { host: placement.target };
    case 'lease':
      if (placement.source === '--box') return { box: placement.target };
      return placement.target ? { lease: placement.target } : { lease: true };
    case 'cloud':
      return placement.target ? { cloud: true, provider: placement.target } : { cloud: true };
    case 'fleet':
      throw new PlacementError(
        `fleet placement is for routines (agents routines add … --placement fleet), not agents run. ` +
          `Use --where device:auto for an affinity pick, or --where device:<name>.`,
      );
  }
}

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

export function formatPlacement(p: Placement): string {
  if (p.kind === 'local') return 'local';
  if (p.target) return `${p.kind}:${p.target}`;
  return p.kind;
}
