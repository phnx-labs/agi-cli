import { describe, it, expect } from 'vitest';
import { buildModelChoices, chooseModelFromCatalog, pickModel } from './harness-hooks.js';
import type { ModelInfo } from '../lib/models.js';
import type { WizardIO, WizardChoice } from './harness-wizard.js';

function fakeIO(respond: (kind: string, message: string, choices?: WizardChoice<unknown>[]) => unknown): WizardIO {
  return {
    async select<T>(o: { message: string; choices: WizardChoice<T>[] }): Promise<T> {
      return respond('select', o.message, o.choices as WizardChoice<unknown>[]) as T;
    },
    async input(o: { message: string; default?: string }): Promise<string> {
      return (respond('input', o.message) ?? o.default ?? '') as string;
    },
    async password(): Promise<string> { return ''; },
    async confirm(): Promise<boolean> { return true; },
    note(): void {},
  };
}

const model = (over: Partial<ModelInfo>): ModelInfo => ({ id: 'x', ...over });

describe('buildModelChoices — catalog list → select choices', () => {
  it('lists every catalog model and always appends a custom-id escape hatch', () => {
    const choices = buildModelChoices([model({ id: 'a' }), model({ id: 'b' })]);
    const values = choices.map((c) => c.value);
    expect(values).toContain('a');
    expect(values).toContain('b');
    expect(choices[choices.length - 1].name).toMatch(/custom model id/i);
  });

  it('leads with a keep-current row only in edit mode (when a current value is given)', () => {
    const withCurrent = buildModelChoices([model({ id: 'a' })], 'a');
    expect(withCurrent[0].name).toMatch(/Keep current \(a\)/);

    const withoutCurrent = buildModelChoices([model({ id: 'a' })]);
    expect(withoutCurrent[0].name).not.toMatch(/Keep current/);
  });

  it('annotates the default model and any alias in the row label', () => {
    const choices = buildModelChoices([
      model({ id: 'claude-opus-4-8', alias: 'opus', isDefault: true }),
    ]);
    const row = choices.find((c) => c.value === 'claude-opus-4-8')!;
    expect(row.name).toContain('opus');
    expect(row.name).toContain('default');
  });
});

describe('chooseModelFromCatalog — sentinel rows resolve to a concrete model id', () => {
  const models = [model({ id: 'a' }), model({ id: 'b' })];

  it('returns the picked catalog model id directly', async () => {
    const io = fakeIO((_k, _m, choices) => choices!.find((c) => c.value === 'b')!.value);
    expect(await chooseModelFromCatalog(io, models, undefined)).toBe('b');
  });

  it('resolves the keep-current row to the current value', async () => {
    const io = fakeIO((_k, _m, choices) => choices!.find((c) => c.name.includes('Keep current'))!.value);
    expect(await chooseModelFromCatalog(io, models, 'a')).toBe('a');
  });

  it('resolves the custom-id row to the free-text input', async () => {
    const io = fakeIO((kind, _m, choices) => {
      if (kind === 'select') return choices!.find((c) => c.name.match(/custom model id/i))!.value;
      return 'my/typed-model';
    });
    expect(await chooseModelFromCatalog(io, models, undefined)).toBe('my/typed-model');
  });
});

describe('pickModel — falls through to free-text when no catalog is available', () => {
  it('returns null (→ engine free-text prompt) when the host is unknown', async () => {
    const io = fakeIO(() => {
      throw new Error('should not prompt without a host');
    });
    expect(await pickModel(io, undefined, undefined, undefined)).toBeNull();
  });
});
