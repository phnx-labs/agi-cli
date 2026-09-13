/**
 * Artifact action types and validation.
 * Ported from the legacy agent CLI config helpers.
 *
 * Artifact actions map tool invocations to artifact labels, allowing agents to
 * trigger tools automatically when specific artifacts are produced.
 */

/** A single action that binds a tool invocation to matching artifact labels. */
export interface ArtifactAction {
  tool: string;
  label: string;
  matches?: string[];
  input?: Record<string, string>;
}

/**
 * Validate artifact actions configuration.
 * @param actions - List of artifact actions to validate
 * @param httpToolNames - Set of tool names defined in http_tools section
 * @param applicationTools - Set of valid application tool names
 * @returns Array of validation errors (empty if valid)
 */
export function validateArtifactActions(
  actions: ArtifactAction[],
  httpToolNames: Set<string>,
  applicationTools: Set<string>
): string[] {
  const errors: string[] = [];

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const prefix = `artifact_actions[${i}]`;

    if (!action.tool) {
      errors.push(`${prefix}: tool is required`);
    } else if (!applicationTools.has(action.tool) && !httpToolNames.has(action.tool)) {
      errors.push(`${prefix}: unknown application tool '${action.tool}'`);
    }

    if (!action.label) {
      errors.push(`${prefix}: label is required`);
    }

    if (!action.matches || action.matches.length === 0) {
      errors.push(`${prefix}: matches is required (list of artifact labels/patterns)`);
    }

    if (action.input) {
      for (const [key, tmpl] of Object.entries(action.input)) {
        const err = validateTemplate(tmpl);
        if (err) {
          errors.push(`${prefix}.input.${key}: ${err}`);
        }
      }
    }
  }

  return errors;
}

/**
 * Validate template string uses only allowed patterns.
 * Only allows {{artifact.X}} and {{preflight.X}} patterns.
 */
function validateTemplate(tmpl: string): string | null {
  const re = /\{\{(\w+)\.(\w+)\}\}/g;
  let match;

  while ((match = re.exec(tmpl)) !== null) {
    const prefix = match[1];
    if (prefix !== 'artifact' && prefix !== 'preflight') {
      return `invalid template variable '{{${prefix}.${match[2]}}}', only artifact.* and preflight.* allowed`;
    }
  }

  return null;
}
