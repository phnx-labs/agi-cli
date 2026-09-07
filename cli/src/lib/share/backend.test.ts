import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PhoenixSession } from '../identity/client.js';
import { PHOENIX_ID_BASE, writeSession, clearSession, sessionFilePath } from '../identity/client.js';
import { writeShareConfig, DEFAULT_SHARE_DOMAIN } from './config.js';
import {
  resolveShareBackend,
  shouldUseManaged,
  sanitizeShareNamespace,
  handleFromEmail,
  managedShareHandle,
  managedShareBaseUrl,
  isManagedShareEndpoint,
  phoenixIdBaseForDeploy,
  SHARE_BACKEND_ENV,
} from './backend.js';

const ALICE: PhoenixSession = {
  access_token: 'pid_alice_token',
  userId: 'alice-user-1',
  email: 'alice@example.com',
};

describe('ShareBackend chooser (RUSH-3135)', () => {
  const prevBackendEnv = process.env[SHARE_BACKEND_ENV];
  const prevShareToken = process.env.SHARE_WRITE_TOKEN;

  beforeEach(() => {
    const home = process.env.HOME ?? os.homedir();
    fs.rmSync(path.join(home, '.agents'), { recursive: true, force: true });
    const session = sessionFilePath();
    fs.rmSync(path.dirname(session), { recursive: true, force: true });
    delete process.env[SHARE_BACKEND_ENV];
    delete process.env.SHARE_WRITE_TOKEN;
    clearSession();
  });

  afterEach(() => {
    clearSession();
    if (prevBackendEnv === undefined) delete process.env[SHARE_BACKEND_ENV];
    else process.env[SHARE_BACKEND_ENV] = prevBackendEnv;
    if (prevShareToken === undefined) delete process.env.SHARE_WRITE_TOKEN;
    else process.env.SHARE_WRITE_TOKEN = prevShareToken;
  });

  it('isManagedShareEndpoint is the deploy seam: hostname, not signed-in state', () => {
    expect(isManagedShareEndpoint({ baseUrl: managedShareBaseUrl() })).toBe(true);
    expect(isManagedShareEndpoint({ domain: DEFAULT_SHARE_DOMAIN })).toBe(true);
    expect(isManagedShareEndpoint({ baseUrl: 'https://share.agents-cli.sh/' })).toBe(true);
    expect(isManagedShareEndpoint({ baseUrl: 'https://share.test', domain: DEFAULT_SHARE_DOMAIN })).toBe(true);
    expect(isManagedShareEndpoint({ baseUrl: 'https://share.test' })).toBe(false);
    expect(isManagedShareEndpoint({ baseUrl: 'https://agents-share.acct.workers.dev' })).toBe(false);
    expect(isManagedShareEndpoint({ domain: 'share.example.com' })).toBe(false);
  });

  it('phoenixIdBaseForDeploy returns the CLI Phoenix ID base for a managed endpoint, nothing for BYO', () => {
    expect(phoenixIdBaseForDeploy({}, { baseUrl: 'https://share.test' })).toBeUndefined();
    expect(phoenixIdBaseForDeploy({ managed: false }, { baseUrl: 'https://share.test' })).toBeUndefined();
    expect(phoenixIdBaseForDeploy({}, { baseUrl: managedShareBaseUrl() })).toBe(PHOENIX_ID_BASE.replace(/\/+$/, ''));
    expect(phoenixIdBaseForDeploy({ managed: true }, { baseUrl: 'https://share.test' })).toBe(
      PHOENIX_ID_BASE.replace(/\/+$/, ''),
    );
  });

  it('sanitizeShareNamespace matches the Worker: lowercase, [a-z0-9-]+', () => {
    expect(sanitizeShareNamespace('Alice_User-1')).toBe('alice-user-1');
    expect(sanitizeShareNamespace('550e8400-e29b-41d4-a716-446655440000')).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    );
  });

  it('handleFromEmail is the email local-part, plus-tag stripped (RUSH-3224)', () => {
    expect(handleFromEmail('muqsitnawaz@gmail.com')).toBe('muqsitnawaz');
    expect(handleFromEmail('muqsitnawaz+dev@gmail.com')).toBe('muqsitnawaz');
    expect(handleFromEmail('Alice.User@example.com')).toBe('alice-user');
    expect(handleFromEmail(undefined)).toBe('');
    expect(handleFromEmail('')).toBe('');
  });

  it('managedShareHandle prefers the email handle over the userId UUID', () => {
    expect(managedShareHandle({ email: 'muqsitnawaz@gmail.com', userId: '7b28a4b7-1fb0-4abe-948d-32daf2ff7298' })).toBe(
      'muqsitnawaz',
    );
    expect(managedShareHandle({ userId: 'alice-user-1' })).toBe('alice-user-1');
  });

  it('signed-in with no BYO override selects the managed endpoint and Phoenix token', () => {
    writeSession(ALICE);
    expect(shouldUseManaged()).toBe(true);
    const backend = resolveShareBackend();
    expect(backend.kind).toBe('managed');
    expect(backend.token).toBe('pid_alice_token');
    expect(backend.baseUrl).toBe(`https://${DEFAULT_SHARE_DOMAIN}`);
    expect(backend.baseUrl).toBe(managedShareBaseUrl());
    expect(backend.namespace).toBe('alice');
  });

  it('signed-in via opts.session (DI) also selects managed', () => {
    expect(shouldUseManaged({ session: ALICE })).toBe(true);
    const backend = resolveShareBackend({ session: ALICE });
    expect(backend.kind).toBe('managed');
    expect(backend.token).toBe(ALICE.access_token);
  });

  it('an explicit writeToken is a BYO override even when signed in', () => {
    writeSession(ALICE);
    writeShareConfig({
      baseUrl: 'https://byo.example',
      accountId: 'acct',
      workerName: 'w',
      bucketName: 'b',
    });
    expect(shouldUseManaged({ writeToken: 'static-token' })).toBe(false);
    const backend = resolveShareBackend({ writeToken: 'static-token', githubUser: 'octocat' });
    expect(backend.kind).toBe('byo');
    expect(backend.token).toBe('static-token');
    expect(backend.baseUrl).toBe('https://byo.example');
    expect(backend.namespace).toBe('octocat');
  });

  it(`${SHARE_BACKEND_ENV}=byo forces BYO while signed in`, () => {
    writeSession(ALICE);
    writeShareConfig({
      baseUrl: 'https://byo.example',
      accountId: 'acct',
      workerName: 'w',
      bucketName: 'b',
    });
    // readWriteToken() checks SHARE_WRITE_TOKEN first, so seed the token via the
    // env rail — storeWriteToken now round-trips through the standalone `secrets`
    // process client (PHNX-3989), which this suite has no binary for. The test
    // asserts backend KIND (byo, forced by the env below) and that token value.
    process.env.SHARE_WRITE_TOKEN = 'bundle-token';
    process.env[SHARE_BACKEND_ENV] = 'byo';
    expect(shouldUseManaged()).toBe(false);
    const backend = resolveShareBackend({ githubUser: 'octocat' });
    expect(backend.kind).toBe('byo');
    expect(backend.token).toBe('bundle-token');
  });

  it('opts.byo forces BYO while signed in', () => {
    writeSession(ALICE);
    writeShareConfig({
      baseUrl: 'https://byo.example',
      accountId: 'acct',
      workerName: 'w',
      bucketName: 'b',
    });
    const backend = resolveShareBackend({ byo: true, writeToken: 'tok', githubUser: 'octocat' });
    expect(backend.kind).toBe('byo');
  });

  it('signed out with BYO config selects BYO', () => {
    writeShareConfig({
      baseUrl: 'https://byo.example/',
      accountId: 'acct',
      workerName: 'w',
      bucketName: 'b',
    });
    expect(shouldUseManaged({ session: null })).toBe(false);
    const backend = resolveShareBackend({
      session: null,
      writeToken: 'tok',
      githubUser: 'octocat',
    });
    expect(backend.kind).toBe('byo');
    expect(backend.baseUrl).toBe('https://byo.example');
    expect(backend.namespace).toBe('octocat');
  });

  it('signed out with no BYO config fails loud naming both doors', () => {
    expect(() => resolveShareBackend({ session: null })).toThrow(/agents auth login/);
    expect(() => resolveShareBackend({ session: null })).toThrow(/artifacts setup/);
  });

  it('managed fails loud when the session has no userId', () => {
    expect(() =>
      resolveShareBackend({ session: { access_token: 'pid_x' } }),
    ).toThrow(/no email or user id/);
  });

  it('requireToken:false lets BYO list/status resolve without a WRITE_TOKEN', () => {
    writeShareConfig({
      baseUrl: 'https://byo.example',
      accountId: 'acct',
      workerName: 'w',
      bucketName: 'b',
    });
    const backend = resolveShareBackend({
      session: null,
      requireToken: false,
      githubUser: 'octocat',
    });
    expect(backend.kind).toBe('byo');
    expect(backend.token).toBe('');
    expect(backend.baseUrl).toBe('https://byo.example');
    expect(backend.namespace).toBe('octocat');
  });
});
