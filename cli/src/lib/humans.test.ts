import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-humans-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {  }
  }
});

const tsxBin = path.resolve('node_modules/.bin/tsx');
const humansModuleUrl = pathToFileURL(path.resolve('src/lib/humans.ts')).href;

function runHumans(home: string, expression: string): unknown {
  const child = spawnSync(
    tsxBin,
    ['-e', `
      import * as humans from ${JSON.stringify(humansModuleUrl)};
      const result = ${expression};
      if (result && typeof result.then === 'function') {
        result.then((r) => console.log(JSON.stringify(r)));
      } else {
        console.log(JSON.stringify(result));
      }
    `],
    { env: { ...process.env, HOME: home }, encoding: 'utf-8' },
  );
  if (child.status !== 0) {
    throw new Error(`humans helper failed: ${child.stderr || child.stdout}`);
  }
  const line = (child.stdout || '').trim().split('\n').filter(Boolean).pop() || 'null';
  return JSON.parse(line);
}

describe('humans.ts', () => {
  it('readHumans returns null when file is absent', () => {
    const home = makeTempHome();
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    const result = runHumans(home, 'humans.readHumans()');
    expect(result).toBeNull();
  });

  it('writeHumans / readHumans round-trips correctly', () => {
    const home = makeTempHome();
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });

    const config = JSON.stringify({
      version: 1,
      owner: {
        name: 'Test User',
        timezone: 'America/New_York',
        channels: [{ id: 'imessage', transport: 'rush', to: '+15551234567' }],
        policy: { normal: ['imessage'] },
      },
    });

    runHumans(home, `(humans.writeHumans(${config}), 'ok')`);
    const read = runHumans(home, 'humans.readHumans()') as Record<string, unknown> | null;
    expect(read?.['version']).toBe(1);
    const owner = read?.['owner'] as Record<string, unknown> | undefined;
    expect(owner?.['name']).toBe('Test User');
    const channels = owner?.['channels'] as Array<Record<string, unknown>> | undefined;
    expect(channels?.[0]?.['id']).toBe('imessage');
    expect(channels?.[0]?.['to']).toBe('+15551234567');
  });

  it('readHumans returns null for wrong version', () => {
    const home = makeTempHome();
    const agentsDir = path.join(home, '.agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'humans.yaml'), 'version: 2\nowner:\n  name: x\n', 'utf-8');

    const result = runHumans(home, 'humans.readHumans()');
    expect(result).toBeNull();
  });

  it('getOwnerNotifyFromHumans returns null when file is absent', () => {
    const home = makeTempHome();
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    const result = runHumans(home, 'humans.getOwnerNotifyFromHumans()');
    expect(result).toBeNull();
  });

  it('getOwnerNotifyFromHumans resolves the normal policy channel', () => {
    const home = makeTempHome();
    const agentsDir = path.join(home, '.agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'humans.yaml'), [
      'version: 1',
      'owner:',
      '  channels:',
      '    - id: call',
      '      transport: twilio',
      "      to: '+15550000001'",
      '    - id: imessage',
      '      transport: rush',
      "      to: '+15550000002'",
      '  policy:',
      '    normal: [imessage]',
      '',
    ].join('\n'));

    expect(runHumans(home, 'humans.getOwnerNotifyFromHumans()')).toEqual({
      channel: 'imessage',
      to: '+15550000002',
    });
  });

  it('falls back to the first addressable channel when every policy id is stale', () => {
    const home = makeTempHome();
    const agentsDir = path.join(home, '.agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'humans.yaml'), [
      'version: 1',
      'owner:',
      '  channels:',
      '    - id: imessage',
      '      transport: rush',
      "      to: '+15550000002'",
      '  policy:',
      '    normal: [removed-channel]',
      '',
    ].join('\n'));

    expect(runHumans(home, 'humans.getOwnerNotifyDestinationsFromHumans()')).toEqual([
      { channel: 'imessage', to: '+15550000002' },
    ]);
  });

  it('getOwnerNotifyFromHumans reads the owner.notify shape written by migration', () => {
    const home = makeTempHome();
    const agentsDir = path.join(home, '.agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'humans.yaml'), [
      'version: 1',
      'owner:',
      '  notify:',
      '    channel: imessage',
      "    to: '+15550000003'",
      '',
    ].join('\n'));

    expect(runHumans(home, 'humans.getOwnerNotifyFromHumans()')).toEqual({
      channel: 'imessage',
      to: '+15550000003',
    });
  });
});
