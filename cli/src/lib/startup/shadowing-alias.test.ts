import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { findShadowingDefinition, shadowFixCommand } from './shadowing-alias.js';

const HOME = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata', 'shadowing-home');

describe('findShadowingDefinition', () => {
  it('finds the zsh alias past look-alike names and targets', () => {
    const def = findShadowingDefinition('browser', HOME);
    expect(def).toEqual({ kind: 'alias', file: '.zshrc', line: 7, fish: false });
    expect(shadowFixCommand('browser', def!)).toBe('unalias browser');
  });

  it('finds a multi-line bash function whose body calls agents <group>', () => {
    const def = findShadowingDefinition('computer', HOME);
    expect(def).toEqual({ kind: 'function', file: '.bashrc', line: 6, fish: false });
    expect(shadowFixCommand('computer', def!)).toBe('unset -f computer');
  });

  it('reads past a nested fish block to the agents call and gives the fish removal', () => {
    const def = findShadowingDefinition('secrets', HOME);
    expect(def).toEqual({ kind: 'function', file: '.config/fish/config.fish', line: 2, fish: true });
    expect(shadowFixCommand('secrets', def!)).toBe('functions --erase secrets');
  });

  it('finds a zsh global alias', () => {
    expect(findShadowingDefinition('sessions', HOME)).toEqual({ kind: 'alias', file: '.zprofile', line: 2, fish: false });
  });

  it('ignores an alias to another group and a one-line function that does not call agents', () => {
    expect(findShadowingDefinition('browserx', HOME)).toBeUndefined();
  });
});
