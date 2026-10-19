import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type FakeLinearAnswer = string | { stderr: string; code: number };

export interface FakeLinear {
  calls(): Array<{ profile: string | null; argv: string }>;
  restore(): void;
}

export function installFakeLinear(answers: Record<string, FakeLinearAnswer>): FakeLinear {
  return installFakeBin('linear', answers);
}

export function installFakeBin(name: string, answers: Record<string, FakeLinearAnswer>): FakeLinear {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), `fake-${name}-`));
  const log = path.join(bin, 'calls.log');
  const arms = Object.entries(answers).map(([argv, answer], i) => {
    if (argv.includes("'")) throw new Error(`fake linear argv cannot contain a quote: ${argv}`);
    const out = path.join(bin, `answer-${i}`);
    if (typeof answer === 'string') {
      fs.writeFileSync(out, answer);
      return `  '${argv}') cat '${out}' ;;`;
    }
    fs.writeFileSync(out, answer.stderr);
    return `  '${argv}') cat '${out}' >&2; exit ${answer.code} ;;`;
  });
  fs.writeFileSync(path.join(bin, name), [
    '#!/bin/sh',
    `printf '%s|%s\\n' "\${LINEAR_PROFILE-<unset>}" "$*" >> '${log}'`,
    'case "$*" in',
    ...arms,
    `  *) echo "Error: unexpected ${name} $*" >&2; exit 2 ;;`,
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  const priorPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${priorPath ?? ''}`;
  return {
    calls() {
      if (!fs.existsSync(log)) return [];
      return fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => {
        const bar = line.indexOf('|');
        const profile = line.slice(0, bar);
        return { profile: profile === '<unset>' ? null : profile, argv: line.slice(bar + 1) };
      });
    },
    restore() {
      process.env.PATH = priorPath;
      fs.rmSync(bin, { recursive: true, force: true });
    },
  };
}
