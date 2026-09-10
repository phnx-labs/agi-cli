import { describe, expect, it } from 'vitest';
import type { ArcNativeTabRef, ArcNativeTaskState, BackendKind } from './types.js';
import { arcCreateMarker, isArcCreateMarker } from './service.js';

describe('durable native Arc identity', () => {
  it('addresses a tab only by stable window, Space, and tab ids', () => {
    const ref: ArcNativeTabRef = {
      windowId: 'window-7',
      spaceId: 'space-work',
      tabId: 'tab-42',
    };
    expect(ref).toEqual({ windowId: 'window-7', spaceId: 'space-work', tabId: 'tab-42' });
    expect('url' in ref).toBe(false);
    expect('title' in ref).toBe(false);
  });

  it('persists exact owned refs and creation intent separately', () => {
    const state: ArcNativeTaskState = {
      profileId: 'Profile 1',
      windowId: 'window-7',
      spaceId: 'space-work',
      spaceTitle: 'Work',
      tabs: {
        a1b2c3d4: { windowId: 'window-7', spaceId: 'space-work', tabId: 'tab-42' },
      },
      createIntents: {
        e5f6a7b8: {
          tabId: 'e5f6a7b8',
          markerUrl: 'https://agents-browser.invalid/unique',
          targetUrl: 'https://example.com/',
          createdAt: 1,
          previousTabId: 'tab-9',
        },
      },
    };
    expect(state.tabs.a1b2c3d4.tabId).toBe('tab-42');
    expect(state.createIntents?.e5f6a7b8.targetUrl).toBe('https://example.com/');
  });

  it('keeps the transport backend discriminant explicit', () => {
    expect(['cdp', 'arc-native'] satisfies BackendKind[]).toEqual(['cdp', 'arc-native']);
  });

  it('creates tabs at a unique https marker Arc accepts, never data: or about:', () => {
    // Arc's `make new tab` rejects data: and about: URLs with "Please provide a
    // valid URL property", so the marker must be http(s). The reserved .invalid
    // TLD keeps it off the network.
    const marker = arcCreateMarker();
    expect(marker).toMatch(/^https:\/\/agents-browser\.invalid\/[0-9a-f-]{36}$/);
    expect(arcCreateMarker()).not.toBe(marker);
    expect(isArcCreateMarker(marker)).toBe(true);
    expect(isArcCreateMarker('data:text/plain,agents-browser-x')).toBe(false);
    expect(isArcCreateMarker('about:blank#agents-browser-x')).toBe(false);
  });
});
