import path from 'path';
import {
  parse,
  type ArithmeticExpression,
  type Node,
  type ParsedScript,
  type TestExpression,
  type Word,
  type WordPart,
} from 'unbash';

interface ShellProgramExtraction {
  programs: string[];
  occurrences: ShellProgramOccurrence[];
  diagnostics: string[];
}

export type ShellProgramRole = 'wrapper' | 'effective';

export interface ShellProgramOccurrence {
  program: string;
  role: ShellProgramRole;
}

/**
 * Harness tool NAMES that run a shell command — Claude's `Bash`, Codex's
 * `exec_command`/`exec` (`exec` is newer gpt-5.6-sol), Droid's `Execute`, plus the
 * generic `shell`/`run_shell_command`/`run_command`/`execute`. This is the single
 * source of truth for "does this tool row carry a shell command?", consumed by the
 * trajectory model (program resolution + command-arg extraction), the directory-touched
 * scan in `state.ts`, the tool-call indexer, and stream rendering — replacing five
 * hand-synced copies that had already drifted apart.
 *
 * Distinct from {@link SHELL_WRAPPERS}, which is interpreter binaries (`bash`, `sh`…)
 * found INSIDE a command string, not the harness's tool name. Match through
 * {@link isShellExecTool} so casing is normalized in one place — harnesses disagree on
 * case (`Bash` vs `bash`, `Execute` vs `exec_command`).
 */
export const SHELL_EXEC_TOOLS = new Set([
  'bash', 'exec', 'execute', 'exec_command', 'run_command', 'run_shell_command', 'shell',
]);

/** Case-insensitive membership test for {@link SHELL_EXEC_TOOLS}. */
export function isShellExecTool(tool: string | undefined): boolean {
  return tool !== undefined && SHELL_EXEC_TOOLS.has(tool.toLowerCase());
}

const SHELL_WRAPPERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const PROGRAM_WRAPPERS = new Set(['command', 'builtin', 'env', 'nohup', 'sudo']);
const MAX_NESTED_DEPTH = 3;
const SUDO_OPTIONS_WITH_VALUE = new Set([
  '-C', '--close-from', '-D', '--chdir', '-g', '--group', '-h', '--device',
  '-p', '--prompt', '-R', '--chroot', '-r', '--role', '-t', '--type',
  '-T', '--command-timeout', '-u', '--user',
]);

function normalizeProgram(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\0')) return undefined;
  const normalized = trimmed.replace(/\\/g, '/');
  const base = path.posix.basename(normalized);
  return base || undefined;
}

function staticParts(parts: WordPart[] | undefined): boolean {
  if (!parts) return true;
  return parts.every((part) => {
    switch (part.type) {
      case 'Literal':
      case 'SingleQuoted':
      case 'AnsiCQuoted':
        return true;
      case 'DoubleQuoted':
      case 'LocaleString':
        return staticParts(part.parts);
      default:
        return false;
    }
  });
}

/** Return a word only when Bash expansion cannot change its value. */
export function staticShellWord(word: Word | undefined): string | undefined {
  if (!word || !staticParts(word.parts)) return undefined;
  return word.value || undefined;
}

function walkWord(word: Word | undefined, visitScript: (script: ParsedScript) => void): void {
  if (!word) return;
  const walkPart = (part: WordPart): void => {
    switch (part.type) {
      case 'DoubleQuoted':
      case 'LocaleString':
        part.parts.forEach(walkPart);
        break;
      case 'CommandExpansion':
      case 'ProcessSubstitution':
        if (part.script) visitScript(part.script);
        break;
      case 'ArithmeticExpansion':
        if (part.expression) walkArithmetic(part.expression, visitScript);
        break;
      case 'ParameterExpansion':
        part.indexParts?.forEach(walkPart);
        walkWord(part.operand, visitScript);
        if (part.slice) {
          walkWord(part.slice.offset, visitScript);
          walkWord(part.slice.length, visitScript);
        }
        if (part.replace) {
          walkWord(part.replace.pattern, visitScript);
          walkWord(part.replace.replacement, visitScript);
        }
        break;
      case 'ExtendedGlob':
      case 'BraceExpansion':
        part.parts?.forEach(walkPart);
        break;
      default:
        break;
    }
  };
  // `parts` is a lazy getter in unbash. Access it explicitly; Object.keys(word)
  // does not enumerate expansions.
  word.parts?.forEach(walkPart);
}

