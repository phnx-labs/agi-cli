
export function resolveTemplate(
  tmpl: string,
  artifact: Record<string, string>,
  preflight: Record<string, string | string[] | unknown>
): string {
  let result = tmpl;

  result = result.replace(/\{\{artifact\.(\w+)\}\}/g, (_, key) => {
    return artifact[key] ?? '';
  });

  result = result.replace(/\{\{preflight\.(\w+)\}\}/g, (_, key) => {
    const val = preflight[key];
    if (val === undefined || val === null) {
      return '';
    }
    if (typeof val === 'string') {
      return val;
    }
    if (Array.isArray(val)) {
      return val.join(',');
    }
    return '';
  });

  return result;
}

export function extractTemplateVariables(tmpl: string): {
  artifact: string[];
  preflight: string[];
} {
  const artifact: string[] = [];
  const preflight: string[] = [];

  const re = /\{\{(\w+)\.(\w+)\}\}/g;
  let match;

  while ((match = re.exec(tmpl)) !== null) {
    const [, prefix, key] = match;
    if (prefix === 'artifact' && !artifact.includes(key)) {
      artifact.push(key);
    } else if (prefix === 'preflight' && !preflight.includes(key)) {
      preflight.push(key);
    }
  }

  return { artifact, preflight };
}
