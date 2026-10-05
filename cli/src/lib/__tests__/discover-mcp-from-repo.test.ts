import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let REPO_DIR: string;
let AGENTS_DIR: string;

vi.mock('../state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state.js')>();
  return {
    ...actual,
    getUserMcpDir: () => path.join(AGENTS_DIR, 'mcp'),
  };
});

async function loadLib() {
  return await import('../mcp.js');
}

function writeYaml(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

describe('discoverMcpConfigsFromRepo', () => {
  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-discover-'));
    REPO_DIR = path.join(root, 'repo');
    AGENTS_DIR = path.join(root, 'agents');
    fs.mkdirSync(REPO_DIR, { recursive: true });
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
  });

  afterEach(() => {
    if (REPO_DIR) {
      const root = path.dirname(REPO_DIR);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns empty when the repo has no mcp/ directory', async () => {
    const { discoverMcpConfigsFromRepo } = await loadLib();
    expect(discoverMcpConfigsFromRepo(REPO_DIR)).toEqual([]);
  });

  it('finds valid stdio and http configs and skips invalid ones', async () => {
    const { discoverMcpConfigsFromRepo } = await loadLib();

    writeYaml(path.join(REPO_DIR, 'mcp', 'notion.yaml'), [
      'name: notion',
      'transport: stdio',
      'command: uvx',
      'args:',
      '  - notion-mcp',
    ].join('\n'));

    writeYaml(path.join(REPO_DIR, 'mcp', 'figma.yml'), [
      'name: figma',
      'transport: http',
      'url: https://api.figma.com/mcp',
    ].join('\n'));

    writeYaml(path.join(REPO_DIR, 'mcp', 'broken.yaml'), [
      'name: broken',
      'command: foo',
    ].join('\n'));

    writeYaml(path.join(REPO_DIR, 'mcp', 'README.md'), '# not a config');

    const discovered = discoverMcpConfigsFromRepo(REPO_DIR);
    const names = discovered.map((d) => d.name).sort();

    expect(names).toEqual(['figma', 'notion']);
    const notion = discovered.find((d) => d.name === 'notion')!;
    expect(notion.config.transport).toBe('stdio');
    expect(notion.config.command).toBe('uvx');
    expect(notion.config.args).toEqual(['notion-mcp']);

    const figma = discovered.find((d) => d.name === 'figma')!;
    expect(figma.config.transport).toBe('http');
    expect(figma.config.url).toBe('https://api.figma.com/mcp');
  });

  it('skips a config whose validation THROWS, without losing its valid siblings', async () => {
    const { discoverMcpConfigsFromRepo } = await loadLib();

    writeYaml(path.join(REPO_DIR, 'mcp', 'ok.yaml'), [
      'name: ok', 'transport: stdio', 'command: uvx',
    ].join('\n'));
    writeYaml(path.join(REPO_DIR, 'mcp', 'bad-args.yaml'), [
      'name: badargs', 'transport: stdio', 'command: uvx', 'args: 5',
    ].join('\n'));
    writeYaml(path.join(REPO_DIR, 'mcp', 'bad-command.yaml'), [
      'name: badcmd', 'transport: stdio', 'command: 42',
    ].join('\n'));
    writeYaml(path.join(REPO_DIR, 'mcp', 'bad-env.yaml'), [
      'name: badenv', 'transport: stdio', 'command: uvx', 'env: notamap',
    ].join('\n'));

    const discovered = discoverMcpConfigsFromRepo(REPO_DIR);
    expect(discovered.map((d) => d.name)).toEqual(['ok']);
  });

  it('installMcpConfigCentrally copies a discovered config into ~/.agents/mcp/', async () => {
    const { discoverMcpConfigsFromRepo, installMcpConfigCentrally } = await loadLib();

    writeYaml(path.join(REPO_DIR, 'mcp', 'notion.yaml'), [
      'name: notion',
      'transport: stdio',
      'command: uvx',
      'args:',
      '  - notion-mcp',
    ].join('\n'));

    const [discovered] = discoverMcpConfigsFromRepo(REPO_DIR);
    expect(discovered).toBeDefined();

    const result = installMcpConfigCentrally(discovered.path);
    expect(result.success).toBe(true);
    expect(result.path).toBe(path.join(AGENTS_DIR, 'mcp', 'notion.yaml'));
    expect(fs.existsSync(result.path!)).toBe(true);

    const yaml = await import('yaml');
    const round = yaml.parse(fs.readFileSync(result.path!, 'utf-8'));
    expect(round.name).toBe('notion');
    expect(round.transport).toBe('stdio');
    expect(round.command).toBe('uvx');
    expect(round.args).toEqual(['notion-mcp']);
  });

  it('installMcpConfigCentrally returns an error for invalid source files', async () => {
    const { installMcpConfigCentrally } = await loadLib();
    const bad = path.join(REPO_DIR, 'bad.yaml');
    writeYaml(bad, 'name: x\n');

    const result = installMcpConfigCentrally(bad);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid');
  });
});
