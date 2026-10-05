import { describe, expect, it } from 'vitest';
import {
  guardedHome,
  run,
  deviceDoc,
  addDevice,
} from './device-config-test-harness.js';

describe('devices enable/disable', () => {
  it('enable/disable write the auto-launch.enabled key in the device doc', () => {
    guardedHome();
    addDevice('zion');

    const off = run(['devices', 'disable', 'zion']);
    expect(off.status, off.stderr).toBe(0);
    expect(off.stderr).not.toContain('Deprecated');
    expect(deviceDoc('zion')).toContain('autoLaunchEnabled: false');

    expect(run(['devices', 'enable', 'zion']).status).toBe(0);
    expect(deviceDoc('zion')).not.toContain('autoLaunchEnabled');

    const ghost = run(['devices', 'disable', 'zoin']);
    expect(ghost.status).toBe(1);
    expect(ghost.stderr).toMatch(/Unknown device 'zoin'/);
  });

  it('enable/disable are listed in devices --help; the retired verbs are not registered', () => {
    guardedHome();
    const help = run(['devices', '--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/^  enable\b/m);
    expect(help.stdout).toMatch(/^  disable\b/m);
    expect(help.stdout).toContain('config');
    for (const retired of ['configure', 'note', 'set-interactive', 'prefer', 'unprefer', 'set']) {
      expect(help.stdout).not.toMatch(new RegExp(`^  ${retired}\\b`, 'm'));
      expect(run(['devices', retired, 'zion']).status).not.toBe(0);
    }
  });
});