function walkArithmetic(expr: ArithmeticExpression, visitScript: (script: ParsedScript) => void): void {
  switch (expr.type) {
    case 'ArithmeticBinary':
      walkArithmetic(expr.left, visitScript);
      walkArithmetic(expr.right, visitScript);
      break;
    case 'ArithmeticUnary':
      walkArithmetic(expr.operand, visitScript);
      break;
    case 'ArithmeticTernary':
      walkArithmetic(expr.test, visitScript);
      walkArithmetic(expr.consequent, visitScript);
      walkArithmetic(expr.alternate, visitScript);
      break;
    case 'ArithmeticGroup':
      walkArithmetic(expr.expression, visitScript);
      break;
    case 'ArithmeticWord':
      expr.parts?.forEach((part) => walkWordPart(part, visitScript));
      break;
    case 'ArithmeticCommandExpansion':
      if (expr.script) visitScript(expr.script);
      break;
  }
}

function walkWordPart(part: WordPart, visitScript: (script: ParsedScript) => void): void {
  const synthetic: Word = { text: part.text, value: '', pos: 0, end: 0, parts: [part] };
  walkWord(synthetic, visitScript);
}

function walkTest(expr: TestExpression, visitScript: (script: ParsedScript) => void): void {
  switch (expr.type) {
    case 'TestUnary':
      walkWord(expr.operand, visitScript);
      break;
    case 'TestBinary':
      walkWord(expr.left, visitScript);
      walkWord(expr.right, visitScript);
      break;
    case 'TestLogical':
      walkTest(expr.left, visitScript);
      walkTest(expr.right, visitScript);
      break;
    case 'TestNot':
      walkTest(expr.operand, visitScript);
      break;
    case 'TestGroup':
      walkTest(expr.expression, visitScript);
      break;
  }
}

function nestedPayload(command: Extract<Node, { type: 'Command' }>): string | undefined {
  const program = normalizeProgram(staticShellWord(command.name) ?? '');
  const suffix = command.suffix.map(staticShellWord);
  if (!program || suffix.some((part) => part === undefined)) return undefined;
  const words = suffix as string[];

  if (SHELL_WRAPPERS.has(program)) {
    const flagIndex = words.findIndex((word) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word));
    return flagIndex >= 0 ? words[flagIndex + 1] : undefined;
  }

  if (program === 'ssh') {
    let i = 0;
    while (i < words.length && words[i].startsWith('-')) {
      const option = words[i++];
      if (/^-(?:b|c|D|E|F|I|i|J|L|l|m|O|o|p|Q|R|S|W|w)$/.test(option)) i++;
    }
    i++; // host
    return i < words.length ? words.slice(i).join(' ') : undefined;
  }

  if ((program === 'agents' || program === 'ag') && words[0] === 'ssh') {
    return words.length > 2 ? words.slice(2).join(' ') : undefined;
  }

  return undefined;
}

function wrapperDelegate(words: string[], wrapper: string): string[] | undefined {
  let index = 0;
  if (wrapper === 'env') {
    while (index < words.length) {
      const word = words[index];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
        index++;
        continue;
      }
      if (word === '-u' || word === '--unset' || word === '-C' || word === '--chdir') {
        index += 2;
        continue;
      }
      if (word === '--') {
        index++;
        break;
      }
      if (word.startsWith('-')) {
        index++;
        continue;
      }
      break;
    }
  } else if (wrapper === 'sudo') {
    while (index < words.length) {
      const word = words[index];
      if (word === '--') {
        index++;
        break;
      }
      const option = word.includes('=') ? word.slice(0, word.indexOf('=')) : word;
      if (!word.startsWith('-')) break;
      index++;
      if (!word.includes('=') && SUDO_OPTIONS_WITH_VALUE.has(option)) index++;
    }
    while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index++;
  } else {
    while (index < words.length && words[index].startsWith('-')) {
      if (words[index++] === '--') break;
    }
  }
  return index < words.length ? words.slice(index) : undefined;
}

