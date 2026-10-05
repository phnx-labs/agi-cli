
export interface ResourceChecker {
  readonly type: string;

  listNames(cwd: string): string[];

  build(name: string, cwd: string): unknown | null;

  isFresh(name: string, stored: unknown, cwd: string): boolean;
}

export interface TypedResourceChecker<TEntry> extends ResourceChecker {
  build(name: string, cwd: string): TEntry | null;
  isFresh(name: string, stored: TEntry, cwd: string): boolean;
}
