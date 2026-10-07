import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOwnerNotifyApi, type OwnerNotifyApi } from '../testdata/owner-notify-api.js';

const HUMANS = `version: 1
owner:
  timezone: America/Los_Angeles
  quiet_hours: "22:00-7:30"
  channels:
    - id: phone
      transport: imessage
      to: "+15555550123"
    - id: work
      transport: slack
      to: U123
    - id: tg
      transport: openclaw-telegram
      to: chat-1
  policy:
    critical: [phone, work]
    normal: [work]
    low: []
`;

// The rush/api base is read at import, so the migration module loads after the fixture is up.
let api: OwnerNotifyApi;
let migrate: typeof import('./migrate.js');
let identity: typeof import('../identity/client.js');

beforeAll(async () => {
  api = await startOwnerNotifyApi();
  vi.resetModules();
  process.env.RUSH_PROXY_BASE = api.url;
  migrate = await import('./migrate.js');
  identity = await import('../identity/client.js');
});

afterAll(async () => {
  await api.close();
});

describe('humansToPreferencesPatch', () => {
  it('maps severity policy onto events, the iMessage handle onto a destination, and quiet hours onto settings', () => {
    const { patch, dropped } = migrate.humansToPreferencesPatch(yaml.parse(HUMANS));
    const enabled = (event: string) => patch.preferences!.filter((p) => p.event === event && p.enabled).map((p) => p.channel).sort();
    expect(enabled('needs_you')).toEqual(['imessage', 'slack']);
    expect(enabled('failed')).toEqual(['slack']);
    expect(enabled('message')).toEqual(['slack']);
    expect(enabled('completed')).toEqual([]);
    expect(patch.settings).toEqual({ timezone: 'America/Los_Angeles', quietStart: '22:00', quietEnd: '07:30' });
    expect(patch.destinations).toEqual({ imessage: { address: '+15555550123' } });
    expect(dropped).toEqual(['tg (openclaw-telegram)']);
  });
});

describe('migrateHumansToAccount — one-shot upload of humans.yaml', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'humans-migrate-'));
    execFileSync('git', ['init', '-q', userDir]);
    execFileSync('git', ['-C', userDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    fs.writeFileSync(path.join(userDir, 'humans.yaml'), HUMANS);
    execFileSync('git', ['-C', userDir, 'add', 'humans.yaml']);
    execFileSync('git', ['-C', userDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'humans']);
    api.requests.length = 0;
    api.preferencesStatus = 200;
  });

  afterEach(() => {
    identity.clearSession();
    fs.rmSync(userDir, { recursive: true, force: true });
  });

  it('signed in: PUTs the settings to /me/preferences, moves the file to trash, and commits the removal', async () => {
    identity.writeSession({ access_token: api.sessionToken });
    expect(await migrate.migrateHumansToAccount(userDir)).toBe('migrated');
    const put = api.requests.find((r) => r.method === 'PUT' && r.path === '/me/preferences');
    expect(put?.bearer).toBe(api.sessionToken);
    expect(put?.body).toMatchObject({ destinations: { imessage: { address: '+15555550123' } }, settings: { timezone: 'America/Los_Angeles' } });
    expect(fs.existsSync(path.join(userDir, 'humans.yaml'))).toBe(false);
    expect(execFileSync('git', ['-C', userDir, 'ls-files', 'humans.yaml'], { encoding: 'utf-8' })).toBe('');
    expect(execFileSync('git', ['-C', userDir, 'status', '--porcelain', '--', 'humans.yaml'], { encoding: 'utf-8' })).toBe('');
  });

  it('signed out: leaves the file and reports pending so the next run retries', async () => {
    expect(await migrate.migrateHumansToAccount(userDir)).toBe('pending');
    expect(fs.existsSync(path.join(userDir, 'humans.yaml'))).toBe(true);
    expect(api.requests).toEqual([]);
  });

  it('a rejected upload keeps the file and stays pending', async () => {
    identity.writeSession({ access_token: api.sessionToken });
    api.preferencesStatus = 400;
    expect(await migrate.migrateHumansToAccount(userDir)).toBe('pending');
    expect(fs.existsSync(path.join(userDir, 'humans.yaml'))).toBe(true);
  });
});
