import { describe, it, expect } from 'vitest';
import { renderWhatsNew } from './whats-new.js';

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

const CHANGELOG = `# Changelog

## Unreleased

- **An unreleased entry that must never render.** Prose detail here.

## 1.20.35

- **Codex mode flags now match what the mode names promise — only \`--mode skip\` is yolo.** \`--mode edit\` used to append the bypass flag alongside \`--sandbox workspace-write\`, and the bypass flag wins. Long prose continues with **inline bold** and \`code\`.
- **\`--add-dir\` is now forwarded to Codex (it was silently dropped).** More verbose prose that should not appear.

## 1.20.34

**Test suite runs remotely on a crabbox VM (#525, #540)**

- \`scripts/release.sh\`'s test gate now runs on a leased crabbox VM.
- \`scripts/sandbox.sh\` box acquisition is now robust.

## 1.20.31

**\`agents sessions <id>\`: a catch-up digest (#502)**

- Opening a single session now leads with its title.

**A second heading in the same version**

- Some detail.
- Another detail with an inline **bold** word.

## 1.20.30

**Older release the user already had**

- Should never appear.

## 1.20.29

**An old-format heading with bold-led sub-bullets**

- **A bold-led sub-bullet.** Detail prose that must not render as an entry.
- Plain sub-bullet.
`;

describe('renderWhatsNew', () => {
  it('keeps only headings as bullets and drops the verbose sub-bullets', () => {
    const lines = renderWhatsNew(CHANGELOG, '1.20.31', '1.20.34').map(plain);

    expect(lines).toContain('v1.20.34');
    expect(lines).toContain('  • Test suite runs remotely on a crabbox VM (#525, #540)');
    expect(lines.some((l) => l.includes('release.sh'))).toBe(false);
    expect(lines.some((l) => l.includes('box acquisition'))).toBe(false);
  });

  it('emits a bullet for every heading within a single version', () => {
    const lines = renderWhatsNew(CHANGELOG, '1.20.30', '1.20.31').map(plain);
    expect(lines).toContain('v1.20.31');
    expect(lines).toContain('  • `agents sessions <id>`: a catch-up digest (#502)');
    expect(lines).toContain('  • A second heading in the same version');
  });

  it('bounds the range to (from, to] — excludes from, includes to, skips out-of-range', () => {
    const lines = renderWhatsNew(CHANGELOG, '1.20.31', '1.20.34').map(plain);
    expect(lines).not.toContain('v1.20.31');
    expect(lines.some((l) => l.includes('Older release'))).toBe(false);
    expect(lines).not.toContain('v1.20.30');
  });

  it('returns nothing when the range is empty', () => {
    expect(renderWhatsNew(CHANGELOG, '1.20.34', '1.20.34')).toEqual([]);
  });

  it('renders modern `- **Title.** prose` entries: heading kept, prose dropped', () => {
    const lines = renderWhatsNew(CHANGELOG, '1.20.34', '1.20.35').map(plain);
    expect(lines).toContain('v1.20.35');
    expect(lines).toContain(
      '  • Codex mode flags now match what the mode names promise — only `--mode skip` is yolo.',
    );
    expect(lines).toContain('  • `--add-dir` is now forwarded to Codex (it was silently dropped).');
    expect(lines.some((l) => l.includes('bypass flag wins'))).toBe(false);
    expect(lines.some((l) => l.includes('verbose prose'))).toBe(false);
  });

  it('never renders the Unreleased section, in either format', () => {
    const lines = renderWhatsNew(CHANGELOG, '1.20.30', '1.20.35').map(plain);
    expect(lines.some((l) => l.includes('unreleased entry'))).toBe(false);
  });

  it('old-format sections suppress bold-led sub-bullets (they are details, not entries)', () => {
    const lines = renderWhatsNew(CHANGELOG, '1.20.28', '1.20.29').map(plain);
    expect(lines).toContain('  • An old-format heading with bold-led sub-bullets');
    expect(lines.some((l) => l.includes('A bold-led sub-bullet'))).toBe(false);
    expect(lines.some((l) => l.includes('Plain sub-bullet'))).toBe(false);
  });

  it('a range mixing both formats renders one bullet per heading in each', () => {
    const lines = renderWhatsNew(CHANGELOG, '1.20.28', '1.20.35').map(plain);
    expect(lines.some((l) => l.includes('Codex mode flags'))).toBe(true);
    expect(lines).toContain('  • An old-format heading with bold-led sub-bullets');
    expect(lines.some((l) => l.includes('A bold-led sub-bullet'))).toBe(false);
  });
});
