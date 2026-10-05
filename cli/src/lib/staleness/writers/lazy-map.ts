/** Lazy-built per-agent map. The writer/detector modules form an import cycle with agents.ts
 * (agents.ts, versions.ts, staleness/registry.ts, writers/<kind>.ts); iterating AGENTS at module
 * top level fires before it is initialized. */
import type { AgentId } from '../../types.js';

// Lazy access breaks the AGENTS → versions → staleness writers module-initialization cycle.
export function lazyAgentMap<T>(
  build: () => Partial<Record<AgentId, T>>
): Partial<Record<AgentId, T>> {
  let cache: Partial<Record<AgentId, T>> | null = null;
  const ensure = (): Partial<Record<AgentId, T>> => {
    if (!cache) cache = build();
    return cache;
  };
  return new Proxy({} as Partial<Record<AgentId, T>>, {
    get(_t, prop) { return ensure()[prop as AgentId]; },
    has(_t, prop) { return prop in ensure(); },
    ownKeys() { return Reflect.ownKeys(ensure()); },
    getOwnPropertyDescriptor(_t, prop) {
      const m = ensure();
      if (prop in m) return { configurable: true, enumerable: true, value: m[prop as AgentId] };
      return undefined;
    },
  });
}
