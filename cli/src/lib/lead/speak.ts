import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { configKeySpec, getConfigValue } from '../device-config.js';
import type { LeadEvent } from './events.js';

export const VOICE_MODEL = 'eleven_turbo_v2_5';
export const VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
export const VOICE_KEY = 'ELEVENLABS_API_KEY';
const ELEVENLABS_URL = 'https://api.elevenlabs.io';
const SYNTH_TIMEOUT_MS = 20_000;

const BOUNDARY = /[.!?…]+["”’')\]]*(?=\s)|\n+/g;
const ABBREVIATION = /(?:^|\s)(?:e\.g|i\.e|etc|vs|approx|Mr|Mrs|Ms|Dr|St|No)\.$/i;
const LIST_MARKER = /^\W*(?:\d+|[a-z])[.)]$/i;

export class SentenceSplitter {
  private buf = '';

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    let from = 0;
    BOUNDARY.lastIndex = 0;
    for (let m = BOUNDARY.exec(this.buf); m; m = BOUNDARY.exec(this.buf)) {
      const end = m.index + m[0].length;
      const candidate = this.buf.slice(from, end).trim();
      if (!m[0].startsWith('\n') && (ABBREVIATION.test(candidate) || LIST_MARKER.test(candidate))) continue;
      if (candidate) out.push(candidate);
      from = end;
    }
    this.buf = this.buf.slice(from);
    return out;
  }

  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = '';
    return rest ? [rest] : [];
  }
}

export function speakable(sentence: string): string | null {
  const text = sentence
    .replace(/https?:\/\/\S+/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_>|~]+|#+(?!\d)/g, ' ')
    .replace(/^\s*[-•]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return /[\p{L}\p{N}]/u.test(text) ? text : null;
}

export function playerArgv(file: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'darwin' ? ['afplay', file] : ['ffplay', '-nodisp', '-autoexit', '-loglevel', 'quiet', file];
}

export function voiceBundle(): string {
  const value = getConfigValue('lead.voice.bundle').value;
  return typeof value === 'string' && value.length > 0 ? value : String(configKeySpec('lead.voice.bundle').defaultValue);
}

async function readVoiceKey(bundle: string): Promise<string> {
  const [{ readAndResolveBundleEnv }, { resolveSecretsContextForRun }] = await Promise.all([
    import('../secrets-client.js'),
    import('../secrets-policy.js'),
  ]);
  const { env } = await readAndResolveBundleEnv(bundle, { caller: 'agents lead ask --speak', keys: [VOICE_KEY] }, await resolveSecretsContextForRun());
  const key = env[VOICE_KEY];
  if (!key) throw new Error(`secrets bundle '${bundle}' has no ${VOICE_KEY}`);
  return key;
}

export interface SpeakerOptions {
  apiKey: Promise<string>;
  baseUrl?: string;
  player?: (file: string) => string[];
  onError?: (line: string) => void;
}

export class LeadSpeaker {
  private readonly splitter = new SentenceSplitter();
  private readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-lead-speak-'));
  private chain: Promise<void> = Promise.resolve();
  private clips = 0;
  private sawText = false;
  private dead = false;

  constructor(private readonly opts: SpeakerOptions) {
    opts.apiKey.catch((err) => this.fail(err));
  }

  static start(): LeadSpeaker {
    const bundle = voiceBundle();
    return new LeadSpeaker({ apiKey: readVoiceKey(bundle) });
  }

  onEvent(e: LeadEvent): void {
    if (e.type === 'text') {
      this.sawText = true;
      for (const s of this.splitter.push(e.delta)) this.say(s);
    } else if (e.type === 'done') {
      const rest = this.sawText ? this.splitter.flush() : [...this.splitter.push(e.text), ...this.splitter.flush()];
      for (const s of rest) this.say(s);
    } else if (e.type === 'error') {
      for (const s of this.splitter.flush()) this.say(s);
    }
  }

  async drain(): Promise<void> {
    await this.chain;
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  private fail(err: unknown): void {
    if (this.dead) return;
    this.dead = true;
    (this.opts.onError ?? ((line) => process.stderr.write(`${line}\n`)))(`voice: ${err instanceof Error ? err.message : String(err)}; the reply is not spoken.`);
  }

  private say(sentence: string): void {
    const text = speakable(sentence);
    if (!text || this.dead) return;
    const file = path.join(this.dir, `${String(++this.clips).padStart(3, '0')}.mp3`);
    const audio = this.synthesize(text, file);
    audio.catch(() => {});
    this.chain = this.chain.then(async () => {
      if (this.dead) return;
      try {
        await audio;
        await this.play(file);
      } catch (err) {
        this.fail(err);
      } finally {
        fs.rmSync(file, { force: true });
      }
    });
  }

  private async synthesize(text: string, file: string): Promise<void> {
    const key = await this.opts.apiKey;
    const url = `${this.opts.baseUrl ?? ELEVENLABS_URL}/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: VOICE_MODEL }),
      signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ElevenLabs answered HTTP ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()), { mode: 0o600 });
  }

  private play(file: string): Promise<void> {
    const [command, ...args] = (this.opts.player ?? playerArgv)(file);
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: 'ignore' });
      child.on('error', (err) => reject((err as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`${command} is not installed`) : err));
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
    });
  }
}
