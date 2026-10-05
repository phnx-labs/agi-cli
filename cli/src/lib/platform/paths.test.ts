import { describe, it, expect } from 'vitest';
import * as os from 'os';
import { looksLikePath, toComparablePath, homeDir, isWindowsAbsolutePath, toPosix, toPortableKey } from './paths.js';

describe('looksLikePath', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    it(`recognizes POSIX path markers on ${platform}`, () => {
      for (const q of ['.', './x', '../x', '/abs/path', '~', '~/x']) {
        expect(looksLikePath(q, platform)).toBe(true);
      }
    });
    it(`treats plain words as search terms on ${platform}`, () => {
      for (const q of ['claude', 'fix auth', 'RUSH-123', '']) {
        expect(looksLikePath(q, platform)).toBe(false);
      }
    });
  }

  it('recognizes Windows drive-letter and UNC paths ONLY on win32', () => {
    for (const q of ['C:\\repo', 'c:/repo', 'D:\\a\\b', '\\\\server\\share', '.\\rel', '..\\rel']) {
      expect(looksLikePath(q, 'win32')).toBe(true);
      expect(looksLikePath(q, 'darwin')).toBe(false);
      expect(looksLikePath(q, 'linux')).toBe(false);
    }
  });
});

describe('toComparablePath', () => {
  it('is identity on POSIX (no behavior change)', () => {
    expect(toComparablePath('/Users/Me/Repo', 'darwin')).toBe('/Users/Me/Repo');
    expect(toComparablePath('src/Foo.ts', 'linux')).toBe('src/Foo.ts');
  });
  it('folds separators and lowercases on win32 (case-insensitive FS)', () => {
    expect(toComparablePath('C:\\Users\\Me\\Repo', 'win32')).toBe('c:/users/me/repo');
    expect(toComparablePath('src\\Foo.ts', 'win32')).toBe('src/foo.ts');
  });
});

describe('homeDir', () => {
  it('matches os.homedir()', () => {
    expect(homeDir()).toBe(os.homedir());
  });
});

describe('isWindowsAbsolutePath', () => {
  it('recognizes drive-letter and UNC roots', () => {
    for (const p of ['C:\\repo', 'c:/repo', 'D:\\a\\b', '\\\\server\\share']) {
      expect(isWindowsAbsolutePath(p)).toBe(true);
    }
  });
  it('rejects POSIX paths and bare names', () => {
    for (const p of ['/abs/path', './rel', '~/x', 'owner/repo', 'plugin-name', '']) {
      expect(isWindowsAbsolutePath(p)).toBe(false);
    }
  });
});

describe('toPosix', () => {
  it('folds backslashes to forward slashes', () => {
    expect(toPosix('C:\\Users\\Me\\repo')).toBe('C:/Users/Me/repo');
    expect(toPosix('a\\b\\c')).toBe('a/b/c');
  });
  it('leaves POSIX paths unchanged', () => {
    expect(toPosix('/Users/Me/repo')).toBe('/Users/Me/repo');
    expect(toPosix('a/b/c')).toBe('a/b/c');
  });
});

describe('toPortableKey', () => {
  it('produces the historical POSIX slug unchanged (no regression of on-disk keys)', () => {
    expect(toPortableKey('/home/user/repo')).toBe('_home_user_repo');
    expect(toPortableKey('/home/user/my repo')).toBe('_home_user_my_repo');
  });
  it('drops the Windows drive colon and folds separators (NTFS-safe)', () => {
    expect(toPortableKey('C:\\Users\\me\\repo')).toBe('C_Users_me_repo');
    expect(toPortableKey('D:\\a\\b c')).toBe('D_a_b_c');
  });
});
