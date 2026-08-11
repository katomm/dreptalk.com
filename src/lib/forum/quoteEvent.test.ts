import { describe, it, expect } from 'vitest';
import { QUOTE_EVENT, dispatchQuote } from './quoteEvent.js';

describe('quoteEvent', () => {
  it('uses the namespaced event name', () => {
    expect(QUOTE_EVENT).toBe('dreptalk:quote');
  });

  it('dispatches a CustomEvent carrying the detail', () => {
    const seen: Array<{ type: string; detail: unknown }> = [];
    const g = globalThis as unknown as { window?: unknown; CustomEvent?: unknown };
    const priorWindow = g.window;
    const priorCe = g.CustomEvent;
    if (!g.CustomEvent) {
      g.CustomEvent = class {
        type: string;
        detail: unknown;
        constructor(type: string, init?: { detail?: unknown }) {
          this.type = type;
          this.detail = init?.detail;
        }
      };
    }
    g.window = { dispatchEvent: (e: { type: string; detail: unknown }) => { seen.push({ type: e.type, detail: e.detail }); return true; } };

    const detail = { postId: 'p1', author: 'Lucas', text: 'hi', href: '/t/x#post-p1' };
    dispatchQuote(detail);

    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('dreptalk:quote');
    expect(seen[0].detail).toEqual(detail);

    g.window = priorWindow;
    g.CustomEvent = priorCe;
  });
});
