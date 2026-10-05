import * as os from 'os';
import * as path from 'path';
import { getHistoryDir } from '../../state.js';
import { codexHomeShimBash, codexShortKey, resolveCodexHome } from '../../codex-home.js';
import { codexEditWritableRoots, codexPolicyArgs } from '../../codex-policy.js';
import type { HarnessAdapter } from '../adapter.js';
import { stripForeignConfigDir } from '../adapter.js';

function shimShellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const codexAdapter: HarnessAdapter = {
  id: 'codex',

  applyExecConfigEnv(result, ctx) {
    if (ctx.version && ctx.versionHome) {
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
