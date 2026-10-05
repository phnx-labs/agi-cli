
import type { BashDanger } from './schema2.js';

interface DangerVerdict {
  danger: BashDanger;
  destructiveOperation?: string;
}

const NORMAL: DangerVerdict = { danger: 'normal' };

function baseName(token: string): string {
  const noArgs = token.replace(/^.*\//, '');
  return noArgs.toLowerCase();
}

function hasToken(argv: string[], names: Set<string>): boolean {
  return argv.some((t) => names.has(t));
}

function hasClusterFlag(argv: string[], letters: string[]): boolean {
  return argv.some((t) => {
    if (!/^-[a-zA-Z]+$/.test(t)) return false;
    const body = t.slice(1);
    return letters.every((l) => body.includes(l));
  });
}

function hasLongFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

const RM_TOKEN = new Set(['rm']);
const KILL_TOKEN = new Set(['kill', 'pkill', 'killall']);

const IMPORTANT_REDIRECT_TARGET = /^\/dev\/(?:sd|nvme|disk|hd|mmcblk|vd)/i;

function joinedSql(argv: string[]): string {
  return argv.join(' ').toLowerCase();
}

export function classifyActionDanger(argv: string[], _argvComplete = true): DangerVerdict {

  if (argv.length === 0) return NORMAL;
  const exe = baseName(argv[0]);
  const rest = argv.slice(1);

  if (exe === 'rm' || hasToken(argv, RM_TOKEN)) {
    if (exe === 'rm') {
      const recursive = hasClusterFlag(rest, ['r']) || hasLongFlag(rest, '--recursive');
      const force = hasClusterFlag(rest, ['f']) || hasLongFlag(rest, '--force');
      if (recursive && force) {
        return { danger: 'DESTRUCTIVE', destructiveOperation: 'recursive-force-delete' };
      }
      if (recursive) {
        return { danger: 'DESTRUCTIVE', destructiveOperation: 'recursive-delete' };
      }
      return { danger: 'potentially-destructive', destructiveOperation: 'delete' };
    }
  }

  if (exe === 'git') {
    const sub = rest.find((t) => !t.startsWith('-'));
    if (sub === 'reset') {
      if (hasLongFlag(rest, '--hard')) {
        return { danger: 'DESTRUCTIVE', destructiveOperation: 'git-reset-hard' };
      }
      return { danger: 'potentially-destructive', destructiveOperation: 'git-reset' };
    }
    if (sub === 'clean') {
      if (hasClusterFlag(rest, ['f'])) {
        return { danger: 'DESTRUCTIVE', destructiveOperation: 'git-clean-force' };
      }
      return { danger: 'potentially-destructive', destructiveOperation: 'git-clean' };
    }
    if (sub === 'push') {
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

  if (exe === 'kill' || exe === 'pkill' || exe === 'killall') {
    if (hasToken(rest, new Set(['-9', '-SIGKILL', '-KILL']))) {
      return { danger: 'DESTRUCTIVE', destructiveOperation: 'kill-9' };
    }
    if (hasToken(argv, KILL_TOKEN)) {
      return { danger: 'potentially-destructive', destructiveOperation: 'kill' };
    }
  }

  if (exe === 'mv') {
    return { danger: 'potentially-destructive', destructiveOperation: 'move-overwrite' };
  }

  if (exe === 'dd') {
    if (rest.some((t) => /^of=/.test(t))) {
      return { danger: 'DESTRUCTIVE', destructiveOperation: 'dd-write' };
    }
  }
  if (/^mkfs(\.|$)/.test(exe)) {
    return { danger: 'DESTRUCTIVE', destructiveOperation: 'mkfs' };
  }

  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '>' || t === '>>') {
      const target = argv[i + 1];
      if (target && IMPORTANT_REDIRECT_TARGET.test(target)) {
        return { danger: 'DESTRUCTIVE', destructiveOperation: 'overwrite-device' };
      }
    }
    const fused = t.match(/^>>?(\/\S+)$/);
    if (fused && IMPORTANT_REDIRECT_TARGET.test(fused[1])) {
      return { danger: 'DESTRUCTIVE', destructiveOperation: 'overwrite-device' };
    }
  }

  const sql = joinedSql(argv);
  if (/\bdrop\s+table\b/.test(sql)) {
    return { danger: 'DESTRUCTIVE', destructiveOperation: 'sql-drop-table' };
  }
  if (/\btruncate\b/.test(sql)) {
    return { danger: 'DESTRUCTIVE', destructiveOperation: 'sql-truncate' };
  }
  if (/\bdelete\s+from\b/.test(sql) && !/\bwhere\b/.test(sql)) {
    return { danger: 'DESTRUCTIVE', destructiveOperation: 'sql-delete-no-where' };
  }

  return NORMAL;
}
