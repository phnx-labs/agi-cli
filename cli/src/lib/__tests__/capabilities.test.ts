import { describe, it, expect } from 'vitest';
import { supports, isCapable, capableAgents, explainSkip } from '../capabilities.js';

describe('supports() capability gate', () => {
  describe('agent-level (no version)', () => {
    it('returns ok for capabilities marked true', () => {
      expect(supports('claude', 'hooks')).toEqual({ ok: true });
      expect(supports('claude', 'mcp')).toEqual({ ok: true });
    });

    it('returns unsupported for capabilities marked false', () => {
      expect(supports('amp', 'hooks')).toEqual({ ok: false, reason: 'unsupported' });
      expect(supports('amp', 'plugins')).toEqual({ ok: false, reason: 'unsupported' });
    });

    it('returns ok for object-form caps when version omitted', () => {
      expect(supports('codex', 'hooks')).toEqual({ ok: true });
    });

    it('blocks hard-deprecated gemini for every managed capability path', () => {
      expect(isCapable('gemini', 'hooks')).toBe(false);
      expect(supports('gemini', 'hooks')).toEqual({ ok: false, reason: 'unsupported' });
      expect(supports('gemini', 'hooks', '0.26.0')).toEqual({ ok: false, reason: 'unsupported' });
      expect(capableAgents('hooks')).not.toContain('gemini');
      expect(capableAgents('mcp')).not.toContain('gemini');
      expect(capableAgents('subagents')).not.toContain('gemini');
    });

    it('returns ok for rules file object-form caps', () => {
      expect(supports('claude', 'rules')).toEqual({ ok: true });
      expect(supports('claude', 'rules', '1.0.0')).toEqual({ ok: true });
    });
  });

  describe('codex hooks since 0.116.0', () => {
    it('gates 0.115.x as too_old', () => {
      const result = supports('codex', 'hooks', '0.115.9');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('too_old');
        expect(result.need).toBe('>= 0.116.0');
      }
    });

    it('gates 0.113.0 as too_old', () => {
      const result = supports('codex', 'hooks', '0.113.0');
      expect(result.ok).toBe(false);
    });

    it('passes 0.116.0 exactly', () => {
      expect(supports('codex', 'hooks', '0.116.0')).toEqual({ ok: true });
    });

    it('passes 0.117.0 and above', () => {
      expect(supports('codex', 'hooks', '0.117.0')).toEqual({ ok: true });
      expect(supports('codex', 'hooks', '1.0.0')).toEqual({ ok: true });
    });
  });

  describe('copilot subagents since 0.0.353', () => {
  it('gates 0.0.352 as too_old', () => {
    const result = supports('copilot', 'subagents', '0.0.352');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('too_old');
      expect(result.need).toBe('>= 0.0.353');
    }
  });

  it('passes 0.0.353 exactly', () => {
    expect(supports('copilot', 'subagents', '0.0.353')).toEqual({ ok: true });
  });

  it('passes 1.0.0 and above', () => {
    expect(supports('copilot', 'subagents', '1.0.0')).toEqual({ ok: true });
  });
});

describe('goose workflows support', () => {
  it('passes the workflow capability check and reports no allowlist', () => {
    expect(supports('goose', 'workflows')).toEqual({ ok: true });
    expect(supports('goose', 'allowlist')).toEqual({ ok: false, reason: 'unsupported' });
    expect(capableAgents('allowlist')).not.toContain('goose');
  });
});

describe('openclaw allowlist', () => {
  it('is capable of allowlist', () => {
    expect(supports('openclaw', 'allowlist')).toEqual({ ok: true });
    expect(capableAgents('allowlist')).toContain('openclaw');
  });
});

describe('copilot allowlist', () => {
  it('is capable of allowlist', () => {
    expect(supports('copilot', 'allowlist')).toEqual({ ok: true });
    expect(capableAgents('allowlist')).toContain('copilot');
  });
});

