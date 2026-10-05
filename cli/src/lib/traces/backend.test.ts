import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeSession, clearSession, sessionFilePath } from '../identity/client.js';
import { resolveTracesBackend, DEFAULT_TRACES_DOMAIN } from './backend.js';


const BASE_ENV = process.env.AGENTS_TRACES_BASE_URL;
const TOKEN_ENV = process.env.AGENTS_TRACES_WRITE_TOKEN;

function restore(key: string, prev: string | undefined) {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

describe('resolveTracesBackend — shared managed-vs-BYO selection', () => {
  beforeEach(() => {
    const dir = path.dirname(sessionFilePath());
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.AGENTS_TRACES_BASE_URL;
    delete process.env.AGENTS_TRACES_WRITE_TOKEN;
  });
  afterEach(() => {
    clearSession();
    restore('AGENTS_TRACES_BASE_URL', BASE_ENV);
    restore('AGENTS_TRACES_WRITE_TOKEN', TOKEN_ENV);
  });

  it('managed for a signed-in session — the platform Worker + userId namespace', () => {
    writeSession({ access_token: 'pid_token', userId: 'user-1', email: 'dev@example.com' });
    const backend = resolveTracesBackend();
    expect(backend.baseUrl).toBe(`https://${DEFAULT_TRACES_DOMAIN}`);
    expect(backend.token).toBe('pid_token');
    expect(backend.userId).toBe('user-1');
  });

  it('BYO env pair overrides even when signed in', () => {
    writeSession({ access_token: 'pid_token', userId: 'user-1', email: 'dev@example.com' });
    process.env.AGENTS_TRACES_BASE_URL = 'https://traces.self-hosted.example/';
    process.env.AGENTS_TRACES_WRITE_TOKEN = 'byo-token';
    const backend = resolveTracesBackend();
    expect(backend.baseUrl).toBe('https://traces.self-hosted.example');
    expect(backend.token).toBe('byo-token');
    expect(backend.userId).toBe('byo');
  });

  it('fails loud when signed out with no BYO env', () => {
    clearSession();
    expect(() => resolveTracesBackend()).toThrow(/Not signed in.*agents auth login/);
  });

  it('a partial BYO env (base only, no token) is not a BYO override — falls to the login hint', () => {
    clearSession();
    process.env.AGENTS_TRACES_BASE_URL = 'https://traces.self-hosted.example';
    expect(() => resolveTracesBackend()).toThrow(/Not signed in/);
  });
});
