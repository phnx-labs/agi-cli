import type { Command, Option } from 'commander';

export interface StripSpec {
  long: string;
  short?: string;
  takesValue: boolean;
}

export const HOST_ROUTING_SPECS: StripSpec[] = [
  { long: 'device', short: 'D', takesValue: true },
  { long: 'host', short: 'H', takesValue: true },
  { long: 'remote-cwd', takesValue: true },
];

export const ROUTING_OPTION_SPECS: StripSpec[] = [
  ...HOST_ROUTING_SPECS,
  { long: 'no-tty', takesValue: false },
  { long: 'hosts', takesValue: true },
  { long: 'devices', takesValue: true },
];

export interface RoutingOccurrence {
  spec: StripSpec;
  start: number;
  end: number;
  value?: string;
}

export interface ScannedArgv {
  commandIndex?: number;
  routing: RoutingOccurrence[];
}

let commandTree: Command | undefined;

export function setArgvCommandTree(root: Command | undefined): void {
  commandTree = root;
}

function matchRouting(arg: string, specs: StripSpec[]): { spec: StripSpec; joined?: string } | undefined {
  for (const spec of specs) {
    if (arg === `--${spec.long}`) return { spec };
    if (arg.startsWith(`--${spec.long}=`)) return { spec, joined: arg.slice(spec.long.length + 3) };
    if (!spec.short) continue;
    if (arg === `-${spec.short}`) return { spec };
    if (arg.startsWith(`-${spec.short}=`)) return { spec, joined: arg.slice(spec.short.length + 2) };
    if (arg.startsWith(`-${spec.short}`)) return { spec, joined: arg.slice(spec.short.length + 1) };
  }
  return undefined;
}

function findOption(chain: Command[], flag: string): Option | undefined {
  for (let c = chain.length - 1; c >= 0; c--) {
    const opt = chain[c].options.find((o) => o.long === flag || o.short === flag);
    if (opt) return opt;
  }
  return undefined;
}

function lastValueIndex(args: string[], i: number, opt: Option): number {
  const next = (j: number) => j < args.length && !args[j].startsWith('-');
  let j = i;
  if (opt.required ? i + 1 < args.length : opt.optional && next(i + 1)) j = i + 1;
  else return i;
  if (opt.variadic) while (next(j + 1)) j++;
  return j;
}

function lastCommandOptionIndex(args: string[], i: number, chain: Command[]): number {
  const arg = args[i];
  if (arg.startsWith('--')) {
    if (arg.includes('=')) return i;
    const opt = findOption(chain, arg);
    return opt ? lastValueIndex(args, i, opt) : i;
  }
  for (let k = 1; k < arg.length; k++) {
    const opt = findOption(chain, `-${arg[k]}`);
    if (!opt) return i;
    if (opt.required || opt.optional) return k === arg.length - 1 ? lastValueIndex(args, i, opt) : i;
  }
  return i;
}

export function scanArgv(args: string[], extra: StripSpec[] = []): ScannedArgv {
  const specs = [...ROUTING_OPTION_SPECS, ...extra.filter((e) => !ROUTING_OPTION_SPECS.some((s) => s.long === e.long))];
  const chain: Command[] = commandTree ? [commandTree] : [];
  const routing: RoutingOccurrence[] = [];
  let commandIndex: number | undefined;
  let operands = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg.length < 2 || !arg.startsWith('-')) {
      commandIndex ??= i;
      const current = chain[chain.length - 1];
      const sub = operands === 0 && current?.commands.find((c) => c.name() === arg || c.aliases().includes(arg));
      if (sub) chain.push(sub);
      else if (commandIndex !== i) operands++;
      continue;
    }
    const hit = matchRouting(arg, specs);
    if (hit) {
      const takesNext = hit.spec.takesValue && hit.joined === undefined && i + 1 < args.length;
      routing.push({ spec: hit.spec, start: i, end: takesNext ? i + 1 : i, value: hit.joined ?? (takesNext ? args[i + 1] : undefined) });
      if (takesNext) i++;
      continue;
    }
    i = lastCommandOptionIndex(args, i, chain);
  }
  return { commandIndex, routing };
}

export function commandTokenIndex(args: string[]): number | undefined {
  return scanArgv(args).commandIndex;
}

export function flagValue(args: string[], long: string, short?: string): string | undefined {
  return scanArgv(args, [{ long, short, takesValue: true }]).routing.find((r) => r.spec.long === long)?.value;
}

export function hasHostRoutingFlag(args: string[]): boolean {
  return scanArgv(args).routing.some(
    (r) => ['device', 'hosts', 'devices'].includes(r.spec.long) && r.value !== undefined,
  );
}
