/** Generic reader/writer for a `.gemini/.../settings.json`-shaped config. Not gemini-specific:
 * gemini is hard-deprecated with no caller (RUSH-2202). Antigravity shares this shape and
 * permissions.ts reuses updateGeminiSettings for it; do not reintroduce gemini-only logic. */
import * as fs from 'fs';
import * as path from 'path';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readGeminiSettings(settingsPath: string): Record<string, unknown> {
  if (!fs.existsSync(settingsPath)) {
    return {};
  }

  const raw = fs.readFileSync(settingsPath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`Gemini settings must be a JSON object: ${settingsPath}`);
  }
  return parsed;
}

function writeGeminiSettings(settingsPath: string, settings: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

export function updateGeminiSettings(
  settingsPath: string,
  mutate: (settings: Record<string, unknown>) => void
): Record<string, unknown> {
  const settings = readGeminiSettings(settingsPath);
  mutate(settings);
  writeGeminiSettings(settingsPath, settings);
  return settings;
}
