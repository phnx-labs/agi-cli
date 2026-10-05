import type { Layout } from './types.js';

export type Packing = 'two-per-tab' | 'tabs';

export function planLayouts(count: number, packing: Packing = 'two-per-tab'): Layout[] {
  const out: Layout[] = [];
  for (let i = 0; i < count; i++) {
    if (packing === 'tabs') out.push('tab');
    else out.push(i % 2 === 0 ? 'tab' : 'split-right');
  }
  return out;
}