describe('hermes allowlist', () => {
  it('is capable of allowlist', () => {
    expect(supports('hermes', 'allowlist')).toEqual({ ok: true });
    expect(capableAgents('allowlist')).toContain('hermes');
  });
});

describe('unsupported agents skip regardless of version', () => {
  it('cursor hooks are supported', () => {
    expect(supports('cursor', 'hooks').ok).toBe(true);
    expect(supports('cursor', 'hooks', '999.0.0').ok).toBe(true);
  });

  it('opencode plugins are supported (TS module install path)', () => {
    expect(supports('opencode', 'plugins').ok).toBe(true);
  });

  it('amp plugins always unsupported (writer not implemented)', () => {
    expect(supports('amp', 'plugins', '999.0.0').ok).toBe(false);
  });
});

});

describe('mcpHttp / mcpHeaders capability gates', () => {
  it('mcpHttp: supported by HTTP MCP config writers', () => {
    expect(supports('claude', 'mcpHttp').ok).toBe(true);
    expect(supports('codex', 'mcpHttp').ok).toBe(true);
    expect(supports('gemini', 'mcpHttp').ok).toBe(false);
    expect(supports('hermes', 'mcpHttp').ok).toBe(true);
    expect(supports('cursor', 'mcpHttp').ok).toBe(false);
    expect(supports('opencode', 'mcpHttp').ok).toBe(false);
    expect(supports('openclaw', 'mcpHttp').ok).toBe(false);
    expect(supports('copilot', 'mcpHttp').ok).toBe(false);
    expect(supports('amp', 'mcpHttp').ok).toBe(false);
    expect(supports('goose', 'mcpHttp').ok).toBe(false);
    expect(supports('antigravity', 'mcpHttp').ok).toBe(false);
    expect(supports('grok', 'mcpHttp').ok).toBe(false);
    expect(supports('kimi', 'mcpHttp').ok).toBe(false);
    expect(supports('droid', 'mcpHttp').ok).toBe(false);
  });

  it('mcpHeaders: claude, muse and warp', () => {
    expect(supports('claude', 'mcpHeaders').ok).toBe(true);
    expect(supports('codex', 'mcpHeaders').ok).toBe(false);
    expect(supports('gemini', 'mcpHeaders').ok).toBe(false);
    expect(supports('cursor', 'mcpHeaders').ok).toBe(false);
    expect(supports('opencode', 'mcpHeaders').ok).toBe(false);
    expect(supports('openclaw', 'mcpHeaders').ok).toBe(false);
    expect(supports('copilot', 'mcpHeaders').ok).toBe(false);
    expect(supports('amp', 'mcpHeaders').ok).toBe(false);
    expect(supports('goose', 'mcpHeaders').ok).toBe(false);
    expect(supports('antigravity', 'mcpHeaders').ok).toBe(false);
    expect(supports('grok', 'mcpHeaders').ok).toBe(false);
    expect(supports('kimi', 'mcpHeaders').ok).toBe(false);
    expect(supports('droid', 'mcpHeaders').ok).toBe(false);
    expect(supports('hermes', 'mcpHeaders').ok).toBe(false);
    expect(supports('warp', 'mcpHeaders').ok).toBe(true);
  });

  it('capableAgents(mcpHttp) matches direct HTTP MCP config writers', () => {
    expect(capableAgents('mcpHttp').sort()).toEqual([
      'claude',
      'codex',
      'hermes',
      'muse',
      'warp',
    ]);
  });

  it('capableAgents(mcpHeaders) is claude, muse, and warp (the header-honoring writers)', () => {
    expect(capableAgents('mcpHeaders').sort()).toEqual(['claude', 'muse', 'warp']);
  });
});

