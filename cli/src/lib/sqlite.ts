
import { createRequire } from 'module';

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
const require = createRequire(import.meta.url);

function loadNodeSqlite(): unknown {
  const original = process.emitWarning;
  const filtered = ((warning: string | Error, ...rest: unknown[]): void => {
    const name = warning instanceof Error
      ? warning.name
      : typeof rest[0] === 'string'
        ? rest[0]
        : (rest[0] as { type?: string } | undefined)?.type;
    const message = warning instanceof Error ? warning.message : warning;
    if (name === 'ExperimentalWarning' && /SQLite/i.test(String(message ?? ''))) return;
    (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  process.emitWarning = filtered;
  try {
    return require('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
}

const BUN_SQLITE = 'bun:sqlite';
const sqliteMod = isBun
  ? (require as (id: string) => unknown)(BUN_SQLITE)
  : loadNodeSqlite();

const NativeDatabase: new (filename: string, options?: { strict: boolean }) => NativeDb =
  (sqliteMod as { Database?: unknown; DatabaseSync?: unknown }).Database as never
  ?? (sqliteMod as { DatabaseSync?: unknown }).DatabaseSync as never;

const NATIVE_ARGS: [] | [{ strict: boolean }] = isBun ? [{ strict: true }] : [];

interface NativeStmt {
  run(...args: unknown[]): RunResult;
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}

interface NativeDb {
  prepare(sql: string): NativeStmt;
  exec(sql: string): void;
  close(): void;
}

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

function bindArgs(params: unknown[]): unknown[] {
  if (
    params.length === 1 &&
    params[0] !== null &&
    typeof params[0] === 'object' &&
    !Array.isArray(params[0])
  ) {
    return [params[0]];
  }
  return params;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
class StatementImpl<_T = unknown> {
  constructor(private readonly inner: NativeStmt) {}

  run(...params: unknown[]): RunResult {
    return this.inner.run(...bindArgs(params));
  }

  get(...params: unknown[]): unknown {
    return this.inner.get(...bindArgs(params));
  }

  all(...params: unknown[]): unknown[] {
    return this.inner.all(...bindArgs(params));
  }
}

class Database {
  private readonly inner: NativeDb;

  constructor(filename: string) {
    this.inner = new NativeDatabase(filename, ...NATIVE_ARGS);
  }

  prepare<T = unknown>(sql: string): StatementImpl<T> {
    return new StatementImpl<T>(this.inner.prepare(sql));
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  pragma(stmt: string): void {
    this.inner.exec(`PRAGMA ${stmt}`);
  }

  transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
    return (...args: Args): R => {
      this.inner.exec('BEGIN IMMEDIATE');
      try {
        const result = fn(...args);
        this.inner.exec('COMMIT');
        return result;
      } catch (err) {
        try { this.inner.exec('ROLLBACK'); } catch {  }
        throw err;
      }
    };
  }

  close(): void {
    this.inner.close();
  }
}

// eslint-disable-next-line @typescript-eslint/no-namespace
namespace Database {
  export type Database = InstanceType<typeof DatabaseConstructor>;
  export type Statement<T = unknown> = StatementImpl<T>;
}

const DatabaseConstructor = Database;

export default Database;
