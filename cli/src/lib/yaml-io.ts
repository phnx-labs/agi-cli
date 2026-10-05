import * as yaml from 'yaml';

export function stringifyDoc(doc: yaml.Document, options: yaml.ToStringOptions = {}): string {
  // Canonical serialization prevents committed YAML oscillation: force block only for a flow root, preserving intentional nested flow collections.
  const rootIsFlow = (doc.contents as { flow?: boolean } | null)?.flow === true;
  return doc.toString({
    flowCollectionPadding: false,
    ...(rootIsFlow ? { collectionStyle: 'block' as const } : {}),
    ...options,
  });
}
