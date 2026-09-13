/**
 * Danger classifier for a single shell action's argv (PHNX-3442, producer side).
 *
 * Safety-sensitive: the schema-2 `BashAction.danger` drives the console's
 * destructive-operation surfacing and risk scoring. So this is CONSERVATIVE by
 * construction — it defaults to `normal` and only escalates on CLEAR structural
 * evidence in the tokenized argv, never on a substring of raw command text. The
 * argv it reads is one tokenizeBash segment (see `tokenizeBash` in
 * `session/bash-command.ts`): the executable at argv[0] and its already-split
 * arguments, so a flag like `-rf` is a whole token, not a substring hunt.
 *
 * The three levels mirror the shipped consumer union (`BashDanger`):
 *   - DESTRUCTIVE            — irrecoverable data loss / history rewrite / force
 *                              overwrite of an important path. Requires a WHERE-less
 *                              DELETE, a recursive/force delete, a hard reset, etc.
 *   - potentially-destructive — plain `rm`, soft/mixed `git reset`, `mv` over a
 *                              path, plain `kill` — recoverable-ish but worth a flag.
 *   - normal                 — everything else.
 *
 * `destructiveOperation` is a short stable label (never raw text) naming WHY the
 * action was flagged, so the console can group by operation without re-parsing.
 */

import type { BashDanger } from './schema2.js';

interface DangerVerdict {
  danger: BashDanger;
  /** Short stable label naming the operation, e.g. `recursive-delete`. Omitted for `normal`. */
  destructiveOperation?: string;
}

const NORMAL: DangerVerdict = { danger: 'normal' };

