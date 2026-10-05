import type { AgentId } from '../../types.js';


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
