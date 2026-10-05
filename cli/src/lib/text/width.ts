
const SGR_REGEX = /\x1b\[[0-9;]*m/g;

const OSC8_REGEX = /\x1b\]8;[^;]*;.*?(?:\x1b\\|\x07)/g;

export function stripAnsi(s: string): string {
  return s.replace(OSC8_REGEX, '').replace(SGR_REGEX, '');
}

function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    cp === 0x200b || cp === 0x200d ||
    (cp >= 0xfe00 && cp <= 0xfe0f)
  ) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

export function stringWidth(s: string): number {
  const plain = stripAnsi(s);
  let w = 0;
  for (const ch of plain) w += charWidth(ch.codePointAt(0)!);
  return w;
}

export function truncateToWidth(s: string, max: number): string {
  if (max <= 0) return '';
  const plain = stripAnsi(s);
  if (stringWidth(plain) <= max) return plain;
  let w = 0;
  let out = '';
  for (const ch of plain) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

export function padToWidth(s: string, width: number): string {
  const pad = width - stringWidth(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

export function terminalWidth(fallback = 100): number {
  const env = Number.parseInt(process.env.COLUMNS ?? '', 10);
  const raw = Number.isFinite(env) && env > 0
    ? env
    : (process.stdout.columns || fallback);
  return Math.max(60, Math.min(200, raw));
}
