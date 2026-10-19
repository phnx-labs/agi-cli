import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LeadSpeaker, SentenceSplitter, VOICE_ID, VOICE_MODEL, playerArgv, speakable } from './speak.js';

function split(deltas: string[]): string[] {
  const s = new SentenceSplitter();
  return [...deltas.flatMap((d) => s.push(d)), ...s.flush()];
}

describe('sentence splitting', () => {
  it('emits each sentence once its end is certain, across arbitrary delta cuts', () => {
    const text = 'Two agents are running. Claude is on PHNX-4365, e.g. the MCP fix! Is #3607 ready? Version 1.2 shipped';
    const want = ['Two agents are running.', 'Claude is on PHNX-4365, e.g. the MCP fix!', 'Is #3607 ready?', 'Version 1.2 shipped'];
    expect(split([text])).toEqual(want);
    expect(split(text.match(/.{1,5}/gs)!)).toEqual(want);
    const s = new SentenceSplitter();
    expect(s.push('Done.')).toEqual([]);
    expect(s.push(' Next')).toEqual(['Done.']);
  });

  it('splits on line breaks but not after a list number', () => {
    expect(split(['Queued:\n1. Send to “Docs”\n2. Stop it'])).toEqual(['Queued:', '1. Send to “Docs”', '2. Stop it']);
  });

  it('speaks words, not markup or links', () => {
    expect(speakable('**Merged** `#12`, see https://github.com/a/b/pull/12')).toBe('Merged #12, see');
    expect(speakable('- ---')).toBeNull();
  });

  it('plays with afplay on macOS and ffplay elsewhere', () => {
    expect(playerArgv('/t/1.mp3', 'darwin')).toEqual(['afplay', '/t/1.mp3']);
    expect(playerArgv('/t/1.mp3', 'linux')).toEqual(['ffplay', '-nodisp', '-autoexit', '-loglevel', 'quiet', '/t/1.mp3']);
  });
});

describe('LeadSpeaker', () => {
  let server: http.Server;
  let baseUrl: string;
  const requests: Array<{ url: string; key: string; body: { text: string; model_id: string } }> = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-speak-'));
  const playLog = path.join(tmp, 'played.log');
  const player = (file: string) => [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(playLog)}, require('fs').readFileSync(process.argv[1], 'utf-8') + '\\n')`, file];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        const body = JSON.parse(raw) as { text: string; model_id: string };
        requests.push({ url: req.url!, key: String(req.headers['xi-api-key']), body });
        if (body.text.includes('FAIL')) { res.writeHead(401).end(); return; }
        setTimeout(() => res.writeHead(200, { 'content-type': 'audio/mpeg' }).end(`clip:${body.text}`), body.text.length % 3 === 0 ? 30 : 0);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => { server.close(); });

  it('synthesizes each finished sentence with Turbo and plays the clips in order', async () => {
    const speaker = new LeadSpeaker({ apiKey: Promise.resolve('k-test'), baseUrl, player });
    speaker.onEvent({ type: 'text', delta: 'One agent asks. It wants ' });
    speaker.onEvent({ type: 'tool', id: 't', label: 'roster', cmd: 'agents lead tool roster', state: 'run' });
    speaker.onEvent({ type: 'text', delta: 'the staging db! Send it?' });
    speaker.onEvent({ type: 'done', turn: 't_1', text: 'ignored', summary: '', refs: [], timing: { boot: 0, model: 0, tools: 0 } });
    await speaker.drain();
    expect(fs.readFileSync(playLog, 'utf-8').trim().split('\n')).toEqual(['clip:One agent asks.', 'clip:It wants the staging db!', 'clip:Send it?']);
    expect(requests.every((r) => r.url === `/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128` && r.key === 'k-test' && r.body.model_id === VOICE_MODEL)).toBe(true);
  });

  it('a voice failure is one stderr line and never throws', async () => {
    fs.rmSync(playLog, { force: true });
    const errors: string[] = [];
    const speaker = new LeadSpeaker({ apiKey: Promise.resolve('k'), baseUrl, player, onError: (l) => errors.push(l) });
    speaker.onEvent({ type: 'done', turn: 't', text: 'FAIL here. And here. And again.', summary: '', refs: [], timing: { boot: 0, model: 0, tools: 0 } });
    await speaker.drain();
    expect(errors).toEqual(['voice: ElevenLabs answered HTTP 401; the reply is not spoken.']);
    expect(fs.existsSync(playLog)).toBe(false);

    const noKey: string[] = [];
    const missing = new LeadSpeaker({ apiKey: Promise.reject(new Error("secrets bundle 'elevenlabs' not found")), baseUrl, player, onError: (l) => noKey.push(l) });
    missing.onEvent({ type: 'text', delta: 'Hello there. ' });
    await missing.drain();
    expect(noKey).toEqual(["voice: secrets bundle 'elevenlabs' not found; the reply is not spoken."]);

    const noPlayer: string[] = [];
    const absent = new LeadSpeaker({ apiKey: Promise.resolve('k'), baseUrl, player: (f) => ['agents-no-such-player', f], onError: (l) => noPlayer.push(l) });
    absent.onEvent({ type: 'text', delta: 'Hello there. ' });
    await absent.drain();
    expect(noPlayer).toEqual(['voice: agents-no-such-player is not installed; the reply is not spoken.']);
  });
});
