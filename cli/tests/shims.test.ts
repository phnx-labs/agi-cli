import { describe, test, expect } from 'vitest';
import { generateShimScript, generateVersionedAliasScript } from '../src/lib/installations/shims.js';

describe('codex shim launch flags', () => {
  test('injects update-check disable flag into the codex shim', () => {
    const script = generateShimScript('codex');
    expect(script).toContain("'check_for_update_on_startup=false'");
  });

  test('injects update-check disable flag into codex versioned aliases', () => {
    const script = generateVersionedAliasScript('codex', '0.116.0');
    expect(script).toContain("'check_for_update_on_startup=false'");
  });

  test('does not add the codex-only flag to other shims', () => {
    const claudeScript = generateShimScript('claude');
    const cursorScript = generateShimScript('cursor');
    expect(claudeScript).not.toContain('check_for_update_on_startup=false');
    expect(cursorScript).not.toContain('check_for_update_on_startup=false');
  });
});

describe('shims - generateShimScript', () => {
  test('reads agents.yaml not meta.yaml', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('agents.yaml');
    expect(script).not.toContain('meta.yaml');
  });

  test('parses flat agents format', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('^agents:');
    expect(script).not.toContain('^versions:');
    expect(script).not.toContain('default:');
  });

  test('includes agent name and CLI command', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('AGENT="claude"');
    expect(script).toContain('CLI_COMMAND="claude"');
    expect(script).toContain('#!/bin/bash');
  });

  test('generates correct script for codex agent', () => {
    const script = generateShimScript('codex');
    expect(script).toContain('AGENT="codex"');
    expect(script).toContain('agents.yaml');
    expect(script).not.toContain('meta.yaml');
  });

  test('does not include foreground project sync in shim', () => {
    const script = generateShimScript('claude');
    expect(script).not.toContain('find_project_agents_dir');
    expect(script).not.toMatch(/"\$AGENTS_BIN" sync\b(?![^\n]*--launch)/);
  });

  test('non-@-capable agents do not refresh rules on the launch hot path', () => {
    const script = generateShimScript('codex');
    expect(script).not.toContain('"$AGENTS_BIN" refresh-rules --agent "$AGENT"');
  });

  test('shim does not use --version flag, which collides with the top-level CLI version flag', () => {
    for (const agent of ['claude', 'codex', 'cursor', 'opencode', 'openclaw'] as const) {
      const script = generateShimScript(agent);
      expect(script, `${agent} shim must not pass --version to subcommands`).not.toMatch(/--version[ =]"?\$VERSION/);
    }
  });

  test('@-capable agents do NOT get a refresh-rules shim hook', () => {
    const claudeScript = generateShimScript('claude');
    expect(claudeScript).not.toContain('refresh-rules');
    const grokScript = generateShimScript('grok');
    expect(grokScript).not.toContain('refresh-rules');
  });

  test('scopes Claude keychain auth to the selected version config dir', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('export CLAUDE_CONFIG_DIR="$VERSION_DIR/home/.claude"');
  });

  test('does not inject Claude keychain scoping for non-Claude agents', () => {
    const script = generateShimScript('codex');
    expect(script).not.toContain('CLAUDE_CONFIG_DIR');
  });
});

describe('shims - generateVersionedAliasScript', () => {
  test('scopes Claude version aliases to their config dir', () => {
    const script = generateVersionedAliasScript('claude', '2.1.110');
    expect(script).toContain('VERSION_DIR="$AGENTS_REAL_HOME/.agents/.history/versions/claude/2.1.110"');
    expect(script).toContain('export CLAUDE_CONFIG_DIR="$VERSION_DIR/home/.claude"');
  });

  test('does not inject Claude keychain scoping for non-Claude aliases', () => {
    const script = generateVersionedAliasScript('codex', '0.98.0');
    expect(script).not.toContain('CLAUDE_CONFIG_DIR');
  });
});
