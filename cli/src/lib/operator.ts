/** Operator identity registry for multi-human feed controls. The mailbox `from` label is
 * unverified; high-consequence blocks (merge/deploy/admin) need a verified operator. Loads
 * ~/.agents/operators.yaml for `recordAnswer` and `agents message --as`. */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { getUserAgentsDir } from './state.js';

export interface Operator {
  id: string;
  name?: string;
  admin?: boolean;
  can?: string[];
}

interface OperatorRegistry {
  operators: Record<string, Operator>;
}

const OPERATORS_FILE = 'operators.yaml';

function getOperatorsPath(root?: string): string {
  return path.join(root ?? getUserAgentsDir(), OPERATORS_FILE);
}

export function loadOperators(root?: string): OperatorRegistry {
  const file = getOperatorsPath(root);
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = yaml.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && 'operators' in parsed) {
      const ops = (parsed as { operators: Record<string, unknown> }).operators;
      const operators: Record<string, Operator> = {};
      for (const [id, v] of Object.entries(ops)) {
        if (v && typeof v === 'object') {
          const entry = v as { name?: unknown; admin?: unknown; can?: unknown };
          operators[id] = {
            id,
            name: typeof entry.name === 'string' ? entry.name : undefined,
            admin: entry.admin === true,
            can: Array.isArray(entry.can)
              ? entry.can.filter((c): c is string => typeof c === 'string')
              : undefined,
          };
        }
      }
      return { operators };
    }
  } catch {
    // missing or malformed -> empty registry
  }
  return { operators: {} };
}

export function getOperator(id: string, root?: string): Operator | undefined {
  return loadOperators(root).operators[id];
}

export function isKnownOperator(id: string, root?: string): boolean {
  return getOperator(id, root) !== undefined;
}

export function isAdmin(id: string, root?: string): boolean {
  const op = getOperator(id, root);
  return op?.admin === true;
}

export function canPerform(id: string, action: string, root?: string): boolean {
  const op = getOperator(id, root);
  if (!op) return false;
  if (op.admin) return true;
  return op.can?.includes(action) ?? false;
}

/** High-consequence blocks require a known operator with explicit merge/deploy/admin rights. */
export function isHighConsequenceAllowed(blockConsequence: string | undefined, operatorId: string, root?: string): boolean {
  if (!blockConsequence || blockConsequence === 'normal') return true;
  if (!isKnownOperator(operatorId, root)) return false;
  if (isAdmin(operatorId, root)) return true;
  return canPerform(operatorId, blockConsequence, root);
}

/** Proves operator identity for high-consequence answers. Knowing an id in operators.yaml isn't
 * authentication (any same-user process can pass `--as muqsit`), so the environment must claim the
 * same id via AGENTS_OPERATOR_ID (injected by `agents secrets` or the launch context). */
export function verifyOperatorIdentity(claimedId: string | undefined, root?: string): boolean {
  if (!claimedId) return false;
  if (!isKnownOperator(claimedId, root)) return false;
  const envId = process.env.AGENTS_OPERATOR_ID?.trim();
  if (!envId) return false;
  return envId === claimedId;
}

