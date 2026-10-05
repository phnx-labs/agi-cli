import * as yaml from 'yaml';

export function stringifyDoc(doc: yaml.Document, options: yaml.ToStringOptions = {}): string {
  // Canonical shared serialization uses block style only when the parsed root was flow-style.
  const rootIsFlow = (doc.contents as { flow?: boolean } | null)?.flow === true;
  return doc.toString({
    flowCollectionPadding: false,
    ...(rootIsFlow ? { collectionStyle: 'block' as const } : {}),
    ...options,
  });
}