describe('isCapable()', () => {
  it('reports true for any non-false capability', () => {
    expect(isCapable('claude', 'hooks')).toBe(true);
    expect(isCapable('codex', 'hooks')).toBe(true);
  });

  it('reports false for explicit false', () => {
    expect(isCapable('amp', 'hooks')).toBe(false);
    expect(isCapable('amp', 'plugins')).toBe(false);
  });

  it('reports false for an unknown agent id instead of throwing (RUSH-1153)', () => {
    expect(() => isCapable('claude@2.1.168' as never, 'plugins')).not.toThrow();
    expect(isCapable('claude@2.1.168' as never, 'plugins')).toBe(false);
    expect(supports('not-an-agent' as never, 'plugins')).toEqual({ ok: false, reason: 'unsupported' });
  });
});

describe('capableAgents()', () => {
  it('includes claude/codex for hooks, excludes openclaw (no registrar) and hard-deprecated gemini', () => {
    const agents = capableAgents('hooks');
    expect(agents).toContain('claude');
    expect(agents).toContain('codex');
    expect(agents).not.toContain('openclaw');
    expect(agents).not.toContain('gemini');
  });

  it('includes copilot for hooks (GA @github/copilot hooks system)', () => {
    const agents = capableAgents('hooks');
    expect(agents).toContain('copilot');
  });

  it('includes goose for hooks (block-goose-cli ≥ 1.34.0 Open Plugins)', () => {
    const agents = capableAgents('hooks');
    expect(agents).toContain('goose');
  });

  it('includes cursor for hooks (cursor-agent CLI hooks since 2026-01-16)', () => {
    const agents = capableAgents('hooks');
    expect(agents).toContain('cursor');
  });

  it('includes hermes for hooks (Hermes Agent config.yaml hooks since 0.11.0)', () => {
    const agents = capableAgents('hooks');
    expect(agents).toContain('hermes');
  });

  it('includes muse for hooks (Claude-shaped settings.json under ~/.config/muse)', () => {
    const agents = capableAgents('hooks');
    expect(agents).toContain('muse');
  });

  it('includes OpenCode hooks through its plugin API and excludes amp', () => {
    const agents = capableAgents('hooks');
    expect(agents).toContain('opencode');
    expect(agents).not.toContain('amp');
  });
});

describe('opencode hooks version gate', () => {
  it('gates versions below 0.3.130 and passes the plugin-shell release', () => {
    expect(supports('opencode', 'hooks', '0.3.129').ok).toBe(false);
    expect(supports('opencode', 'hooks', '0.3.130')).toEqual({ ok: true });
    expect(supports('opencode', 'hooks', '1.18.4')).toEqual({ ok: true });
  });
});

describe('goose hooks version gate', () => {
  it('gates versions below 1.34.0 as too_old', () => {
    const result = supports('goose', 'hooks', '1.33.0');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('too_old');
      expect(result.need).toBe('>= 1.34.0');
    }
  });

  it('passes 1.34.0 and above', () => {
    expect(supports('goose', 'hooks', '1.34.0')).toEqual({ ok: true });
    expect(supports('goose', 'hooks', '1.37.0')).toEqual({ ok: true });
  });
});

describe('hermes hooks version gate', () => {
  it('gates versions below 0.11.0 as too_old', () => {
    const result = supports('hermes', 'hooks', '0.10.0');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('too_old');
      expect(result.need).toBe('>= 0.11.0');
    }
  });

  it('passes 0.11.0 and above', () => {
    expect(supports('hermes', 'hooks', '0.11.0')).toEqual({ ok: true });
    expect(supports('hermes', 'hooks', '0.14.2')).toEqual({ ok: true });
  });
});

describe('droid skills version gate', () => {
  it('gates versions below 0.26.0 as too_old', () => {
    const result = supports('droid', 'skills', '0.25.9');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.need).toBe('>= 0.26.0');
  });

  it('passes 0.26.0 and above', () => {
    expect(supports('droid', 'skills', '0.26.0')).toEqual({ ok: true });
    expect(supports('droid', 'skills', '0.161.0')).toEqual({ ok: true });
  });
});