/** basename of an executable token so `/bin/rm` and `rm` classify alike. */
function baseName(token: string): string {
  const noArgs = token.replace(/^.*\//, '');
  return noArgs.toLowerCase();
}

/** True when any argv token is exactly one of `names`. */
function hasToken(argv: string[], names: Set<string>): boolean {
  return argv.some((t) => names.has(t));
}

/** A single-dash cluster flag that CONTAINS every letter in `letters` (e.g. `-rf` ⊇ r,f). */
function hasClusterFlag(argv: string[], letters: string[]): boolean {
  return argv.some((t) => {
    if (!/^-[a-zA-Z]+$/.test(t)) return false; // single-dash short cluster only
    const body = t.slice(1);
    return letters.every((l) => body.includes(l));
  });
}

/** A GNU long flag present as its own token (e.g. `--force`, `--hard`). */
function hasLongFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

const RM_TOKEN = new Set(['rm']);
const KILL_TOKEN = new Set(['kill', 'pkill', 'killall']);

/** Paths that are catastrophic to force-overwrite via a redirect target. */
const IMPORTANT_REDIRECT_TARGET = /^\/dev\/(?:sd|nvme|disk|hd|mmcblk|vd)/i;

/**
 * SQL-ish argv reconstruction: for a `psql -c "DROP TABLE x"` the SQL lives in a
 * single quoted token, so danger scanning of SQL joins the argv back into one
 * lower-cased string and matches structural SQL, not shell tokens. Bounded to the
 * argv we already hold — no new parse.
 */
function joinedSql(argv: string[]): string {
  return argv.join(' ').toLowerCase();
}

/**
 * Classify one tokenized shell action. `argvComplete` is false when a dynamic node
 * (command substitution / glob / var expansion) kept the argv incomplete; when a
 * DESTRUCTIVE signal depends on a token that could have been mangled by expansion
 * we DO still flag it (a `rm -rf $DIR` is destructive regardless of what `$DIR`
 * expands to), because the operation itself is the danger, not its target.
 */
export function classifyActionDanger(argv: string[], _argvComplete = true): DangerVerdict {
  if (argv.length === 0) return NORMAL;
  const exe = baseName(argv[0]);
  // Everything after the executable — the flags/args the danger tests read.
  const rest = argv.slice(1);

  // ── rm ──────────────────────────────────────────────────────────────────
  if (exe === 'rm' || hasToken(argv, RM_TOKEN)) {
    // Only treat a real `rm` invocation (argv[0]) — a stray `rm` argument to some
    // other tool is not an rm call.
    if (exe === 'rm') {
      const recursive = hasClusterFlag(rest, ['r']) || hasLongFlag(rest, '--recursive');
      const force = hasClusterFlag(rest, ['f']) || hasLongFlag(rest, '--force');
      if (recursive && force) {
        return { danger: 'DESTRUCTIVE', destructiveOperation: 'recursive-force-delete' };
      }
      if (recursive) {
        return { danger: 'DESTRUCTIVE', destructiveOperation: 'recursive-delete' };
      }
      // Plain `rm file` (or `rm -f file` without recursion) — recoverable-ish.
      return { danger: 'potentially-destructive', destructiveOperation: 'delete' };
    }
  }

  // ── git ─────────────────────────────────────────────────────────────────
  if (exe === 'git') {
    const sub = rest.find((t) => !t.startsWith('-'));
    if (sub === 'reset') {
      if (hasLongFlag(rest, '--hard')) {
        return { danger: 'DESTRUCTIVE', destructiveOperation: 'git-reset-hard' };
      }
      // soft / mixed reset — moves HEAD but keeps the working tree.
      return { danger: 'potentially-destructive', destructiveOperation: 'git-reset' };
    }
    if (sub === 'clean') {
      // `git clean -fd` / `-fdx` — deletes untracked files irrecoverably.
      if (hasClusterFlag(rest, ['f'])) {
        return { danger: 'DESTRUCTIVE', destructiveOperation: 'git-clean-force' };
      }
      return { danger: 'potentially-destructive', destructiveOperation: 'git-clean' };
    }
    if (sub === 'push') {
      // A leading-`+` refspec (`git push origin +main`, `+refs/heads/main:main`,
      // `+HEAD:main`) forces the push just like `--force`, with no flag to catch.
      // Match a `+` followed by a ref char — not a lone `+` or a `+-`-style flag.
      const forceRefspec = rest.some((t) => /^\+[^-\s]/.test(t));
      if (
        hasLongFlag(rest, '--force') ||
        hasClusterFlag(rest, ['f']) ||
        rest.includes('--force-with-lease') ||
        forceRefspec
      ) {
        return { danger: 'DESTRUCTIVE', destructiveOperation: 'git-push-force' };
      }
    }
    if (sub === 'checkout') {
      // `git checkout -- .` / `git checkout -- <path>` throws away working changes.
      if (rest.includes('--')) {
        return { danger: 'DESTRUCTIVE', destructiveOperation: 'git-checkout-discard' };
      }
    }
    if (sub === 'stash') {
      const after = rest.slice(rest.indexOf('stash') + 1);
      if (after.includes('drop') || after.includes('clear')) {
        return { danger: 'DESTRUCTIVE', destructiveOperation: 'git-stash-drop' };
      }
    }
    return NORMAL;
  }

  // ── kill ────────────────────────────────────────────────────────────────
  if (exe === 'kill' || exe === 'pkill' || exe === 'killall') {
    if (hasToken(rest, new Set(['-9', '-SIGKILL', '-KILL']))) {
      return { danger: 'DESTRUCTIVE', destructiveOperation: 'kill-9' };
    }
    if (hasToken(argv, KILL_TOKEN)) {
      return { danger: 'potentially-destructive', destructiveOperation: 'kill' };
    }
  }

  // ── mv (over an existing path — we cannot know if the target exists, so this is
  // the recoverable-ish tier, never DESTRUCTIVE) ────────────────────────────
  if (exe === 'mv') {
    return { danger: 'potentially-destructive', destructiveOperation: 'move-overwrite' };
  }

  // ── dd / mkfs (disk writers) ──────────────────────────────────────────────
  if (exe === 'dd') {
    if (rest.some((t) => /^of=/.test(t))) {
      return { danger: 'DESTRUCTIVE', destructiveOperation: 'dd-write' };
    }
  }
  if (/^mkfs(\.|$)/.test(exe)) {
    return { danger: 'DESTRUCTIVE', destructiveOperation: 'mkfs' };
  }

  // ── redirect to a raw device / important path ─────────────────────────────
  // A `> /dev/sda`-style redirect target appears as a token in the argv (the
  // tokenizer keeps `>` and its target). Flag only clearly catastrophic targets.
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '>' || t === '>>') {
      const target = argv[i + 1];
      if (target && IMPORTANT_REDIRECT_TARGET.test(target)) {
        return { danger: 'DESTRUCTIVE', destructiveOperation: 'overwrite-device' };
      }
    }
    // Fused form `>/dev/sda`.
    const fused = t.match(/^>>?(\/\S+)$/);
    if (fused && IMPORTANT_REDIRECT_TARGET.test(fused[1])) {
      return { danger: 'DESTRUCTIVE', destructiveOperation: 'overwrite-device' };
    }
  }

  // ── SQL (psql/mysql/sqlite3 -c "…", or a bare SQL statement) ───────────────
  const sql = joinedSql(argv);
  if (/\bdrop\s+table\b/.test(sql)) {
    return { danger: 'DESTRUCTIVE', destructiveOperation: 'sql-drop-table' };
  }
  if (/\btruncate\b/.test(sql)) {
    return { danger: 'DESTRUCTIVE', destructiveOperation: 'sql-truncate' };
  }
  // DELETE FROM without a WHERE clause. A DELETE with WHERE is scoped → normal.
  if (/\bdelete\s+from\b/.test(sql) && !/\bwhere\b/.test(sql)) {
    return { danger: 'DESTRUCTIVE', destructiveOperation: 'sql-delete-no-where' };
  }

  return NORMAL;
}
