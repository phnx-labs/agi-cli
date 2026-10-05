import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bunCachePath, type CiLayout } from './paths';

export type CacheMode = 'read-write' | 'restore-only';

export interface CacheOpen {
  layout: CiLayout;
  lockfileDigest: string;
  mode: CacheMode;
}

/** Content-addressed Bun cache: fork (restore-only) clients may read a completed digest and never
 * write; trusted same-repo jobs populate it by atomic rename after a successful install. */
export class ForkSafeCache {
  constructor(private readonly opts: CacheOpen) {
    if (!/^[0-9a-f]{8,128}$/.test(opts.lockfileDigest)) {
      throw new Error(`lockfile digest is not a hex content address: ${opts.lockfileDigest}`);
    }
  }

  path(): string {
    return bunCachePath(this.opts.layout, this.opts.lockfileDigest);
  }

  exists(): boolean {
    return existsSync(join(this.path(), '.ready'));
  }

  restore(): string {
    if (!this.exists()) {
      throw new Error(`cache miss for ${this.opts.lockfileDigest}`);
    }
    return this.path();
  }

  populate(files: Record<string, string>): string {
    if (this.opts.mode === 'restore-only') {
      throw new Error('restore-only cache must not write trusted cache contents');
    }
    const dest = this.path();
    const staging = `${dest}.staging-${process.pid}-${Date.now()}`;
    mkdirSync(staging, { recursive: true });
    try {
      for (const [rel, body] of Object.entries(files)) {
        if (rel.includes('..') || rel.startsWith('/')) {
          throw new Error(`cache populate refused unsafe path ${rel}`);
        }
        const target = join(staging, rel);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, body);
      }
      writeFileSync(join(staging, '.ready'), `${this.opts.lockfileDigest}\n`);
      mkdirSync(dirname(dest), { recursive: true });
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      renameSync(staging, dest);
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      throw err;
    }
    return dest;
  }

  readReadyMarker(): string {
    return readFileSync(join(this.path(), '.ready'), 'utf8').trim();
  }
}
