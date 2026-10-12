import type { AccountInfo } from '../agents.js';

export function compareVersionLabels(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (partsA[i] > partsB[i]) return 1;
    if (partsA[i] < partsB[i]) return -1;
  }
  return 0;
}

export function pruneGroupKey(
  info: Pick<AccountInfo, 'accountKey' | 'email'>
): string | null {
  return info.accountKey ?? info.email?.toLowerCase() ?? null;
}

export interface PruneCandidate {
  version: string;
  release: string;
  email: string | null;
  accountKey: string | null;
  signedIn: boolean;
  hasBinary: boolean;
}

export interface DuplicatePruneEntry {
  version: string;
  email: string;
  keeper: string;
}

/**
 * PURE duplicate-home detection: given every installed home for one agent, decide
 * which are redundant duplicates of the SAME logical account and which single home
 * to keep per account. Extracted from buildAgentPrunePlan so the keeper/merge rules
 * are unit-tested without touching disk.
 *
 * Two rules, both conservative:
 *  - GROUPING. A home with a captured `accountKey` groups by it (account+org, so a
 *    personal Max and a Team seat on the same email stay separate). A home with NO
 *    accountKey folds into a same-email account ONLY when a sibling home for that
 *    email IS identified — that email-only home is an incompletely-captured re-login
 *    of the known account, not a distinct seat (PHNX-3887). Otherwise it groups by
 *    its bare email and only ever collapses against another equally-bare home.
 *  - KEEPER. Within a group the keeper is the home that best represents the account:
 *    captured identity first, then a signed-in credential, then the newest RUNNING
 *    release, then the highest dir label as a stable tiebreak. This is deliberately
 *    NOT "highest dir-name semver" — in the wild that is the freshly re-logged-in
 *    duplicate that never captured its identity or usage, and keeping it while
 *    trashing the identified home is the exact bug this replaces.
 */
export function planDuplicatePrune(candidates: PruneCandidate[]): DuplicatePruneEntry[] {
  const installed = candidates.filter((c) => c.hasBinary && c.email);

  const emailToAccountKeys = new Map<string, Set<string>>();
  for (const c of installed) {
    if (!c.accountKey) continue;
    const email = c.email!.toLowerCase();
    (emailToAccountKeys.get(email) ?? emailToAccountKeys.set(email, new Set()).get(email)!).add(c.accountKey);
  }
  const groupKeyFor = (c: PruneCandidate): string | null => {
    if (c.accountKey) return c.accountKey;
    const email = c.email?.toLowerCase();
    const keys = email ? emailToAccountKeys.get(email) : undefined;
    if (keys && keys.size === 1) return [...keys][0];
    if (keys && keys.size >= 2) return `ambiguous:${c.email!.toLowerCase()}:${c.version}`;
    return pruneGroupKey(c);
  };

  const byAccount = new Map<string, PruneCandidate[]>();
  for (const c of installed) {
    const key = groupKeyFor(c);
    if (!key) continue;
    (byAccount.get(key) ?? byAccount.set(key, []).get(key)!).push(c);
  }

  const rank = (c: PruneCandidate): [number, number] => [c.accountKey ? 1 : 0, c.signedIn ? 1 : 0];
  const better = (a: PruneCandidate, b: PruneCandidate): number => {
    const [aa, ab] = rank(a);
    const [ba, bb] = rank(b);
    if (aa !== ba) return ba - aa;
    if (ab !== bb) return bb - ab;
    if (a.release !== b.release) return compareVersionLabels(b.release, a.release);
    return compareVersionLabels(b.version, a.version);
  };

  const out: DuplicatePruneEntry[] = [];
  for (const group of byAccount.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(better);
    const keeper = sorted[0].version;
    for (const dup of sorted.slice(1)) {
      out.push({ version: dup.version, email: dup.email as string, keeper });
    }
  }
  return out;
}
