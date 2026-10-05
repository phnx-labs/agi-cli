
export function extractFileOpsFromBash(command: string): [string[], string[], string[]] {
  const filesRead: string[] = [];
  const filesWritten: string[] = [];
  const filesDeleted: string[] = [];

  let unwrappedCommand = command;
  const shellWrapperMatch = command.match(/-[lc]+\s+["'](.+)["']$/);
  if (shellWrapperMatch) {
    unwrappedCommand = shellWrapperMatch[1];
  }

  const writePatterns = [
    /(?:cat|echo|printf)\s+.*?>\s*["']?([^\s"'|;&]+)/,
    /tee\s+(?:-a\s+)?["']?([^\s"'|;&]+)/,
    /sed\s+-i[^\s]*\s+.*?["']?([^\s"']+)$/,
  ];

  for (const pattern of writePatterns) {
    const matches = unwrappedCommand.matchAll(new RegExp(pattern, 'g'));
    for (const match of matches) {
      const path = match[1];
      if (path && !path.startsWith('-')) {
        filesWritten.push(path);
      }
    }
  }

  const readPatterns = [
    /sed\s+-n\s+["'][^"']+["']\s+["']?([^\s"'|;&>]+)/,
    /(?:head|tail)\s+(?:-\w+\s+)*(?:\d+\s+)?([^\s"'|;&-][^\s"'|;&]*)/,
    /^cat\s+(?:-[^\s]+\s+)*["']?([^\s"'|;&>]+)["']?(?:\s|$)/,
    /\|\s*cat\s+["']?([^\s"'|;&>]+)["']?/,
  ];

  for (const pattern of readPatterns) {
    const matches = unwrappedCommand.matchAll(new RegExp(pattern, 'g'));
    for (const match of matches) {
      const path = match[1];
      if (path && !path.startsWith('-')) {
        filesRead.push(path);
      }
    }
  }

  const deletePatterns = [
    /rm\s+(?:-[^\s]+\s+)*["']?([^\s"'|;&]+)["']?/,
    /rm\s+(?:-[^\s]+\s+)*([^\s"'|;&-][^\s"'|;&]*)/,
  ];

  for (const pattern of deletePatterns) {
    const matches = unwrappedCommand.matchAll(new RegExp(pattern, 'g'));
    for (const match of matches) {
      const path = match[1];
      if (path && !path.startsWith('-') && !path.match(/^-[rf]+$/)) {
        filesDeleted.push(path);
      }
    }
  }

  const unique = (paths: string[]) => Array.from(new Set(paths.filter(Boolean)));
  return [unique(filesRead), unique(filesWritten), unique(filesDeleted)];
}
