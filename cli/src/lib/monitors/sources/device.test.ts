import { describe, expect, it } from 'vitest';
import { evaluate } from './device.js';

describe('device source evaluate', () => {
  it('returns null when no device is set', async () => {
    expect(await evaluate({ type: 'device' })).toBeNull();
  });

  it('surfaces an unregistered device as an error observation, never local stats', async () => {
    const obs = await evaluate({ type: 'device', device: 'no-such-device-zzz-9137' });
    expect(obs).not.toBeNull();
    expect(obs!.meta?.error).toBe(true);
    expect(obs!.raw).toContain('device not registered');
  });
});
