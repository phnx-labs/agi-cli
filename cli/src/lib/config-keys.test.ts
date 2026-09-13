import { describe, expect, it } from 'vitest';
import {
  parseConfigKey,
  formatConfigKey,
  devicePropertyToConfigName,
  listKnownConfigKeys,
  configKeyStorageHint,
} from './config-keys.js';

describe('config-keys', () => {
  describe('parseConfigKey', () => {
    it('parses run model key with wildcard version', () => {
      const parsed = parseConfigKey('run.claude@*.model');
      expect(parsed).toEqual({ scope: 'run', agent: 'claude', version: '*', property: 'model' });
    });

    it('parses run model key with concrete version', () => {
      const parsed = parseConfigKey('run.claude@2.1.45.model');
      expect(parsed).toEqual({ scope: 'run', agent: 'claude', version: '2.1.45', property: 'model' });
    });

    it('parses run mode and effort keys', () => {
      expect(parseConfigKey('run.codex@0.134.0.mode')).toEqual({
        scope: 'run',
        agent: 'codex',
        version: '0.134.0',
        property: 'mode',
      });
      expect(parseConfigKey('run.grok@*.effort')).toEqual({
        scope: 'run',
        agent: 'grok',
        version: '*',
        property: 'effort',
      });
    });

    it('parses run tier key', () => {
      expect(parseConfigKey('run.claude@*.tier.best')).toEqual({
        scope: 'run',
        agent: 'claude',
        version: '*',
        property: 'tier',
        tier: 'best',
      });
    });

    it('accepts colon as agent/version separator', () => {
      const parsed = parseConfigKey('run.claude:2.1.45.model');
      expect(parsed).toEqual({ scope: 'run', agent: 'claude', version: '2.1.45', property: 'model' });
    });

    it('parses interactive host', () => {
      expect(parseConfigKey('interactive.host')).toEqual({ scope: 'interactive', property: 'host' });
    });

    it('parses browser profile', () => {
      expect(parseConfigKey('browser.profile')).toEqual({ scope: 'browser', property: 'profile' });
    });

    it('parses the fleet browser hub (browser.device) as a user-scope central key', () => {
      expect(parseConfigKey('browser.device')).toEqual({ scope: 'browser', property: 'device' });
      expect(configKeyStorageHint(parseConfigKey('browser.device'))).toContain('central agents.yaml');
      expect(listKnownConfigKeys()).toContain('browser.device');
    });

    it('names browser.device in the invalid-browser-key error', () => {
      expect(() => parseConfigKey('browser.bogus')).toThrow(/browser\.device/);
    });

    it('parses device config keys', () => {
      expect(parseConfigKey('devices.mac-mini.max-agents')).toEqual({
        scope: 'device',
        device: 'mac-mini',
        property: 'max-agents',
      });
      expect(parseConfigKey('devices.mac-mini.scheduler')).toEqual({
        scope: 'device',
        device: 'mac-mini',
        property: 'scheduler',
      });
      expect(parseConfigKey('devices.mac-mini.browser.remote-control')).toEqual({
        scope: 'device',
        device: 'mac-mini',
        property: 'browser.remote-control',
      });
      expect(parseConfigKey('devices.mac-mini.browser.task-idle-minutes')).toEqual({
        scope: 'device',
        device: 'mac-mini',
        property: 'browser.task-idle-minutes',
      });
      expect(parseConfigKey('devices.mac-mini.browser.profile')).toEqual({
        scope: 'device',
        device: 'mac-mini',
        property: 'browser.profile',
      });
    });

    it('rejects unknown agent', () => {
      expect(() => parseConfigKey('run.notanagent@*.model')).toThrow(/Unknown agent/);
    });

    it('rejects invalid version', () => {
      expect(() => parseConfigKey('run.claude@bad..version.model')).toThrow(/Invalid version/);
    });

    it('rejects invalid run property', () => {
      expect(() => parseConfigKey('run.claude@*.foo')).toThrow(/Invalid run config key/);
    });

    it('rejects invalid tier', () => {
      expect(() => parseConfigKey('run.claude@*.tier.extreme')).toThrow(/Invalid run config key/);
    });

    it('rejects unknown scope', () => {
      expect(() => parseConfigKey('foo.bar')).toThrow(/Unknown config scope/);
    });

    it('rejects incomplete device key', () => {
      expect(() => parseConfigKey('devices.mac-mini')).toThrow(/Invalid device config key/);
    });

    it('rejects unknown device property', () => {
      expect(() => parseConfigKey('devices.mac-mini.unknown')).toThrow(/Invalid device config key/);
    });

    it('parses the device formFactor key', () => {
      expect(parseConfigKey('devices.zion.formFactor')).toEqual({
        scope: 'device',
        device: 'zion',
        property: 'formFactor',
      });
    });

    it('parses AGI Menu preference keys', () => {
      expect(parseConfigKey('menubar.menu.defaultProject')).toEqual({ scope: 'menubar', property: 'defaultProject' });
      expect(parseConfigKey('menubar.menu.workingRowsShown')).toEqual({ scope: 'menubar', property: 'workingRowsShown' });
      expect(parseConfigKey('menubar.menu.showPullRequests')).toEqual({ scope: 'menubar', property: 'showPullRequests' });
      expect(configKeyStorageHint(parseConfigKey('menubar.menu.groupBy'))).toContain('central agents.yaml');
      expect(listKnownConfigKeys()).toContain('menubar.menu.ticketSort');
    });

    it('rejects an unknown AGI Menu preference key', () => {
      expect(() => parseConfigKey('menubar.menu.bogus')).toThrow(/Unknown AGI Menu preference/);
    });
  });

  describe('formatConfigKey', () => {
    it('round-trips parsed keys', () => {
      for (const key of [
        'run.claude@*.model',
        'run.claude@2.1.45.tier.best',
        'interactive.host',
        'browser.profile',
        'devices.mac-mini.max-agents',
        'devices.mac-mini.tmux',
        'devices.zion.formFactor',
        'menubar.menu.projectScope',
        'menubar.menu.showPreviews',
      ]) {
        expect(formatConfigKey(parseConfigKey(key))).toBe(key);
      }
    });
  });

  describe('devicePropertyToConfigName', () => {
    it('maps friendly names to internal config keys', () => {
      expect(devicePropertyToConfigName('max-agents')).toBe('agents.max-concurrent');
      expect(devicePropertyToConfigName('scheduler')).toBe('scheduler.enabled');
      expect(devicePropertyToConfigName('daemon')).toBe('daemon.enabled');
      expect(devicePropertyToConfigName('watchdog')).toBe('watchdog.enabled');
      expect(devicePropertyToConfigName('tmux')).toBe('tmux.enabled');
      expect(devicePropertyToConfigName('browser.remote-control')).toBe('browser.remote-control');
      expect(devicePropertyToConfigName('browser.task-idle-minutes')).toBe('browser.task-idle-minutes');
      expect(devicePropertyToConfigName('notes')).toBe('notes');
      expect(devicePropertyToConfigName('browser.profile')).toBe('browser.profile');
    });
  });

  describe('listKnownConfigKeys', () => {
    it('includes run, interactive, browser, and device keys', () => {
      const keys = listKnownConfigKeys();
      expect(keys).toContain('run.<agent@version>.model');
      expect(keys).toContain('run.<agent@version>.tier.best');
      expect(keys).toContain('interactive.host');
      expect(keys).toContain('browser.profile');
      expect(keys).toContain('devices.<name>.max-agents');
      expect(keys).toContain('devices.<name>.browser.task-idle-minutes');
    });
  });

  describe('configKeyStorageHint', () => {
    it('describes where run keys are stored', () => {
      expect(configKeyStorageHint(parseConfigKey('run.claude@*.model'))).toBe(
        'run.defaults.claude:*.model',
      );
      expect(configKeyStorageHint(parseConfigKey('run.claude@*.tier.best'))).toBe(
        'model.tiers.claude:*.best',
      );
    });
  });
});
