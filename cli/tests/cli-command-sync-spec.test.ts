import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse as parseYaml } from 'yaml';
import { AGENTS } from '../src/lib/agents.js';
import { supports } from '../src/lib/capabilities.js';
import {
  shouldInstallCommandAsSkill,
  shouldAlsoInstallCommandAsSkill,
  installCommandSkillToVersion,
} from '../src/lib/command-skills.js';
import { toPosix } from '../src/lib/platform/index.js';

type FormatKind =
  | 'markdown-flat'
  | 'skill-dir'
  | 'toml-flat'
  | 'executable'
  | 'yaml-recipe-with-config-registration';

interface FormatSpec {
  kind: FormatKind;
  applies_when?: string;
  path_template: string;
  frontmatter?: { required?: string[]; recommended?: string[]; optional?: string[]; allowed?: string[] };
  schema?: { required?: string[]; optional?: string[] };
  name_from?: string;
  status?: string;
}

interface CliSpec {
  supported: boolean;
  version_split?: string;
  docs: Record<string, string>;
  formats: FormatSpec[];
  unsupported_formats?: Array<{ kind: string; path_template: string; reason: string }>;
  registry_divergence?: string;
  _skipped?: boolean;
}

const SPEC_PATH = path.join(__dirname, 'fixtures', 'cli-command-spec.json');
const SPEC = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf-8')) as Record<string, CliSpec | { $schema?: string }>;

const HOME = os.homedir();

function specEntries(): Array<[string, CliSpec]> {
  return Object.entries(SPEC).filter(([k, v]) => !k.startsWith('$') && !(v as CliSpec)._skipped) as Array<[string, CliSpec]>;
}

function expandHomePath(t: string): string {
  return t.replace('{HOME}', HOME);
}

function expectedFormatForVersion(cli: CliSpec, version: string | null): FormatSpec | null {
  if (!cli.formats?.length) return null;
  if (!version) return cli.formats.find((f) => !f.applies_when) ?? cli.formats[0];
  for (const f of cli.formats) {
    const m = f.applies_when?.match(/^version\s*([<>=]+)\s*(\S+)$/);
    if (!m) continue;
    const [, op, ver] = m;
    if (op === '<' && cmpSemver(version, ver) < 0) return f;
    if (op === '>=' && cmpSemver(version, ver) >= 0) return f;
  }
  return cli.formats.find((f) => !f.applies_when) ?? cli.formats[0];
}

function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n));
  const pb = b.split('.').map((n) => Number(n));
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

describe('CLI command sync: registry-vs-docs conformance', () => {
  for (const [id, cli] of specEntries()) {
    describe(id, () => {
      const reg = AGENTS[id];
      const banner = cli.registry_divergence ? `  [known divergence: ${cli.registry_divergence}]` : '';
      const itc = cli.registry_divergence ? it.skip : it;

      it('agent is present in AGENTS registry', () => {
        expect(reg, `${id} should be in AGENTS registry`).toBeDefined();
      });

      if (!reg) return;

      itc('support flag matches docs', () => {
        const regSupports = reg.capabilities?.commands !== false || reg.capabilities?.skills !== false;
        expect(
          regSupports,
          `Docs say ${id} ${cli.supported ? 'DOES' : 'does NOT'} support custom commands; registry has commands=${JSON.stringify(reg.capabilities?.commands)} skills=${JSON.stringify(reg.capabilities?.skills)}.${banner}`,
        ).toBe(cli.supported);
      });

      if (!cli.supported) return;

      const formatsToCheck = cli.formats.length > 1 ? cli.formats : [cli.formats[0]];

      for (const fmt of formatsToCheck) {
        const tag = fmt.applies_when ? ` [${fmt.applies_when}]` : '';

        if (fmt.kind === 'yaml-recipe-with-config-registration') {
          it.skip(`storage path matches docs${tag} (recipe-registration not modeled)`, () => {});
          continue;
        }

        it(`file format matches docs${tag}`, () => {
          const regFormat = reg.format ?? 'markdown';
          const expected =
            fmt.kind === 'toml-flat' ? 'toml'
            : 'markdown';
          expect(
            regFormat,
            `Docs say ${id}${tag} uses ${fmt.kind} (format=${expected}); registry has format=${regFormat}.${banner}`,
          ).toBe(expected);
        });

        itc(`storage path matches docs${tag}`, () => {
          const expectedPath = expandHomePath(fmt.path_template);
          if (fmt.kind === 'skill-dir') {
            const skillsDir = reg.skillsDir ?? '';
            const docDirPrefix = expectedPath.replace(/\/[^/]+\/SKILL\.md$/, '');
            expect(
              toPosix(skillsDir),
              `Docs say ${id}${tag} skills live at ${docDirPrefix}/<name>/SKILL.md; registry has skillsDir=${skillsDir}.${banner}`,
            ).toBe(toPosix(docDirPrefix));
          } else if (fmt.kind === 'markdown-flat' || fmt.kind === 'toml-flat') {
            const agentDir = reg.configDir;
            const regPath = path.join(agentDir, reg.commandsSubdir ?? '', `name.${fmt.kind === 'toml-flat' ? 'toml' : 'md'}`);
            const docPathPattern = expectedPath.replace('{name}', 'name');
            expect(
              toPosix(regPath),
              `Docs say ${id}${tag} writes to ${docPathPattern}; registry would write to ${regPath}.${banner}`,
            ).toBe(toPosix(docPathPattern));
          }
        });
      }

      const isSkillsOnly =
        cli.formats.length > 0 &&
        cli.formats.every((f) => f.kind === 'skill-dir' && !f.applies_when);

      if (isSkillsOnly) {
        itc('registry routes the CLI through skills', () => {
          const cap = reg.capabilities?.commands;
          const skillsOnly = cap === false || shouldAlsoInstallCommandAsSkill(id as keyof typeof AGENTS, '9999.0.0');
          expect(
            skillsOnly,
            `Docs say ${id} CLI uses skill-dir format. Registry has commands cap = ${JSON.stringify(cap)} and dual-write=${shouldAlsoInstallCommandAsSkill(id as keyof typeof AGENTS, '9999.0.0')}.${banner}`,
          ).toBe(true);
        });
      }
    });
  }
});