describe('droid allowlist version gate', () => {
  it('gates versions below 0.57.5 as too_old', () => {
    const result = supports('droid', 'allowlist', '0.57.4');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.need).toBe('>= 0.57.5');
  });

  it('passes 0.57.5 and above', () => {
    expect(supports('droid', 'allowlist', '0.57.5')).toEqual({ ok: true });
    expect(supports('droid', 'allowlist', '0.159.0')).toEqual({ ok: true });
  });
});

describe('antigravity subagents version gate', () => {
  it('gates versions below 1.0.16 as too_old', () => {
    const result = supports('antigravity', 'subagents', '1.0.15');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('too_old');
      expect(result.need).toBe('>= 1.0.16');
    }
  });

  it('passes 1.0.16 and above', () => {
    expect(supports('antigravity', 'subagents', '1.0.16')).toEqual({ ok: true });
    expect(supports('antigravity', 'subagents', '1.1.1')).toEqual({ ok: true });
  });
});

describe('cursor subagents version gate', () => {
  it('gates pre-2.4 cursor-agent (CalVer) builds as too_old', () => {
    const result = supports('cursor', 'subagents', '2025.11.25');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('too_old');
      expect(result.need).toBe('>= 2026.1.22');
    }
    expect(supports('cursor', 'subagents', '2026.1.21').ok).toBe(false);
  });

  it('passes 2026.1.22 (Cursor 2.4) and above', () => {
    expect(supports('cursor', 'subagents', '2026.1.22')).toEqual({ ok: true });
    expect(supports('cursor', 'subagents', '2026.2.1')).toEqual({ ok: true });
  });
});

describe('workflow capability gates', () => {
  it('includes Antigravity, Claude, Goose, Grok, Kimi, and OpenClaw for workflow sync', () => {
    expect(supports('claude', 'workflows')).toEqual({ ok: true });
    expect(supports('antigravity', 'workflows')).toEqual({ ok: true });
    expect(supports('goose', 'workflows')).toEqual({ ok: true });
    expect(supports('grok', 'workflows')).toEqual({ ok: true });
    expect(supports('kimi', 'workflows')).toEqual({ ok: true });
    expect(supports('openclaw', 'workflows')).toEqual({ ok: true });
    expect(capableAgents('workflows').sort()).toEqual(['antigravity', 'claude', 'goose', 'grok', 'kimi', 'openclaw']);
  });

  it('gates Antigravity workflows at >= 1.0.6', () => {
    expect(supports('antigravity', 'workflows', '1.0.5')).toEqual({ ok: false, reason: 'too_old', need: '>= 1.0.6' });
    expect(supports('antigravity', 'workflows', '1.0.6')).toEqual({ ok: true });
    expect(supports('antigravity', 'workflows', '1.1.0')).toEqual({ ok: true });
  });
});

describe('explainSkip()', () => {
  it('formats unsupported message', () => {
    const r = supports('amp', 'hooks');
    expect(explainSkip('amp', 'hooks', r)).toBe('amp: hooks not supported');
  });

  it('formats too_old message with version', () => {
    const r = supports('codex', 'hooks', '0.115.0');
    expect(explainSkip('codex', 'hooks', r, '0.115.0'))
      .toBe('codex@0.115.0: hooks requires >= 0.116.0');
  });

  it('returns empty string when ok', () => {
    expect(explainSkip('claude', 'hooks', { ok: true })).toBe('');
  });
});

describe('grok workflows version gate', () => {
  it('gates versions below 0.2.111 as too_old', () => {
    const result = supports('grok', 'workflows', '0.2.110');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('too_old');
      expect(result.need).toBe('>= 0.2.111');
    }
  });

  it('passes 0.2.111 and above', () => {
    expect(supports('grok', 'workflows', '0.2.111')).toEqual({ ok: true });
    expect(supports('grok', 'workflows', '0.2.120')).toEqual({ ok: true });
  });

});
