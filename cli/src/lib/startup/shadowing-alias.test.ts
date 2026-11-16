import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { findShadowingDefinition, shadowFixCommand } from './shadowing-alias.js';

const HOME = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata', 'shadowing-home');

describe('findShadowingDefinition', () => {
  it('finds the live zsh alias past a commented copy and a look-alike name', () => {
    const def = findShadowingDefinition('browser', HOME);
    expect(def).toEqual({ kind: 'alias', file: '.zshrc', line: 8, fish: false });
    expect(shadowFixCommand('browser', def!)).toBe('unalias browser');
  });

  it('finds a bash function whose body calls agents <group>', () => {
    const def = findShadowingDefinition('computer', HOME);
    expect(def).toEqual({ kind: 'function', file: '.bashrc', line: 3, fish: false });
    expect(shadowFixCommand('computer', def!)).toBe('unset -f computer');
  });

  it('finds a fish alias and gives the fish removal command', () => {
    const def = findShadowingDefinition('secrets', HOME);
    expect(def).toEqual({ kind: 'alias', file: '.config/fish/config.fish', line: 2, fish: true });
    expect(shadowFixCommand('secrets', def!)).toBe('functions --erase secrets');
  });

  it('ignores an alias that does not route through agents', () => {
    expect(findShadowingDefinition('sessions', HOME)).toBeUndefined();
  });
});
