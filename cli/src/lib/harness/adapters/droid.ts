import type { HarnessAdapter } from '../adapter.js';

export const droidAdapter: HarnessAdapter = {
  id: 'droid',

  routineModeArgs(cmd, ctx) {
    if (ctx.mode === 'edit') {
      cmd.push('--auto', 'low');
    } else if (ctx.mode === 'auto') {
      cmd.push('--auto', 'high');
    } else if (ctx.mode === 'skip') {
      cmd.push('--skip-permissions-unsafe');
    }
  },
};
