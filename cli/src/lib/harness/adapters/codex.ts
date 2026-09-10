import * as os from 'os';
import * as path from 'path';
import { getHistoryDir } from '../../state.js';
import { codexHomeShimBash, codexShortKey, resolveCodexHome } from '../../codex-home.js';
import { codexEditWritableRoots, codexPolicyArgs } from '../../codex-policy.js';
import type { HarnessAdapter } from '../adapter.js';
import { stripForeignConfigDir } from '../adapter.js';

/**
 * Shim-script single-quoting — identical to the local `shellQuote` in shims.ts
 * (always wraps in single quotes), NOT ssh-exec's variant (which leaves
 * shell-safe strings unquoted). The generated shim's codex launch args must stay
 * byte-for-byte what shims.ts produced, so the quoting moves with the logic.
 */
function shimShellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const codexAdapter: HarnessAdapter = {
  id: 'codex',

  applyExecConfigEnv(result, ctx) {
    if (ctx.version && ctx.versionHome) {
      // On macOS the deep versioned home overflows the Unix-socket SUN_LEN
      // limit for codex's app-server control socket; resolve to a short,
      // SUN_LEN-safe home (migrating once if needed). See codex-home.ts.
      // ctx.versionHome is the account slot on a `codex#<account>` launch, so
      // the short home is keyed by that origin, never by the version alone.
      const originHome = path.join(ctx.versionHome, '.codex');
      const historyDir = getHistoryDir();
      const agentsUserDir = path.dirname(historyDir);
      result.CODEX_HOME = resolveCodexHome(originHome, agentsUserDir, codexShortKey(originHome, ctx.version, historyDir));
    }
    stripForeignConfigDir(result, ['CODEX_HOME']);
  },

  shimConfigEnvBash(ctx) {
    return codexHomeShimBash(
      `$VERSION_DIR/home/${ctx.configDirName}`,
      `$AGENTS_USER_DIR/.codex-homes/$VERSION`,
    );
  },

  shimLaunchArgs() {
    return ` ${[
      '-c',
      'check_for_update_on_startup=false',
      ...codexPolicyArgs('edit'),
    ].map(shimShellQuote).join(' ')}`;
  },

  shimExecTail(launchArgs) {
    // Codex is special: its `workspace-write` sandbox hardcodes any `.agents/`
    // (and `.codex/`) directory read-only, but agents-cli keeps every worktree at
    // `<repo>/.agents/worktrees/<slug>`, so an in-repo build under a static shim
    // would hit `EROFS`. The shim resolves the repo's `.agents` from `$PWD` at RUN
    // time — worktree-aware, mirroring repoAgentsDirForCwd — and passes it via
    // Codex's own `--add-dir`. `--add-dir` is added only when the resolved
    // `.agents` exists.
    return `_repo_agents=""
case "$PWD" in
  */.agents/worktrees/*) _repo_agents="\${PWD%%/.agents/worktrees/*}/.agents" ;;
  *)
    _d="$PWD"
    # Stop before $HOME so a dotfiles repo at $HOME is not treated as the project
    # root (mirrors repoRootForCwd's home exclusion in project-key.ts).
    while [ -n "$_d" ] && [ "$_d" != "/" ] && [ "$_d" != "$HOME" ]; do
      if [ -e "$_d/.git" ]; then _repo_agents="$_d/.agents"; break; fi
      _d=$(dirname "$_d")
    done
    ;;
esac
if [ -n "$_repo_agents" ] && [ -d "$_repo_agents" ]; then
  exec "$BINARY"${launchArgs} --add-dir "$_repo_agents" "$@"
fi
exec "$BINARY"${launchArgs} "$@"`;
  },

  execModeArgs(ctx) {
    const writableRoots = [
      ...codexEditWritableRoots(ctx.cwd),
      ...ctx.addDirs,
    ];
    return codexPolicyArgs(ctx.resolvedMode, writableRoots);
  },

  routineModeArgs(cmd, ctx) {
    const routineRoots = (ctx.config.allow?.dirs ?? []).map((dir) => {
      if (dir.startsWith('-')) {
        throw new Error(`allow.dirs entries must not start with '-': ${JSON.stringify(dir)}`);
      }
      return dir.replace(/^~/, os.homedir());
    });
    cmd.push(...codexPolicyArgs(ctx.mode, [...codexEditWritableRoots(), ...routineRoots]));
  },
};
