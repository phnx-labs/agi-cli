
import * as fs from 'fs';
import * as yaml from 'yaml';
import type {
  FleetManifest,
  FleetDefaults,
  FleetDeviceOverride,
  FleetLoginMode,
  DeviceDesired,
} from './types.js';

const LOGIN_MODES: readonly FleetLoginMode[] = ['sync', 'skip'];

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function validateLogin(v: unknown, where: string): FleetLoginMode | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !LOGIN_MODES.includes(v as FleetLoginMode)) {
    throw new Error(`fleet: ${where}.login must be one of ${LOGIN_MODES.join(' | ')} (got ${JSON.stringify(v)}).`);
  }
  return v as FleetLoginMode;
}

function validateDefaults(v: unknown, where: string): FleetDefaults {
  if (v === undefined) return {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`fleet: ${where} must be a mapping.`);
  }
  const o = v as Record<string, unknown>;
  if (o.agents !== undefined && !isStringArray(o.agents)) {
    throw new Error(`fleet: ${where}.agents must be a list of agent specs (e.g. [claude@latest]).`);
  }
  if (o.sync !== undefined && !isStringArray(o.sync)) {
    throw new Error(`fleet: ${where}.sync must be a list of scope names (e.g. [user]).`);
  }
  if (o.config !== undefined && (typeof o.config !== 'object' || o.config === null || Array.isArray(o.config))) {
    throw new Error(`fleet: ${where}.config must be a mapping of config keys to values.`);
  }
  return {
    agents: o.agents as string[] | undefined,
    sync: o.sync as string[] | undefined,
    login: validateLogin(o.login, where),
    config: o.config as Record<string, unknown> | undefined,
  };
}

export function parseFleetManifest(raw: unknown): FleetManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('fleet: block must be a mapping with a `devices:` key.');
  }
  const o = raw as Record<string, unknown>;
  const defaults = validateDefaults(o.defaults, 'defaults');

  if (o.devices === undefined) {
    throw new Error('fleet: a `devices:` key is required (use `devices: all` or an explicit map).');
  }
  let devices: FleetManifest['devices'];
  if (o.devices === 'all') {
    devices = 'all';
  } else if (typeof o.devices === 'object' && o.devices !== null && !Array.isArray(o.devices)) {
    const map: Record<string, FleetDeviceOverride> = {};
    for (const [name, ov] of Object.entries(o.devices as Record<string, unknown>)) {
      map[name] = ov == null ? {} : validateDefaults(ov, `devices.${name}`);
    }
    devices = map;
  } else {
    throw new Error(`fleet: devices must be the string 'all' or a mapping of device -> overrides (got ${JSON.stringify(o.devices)}).`);
  }

  const manifest: FleetManifest = { defaults, devices };

  if (o.discovery !== undefined) {
    if (typeof o.discovery !== 'object' || o.discovery === null || Array.isArray(o.discovery)) {
      throw new Error('fleet: discovery must be a mapping of device name to approved or ignored.');
    }
    const discovery: NonNullable<FleetManifest['discovery']> = {};
    for (const [name, status] of Object.entries(o.discovery as Record<string, unknown>)) {
      if (status !== 'approved' && status !== 'ignored') {
        throw new Error(`fleet: discovery.${name} must be approved or ignored.`);
      }
      discovery[name] = status;
    }
    manifest.discovery = discovery;
  }

  if (o.secrets !== undefined) {
    if (typeof o.secrets !== 'object' || o.secrets === null || Array.isArray(o.secrets)) {
      throw new Error('fleet: secrets must be a mapping with a `bundles:` list.');
    }
    const bundles = (o.secrets as Record<string, unknown>).bundles;
    if (bundles !== undefined && !isStringArray(bundles)) {
      throw new Error('fleet: secrets.bundles must be a list of bundle names (e.g. [attio]).');
    }
    manifest.secrets = { bundles: bundles as string[] | undefined };
  }
  if (o.routines !== undefined) {
    if (!isStringArray(o.routines)) {
      throw new Error('fleet: routines must be a list of routine names.');
    }
    manifest.routines = o.routines;
  }

  return manifest;
}

export function readFleetFile(filePath: string): FleetManifest {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Manifest not found: ${filePath}`);
  }
  let doc: unknown;
  try {
    doc = yaml.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    throw new Error(`Failed to parse YAML in ${filePath}: ${(e as Error).message}`);
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new Error(`${filePath} is not a mapping — no fleet: block to apply.`);
  }
  const fleet = (doc as Record<string, unknown>).fleet;
  if (fleet === undefined) {
    throw new Error(`${filePath} has no fleet: block. Add one to declare the profile (see \`agents fleet apply --help\`).`);
  }
  return parseFleetManifest(fleet);
}

function mergeDesired(device: string, defaults: FleetDefaults, override: FleetDeviceOverride): DeviceDesired {
  return {
    device,
    agents: override.agents ?? defaults.agents ?? [],
    sync: override.sync ?? defaults.sync ?? [],
    login: override.login ?? defaults.login ?? 'sync',
  };
}

interface ResolveContext {
  onlineDevices: string[];
  registeredDevices: string[];
  source: string;
  unresolved?: string[];
}

export function resolveDesired(manifest: FleetManifest, ctx: ResolveContext): DeviceDesired[] {
  const defaults = manifest.defaults ?? {};
  const out: DeviceDesired[] = [];

  if (manifest.devices === 'all') {
    for (const name of ctx.onlineDevices) {
      if (name === ctx.source) continue;
      out.push(mergeDesired(name, defaults, {}));
    }
    return out;
  }

  const unresolved = new Set(ctx.unresolved ?? []);
  for (const [name, override] of Object.entries(manifest.devices)) {
    if (name === ctx.source) continue;
    if (unresolved.has(name)) continue;
    if (!ctx.registeredDevices.includes(name)) {
      throw new Error(`fleet: device '${name}' is not a registered device. Run \`agents devices add ${name}\` or fix the manifest.`);
    }
    out.push(mergeDesired(name, defaults, override));
  }
  return out;
}

export function emptyTargetsMessage(
  manifest: FleetManifest,
): { style: 'hint' | 'plain'; lines: string[] } {
  const rosterEmpty =
    manifest.devices !== 'all' && Object.keys(manifest.devices).length === 0;
  if (rosterEmpty) {
    return {
      style: 'hint',
      lines: [
        'fleet.devices is empty — nothing to converge.',
        'Declare a roster in agents.yaml: `fleet: { devices: all }` for every online box, or name them (`fleet: { devices: { <name>: {} } }`), then re-run.',
      ],
    };
  }
  return { style: 'plain', lines: ['No target devices — nothing to apply.'] };
}
