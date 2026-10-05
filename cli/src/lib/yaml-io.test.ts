import { describe, it, expect } from 'vitest';
import * as yaml from 'yaml';
import { stringifyDoc } from './yaml-io.js';

// All agents.yaml writers share this fixed-point serializer: normalize legacy flow roots and empty maps once, while preserving committed flow sequences.
describe('stringifyDoc', () => {
  it('preserves committed flow sequences byte-identically', () => {
    const src =
      'hooks:\n  notify-owner:\n    command: [agents, notify, "{message}"]\n    agents: [claude, codex]\n    events: [Stop]\n';
    expect(stringifyDoc(yaml.parseDocument(src))).toBe(src);
  });

  it('never emits the padded flow form that started the drift', () => {
    const src = 'command: [agents, notify, "{message}"]\n';
    expect(stringifyDoc(yaml.parseDocument(src))).not.toMatch(/\[ | \]/);
    expect(String(yaml.parseDocument(src))).toMatch(/\[ /);
  });

  it('is a fixed point — writing twice changes nothing the second time', () => {
    const src = 'registries:\n  mcp:\n    {}\n  skill:\n    a:\n      url: x\n';
    const once = stringifyDoc(yaml.parseDocument(src));
    const twice = stringifyDoc(yaml.parseDocument(once));
    expect(twice).toBe(once);
  });

  it('normalizes a legacy empty map exactly once', () => {
    const legacy = 'registries:\n  mcp:\n    {}\n';
    expect(stringifyDoc(yaml.parseDocument(legacy))).toBe('registries:\n  mcp: {}\n');
    expect(stringifyDoc(yaml.parseDocument('registries:\n  mcp: {}\n'))).toBe(
      'registries:\n  mcp: {}\n',
    );
  });

  it('gives every agents.yaml writer the same bytes', () => {
    const src = 'registries:\n  mcp: {}\n  skill:\n    a:\n      url: x\n';
    const doc = () => yaml.parseDocument(src);
    expect(stringifyDoc(doc())).toBe(stringifyDoc(doc()));
    expect(stringifyDoc(doc())).toBe(src);
  });

  it('keeps comments and key order when a key is edited', () => {
    const doc = yaml.parseDocument('# keep me\na: [1, 2]\nb: 3\n');
    doc.set('b', 4);
    expect(stringifyDoc(doc)).toBe('# keep me\na: [1, 2]\nb: 4\n');
  });

  it('still lets a caller override when it has a reason to', () => {
    const doc = yaml.parseDocument('a: [1, 2]\n');
    expect(stringifyDoc(doc, { collectionStyle: 'block' })).toBe('a:\n  - 1\n  - 2\n');
  });
  it('normalizes a legacy FLOW ROOT to block, the case state.ts guarded', () => {
    const doc = yaml.parseDocument('{a: 1}\n');
    doc.set('disabledCommands', ['teams']);
    expect(stringifyDoc(doc)).toBe('a: 1\ndisabledCommands:\n  - teams\n');
  });

  it('does NOT flatten a committed flow sequence under a block root', () => {
    const doc = yaml.parseDocument('a: 1\nb: [1, 2]\n');
    doc.set('a', 2);
    expect(stringifyDoc(doc)).toBe('a: 2\nb: [1, 2]\n');
  });
});