describe('CLI command sync: skill-dir writer output', () => {
  const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-sync-test-'));

  for (const [id, cli] of specEntries()) {
    if (!cli.supported) continue;
    const fmt = cli.formats.find((f) => !f.applies_when) ?? cli.formats[0];
    if (fmt.kind !== 'skill-dir') continue;
    const reg = AGENTS[id];
    if (!reg) continue;

    describe(id, () => {
      const cmd = 'verify-test-cmd';
      const sourceMd = path.join(SANDBOX, 'src', `${cmd}.md`);
      const sourceFm = `---\ndescription: Test command for sync verification\n---\n\nbody\n`;

      it('writes SKILL.md matching the doc-expected path + frontmatter', () => {
        fs.mkdirSync(path.dirname(sourceMd), { recursive: true });
        fs.writeFileSync(sourceMd, sourceFm);

        const agentDir = path.join(SANDBOX, id, `.${id}`);
        fs.mkdirSync(agentDir, { recursive: true });
        const installed = installCommandSkillToVersion(agentDir, cmd, sourceMd, []);

        expect(
          installed.success,
          `installCommandSkillToVersion returned ${JSON.stringify(installed)}`,
        ).toBe(true);

        const skillMd = path.join(agentDir, 'skills', cmd, 'SKILL.md');
        expect(fs.existsSync(skillMd), `SKILL.md not written at ${skillMd}`).toBe(true);

        const body = fs.readFileSync(skillMd, 'utf-8');
        expect(body.startsWith('---\n'), 'SKILL.md missing YAML frontmatter').toBe(true);
        const fmEnd = body.indexOf('\n---\n', 4);
        const fmObj = parseYaml(body.slice(4, fmEnd)) as Record<string, unknown>;

        for (const k of fmt.frontmatter?.required ?? []) {
          expect(fmObj[k], `Frontmatter key '${k}' required by docs but missing`).toBeDefined();
        }
      });
    });
  }
});

describe('CLI command sync: sync-pipeline invariants', () => {
  it('shouldInstallCommandAsSkill agrees with spec version_split for codex', () => {
    const codexSpec = SPEC.codex as CliSpec;
    expect(codexSpec.version_split).toBe('0.117.0');
    expect(shouldInstallCommandAsSkill('codex', '0.116.0')).toBe(false);
    expect(shouldInstallCommandAsSkill('codex', '0.134.0')).toBe(true);
  });

  const copilotIt = (SPEC.copilot as CliSpec).registry_divergence ? it.skip : it;
  copilotIt('copilot is not eligible for commands-as-skills (per docs: no custom commands at all)', () => {
    const copilotSpec = SPEC.copilot as CliSpec;
    expect(copilotSpec.supported).toBe(false);
    expect(supports('copilot', 'commands', '1.0.56').ok).toBe(false);
  });

  it('grok uses native command files (per docs: ~/.agents/commands/)', () => {
    expect(shouldInstallCommandAsSkill('grok', '0.2.111')).toBe(false);
  });

  it('cursor installs commands as skills in addition to its IDE command files', () => {
    expect(supports('cursor', 'commands', '2026.07.23-e383d2b').ok).toBe(true);
    expect(supports('cursor', 'skills', '2026.07.23-e383d2b').ok).toBe(true);
    expect(shouldInstallCommandAsSkill('cursor', '2026.07.23-e383d2b')).toBe(false);
    expect(shouldAlsoInstallCommandAsSkill('cursor', '2026.07.23-e383d2b')).toBe(true);
  });
});
