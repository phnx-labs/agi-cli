import type { McpRegistryResponse, McpServerEntry, RegistryConfig } from './types.js';
import { DEFAULT_REGISTRIES } from './types.js';
import { readMeta } from './state.js';

function enabledMcpRegistries(): Array<{ name: string; config: RegistryConfig }> {
  const registries = { ...DEFAULT_REGISTRIES.mcp, ...readMeta().registries?.mcp };
  return Object.entries(registries)
    .filter(([, config]) => config.enabled)
    .map(([name, config]) => ({ name, config }));
}

const REGISTRY_FETCH_TIMEOUT_MS = 8000;

async function fetchMcpRegistry(
  url: string,
  query?: string,
  limit: number = 20,
  apiKey?: string
): Promise<McpRegistryResponse> {
  const params = new URLSearchParams();
  if (query) params.set('search', query);
  params.set('limit', String(limit));

  const fullUrl = `${url}/servers?${params}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const response = await fetch(fullUrl, {
    headers,
    signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Registry request failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<McpRegistryResponse>;
}

export function mcpEntryToInstallSpec(
  entry: McpServerEntry
): { command?: string; url?: string; transport: 'stdio' | 'http' } | null {
  const pkg = entry.packages?.[0];
  if (!pkg) return null;

  if (pkg.transport === 'sse' || pkg.transport === 'streamable-http') {
    return null;
  }

  const reg = pkg.registry_name?.toLowerCase();
  const runtime = pkg.runtime;
  const name = pkg.name;

  if (!name) return null;

  if (reg === 'npm' || runtime === 'node') {
    return { command: `npx -y ${name}`, transport: 'stdio' };
  }
  if (reg === 'pypi' || runtime === 'python') {
    return { command: `uvx ${name}`, transport: 'stdio' };
  }
  if (runtime === 'docker') {
    return { command: `docker run --rm -i ${name}`, transport: 'stdio' };
  }
  if (runtime === 'binary') {
    return { command: name, transport: 'stdio' };
  }
  return { command: name, transport: 'stdio' };
}

export async function getMcpServerInfo(serverName: string): Promise<McpServerEntry | null> {
  for (const { config } of enabledMcpRegistries()) {
    try {
      const response = await fetchMcpRegistry(config.url, serverName, 10, config.apiKey);

      const match = response.servers.find(
        ({ server }) =>
          server.name === serverName ||
          server.name.endsWith(`/${serverName}`)
      );

      if (match) {
        return match.server;
      }
    } catch {
    }
  }

  return null;
}