/** Parse Bash without executing it and return every statically identifiable program. */
export function extractShellPrograms(source: string, depth = 0): ShellProgramExtraction {
  const programs: string[] = [];
  const occurrences: ShellProgramOccurrence[] = [];
  const diagnostics: string[] = [];
  const seen = new Set<string>();

  const add = (value: string | undefined, role: ShellProgramRole): string | undefined => {
    const program = value ? normalizeProgram(value) : undefined;
    if (!program) return undefined;
    occurrences.push({ program, role });
    if (!seen.has(program)) {
      seen.add(program);
      programs.push(program);
    }
    return program;
  };

  const addWrapperDelegates = (wrapper: string, words: string[]): void => {
    let remaining = wrapperDelegate(words, wrapper);
    while (remaining) {
      const program = normalizeProgram(remaining[0]);
      if (!program) return;
      const isWrapper = PROGRAM_WRAPPERS.has(program);
      add(program, isWrapper ? 'wrapper' : 'effective');
      if (!isWrapper) return;
      remaining = wrapperDelegate(remaining.slice(1), program);
    }
  };

  const visitScript = (script: ParsedScript): void => {
    for (const error of script.errors ?? []) diagnostics.push(`${error.pos}: ${error.message}`);
    script.commands.forEach((statement) => visitNode(statement));
  };

  const visitNode = (node: Node): void => {
    switch (node.type) {
      case 'Statement':
        visitNode(node.command);
        node.redirects.forEach((redirect) => {
          walkWord(redirect.target, visitScript);
          if (!redirect.heredocQuoted) walkWord(redirect.body, visitScript);
        });
        break;
      case 'Command': {
        const program = staticShellWord(node.name);
        const normalized = normalizeProgram(program ?? '');
        const payload = nestedPayload(node);
        add(program, normalized && (PROGRAM_WRAPPERS.has(normalized) || payload) ? 'wrapper' : 'effective');
        node.prefix.forEach((prefix) => {
          walkWord(prefix.value, visitScript);
          prefix.indexParts?.forEach((part) => walkWordPart(part, visitScript));
          prefix.array?.forEach((word) => walkWord(word, visitScript));
        });
        walkWord(node.name, visitScript);
        node.suffix.forEach((word) => walkWord(word, visitScript));
        node.redirects.forEach((redirect) => {
          walkWord(redirect.target, visitScript);
          if (!redirect.heredocQuoted) walkWord(redirect.body, visitScript);
        });

        if (normalized && PROGRAM_WRAPPERS.has(normalized)) {
          const words = node.suffix.map(staticShellWord);
          if (words.every((word) => word !== undefined)) {
            addWrapperDelegates(normalized, words as string[]);
          }
        }
        if (payload && depth < MAX_NESTED_DEPTH) {
          const nested = extractShellPrograms(payload, depth + 1);
          for (const occurrence of nested.occurrences) add(occurrence.program, occurrence.role);
          diagnostics.push(...nested.diagnostics);
        }
        break;
      }
      case 'Pipeline':
      case 'AndOr':
        node.commands.forEach(visitNode);
        break;
      case 'If':
        visitNode(node.clause);
        visitNode(node.then);
        if (node.else) visitNode(node.else);
        break;
      case 'For':
      case 'Select':
        node.wordlist.forEach((word) => walkWord(word, visitScript));
        visitNode(node.body);
        break;
      case 'ArithmeticFor':
        if (node.initialize) walkArithmetic(node.initialize, visitScript);
        if (node.test) walkArithmetic(node.test, visitScript);
        if (node.update) walkArithmetic(node.update, visitScript);
        visitNode(node.body);
        break;
      case 'While':
        visitNode(node.clause);
        visitNode(node.body);
        break;
      case 'Function':
        walkWord(node.name, visitScript);
        visitNode(node.body);
        break;
      case 'Subshell':
      case 'BraceGroup':
        visitNode(node.body);
        break;
      case 'CompoundList':
        node.commands.forEach(visitNode);
        break;
      case 'Case':
        walkWord(node.word, visitScript);
        node.items.forEach((item) => {
          item.pattern.forEach((word) => walkWord(word, visitScript));
          visitNode(item.body);
        });
        break;
      case 'Coproc':
        walkWord(node.name, visitScript);
        visitNode(node.body);
        break;
      case 'TestCommand':
        walkTest(node.expression, visitScript);
        break;
      case 'ArithmeticCommand':
        if (node.expression) walkArithmetic(node.expression, visitScript);
        break;
    }
  };

  try {
    const parsed = parse(source);
    if (parsed.errors?.length) {
      return {
        programs: [],
        occurrences: [],
        diagnostics: parsed.errors.map((error) => `${error.pos}: ${error.message}`),
      };
    }
    visitScript(parsed);
  } catch (error) {
    diagnostics.push(error instanceof Error ? error.message : String(error));
  }

  return { programs, occurrences, diagnostics };
}
