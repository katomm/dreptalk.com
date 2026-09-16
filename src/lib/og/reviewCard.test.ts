import { describe, it, expect } from 'vitest';
import { reviewCardHtml, reviewIndexCardHtml } from './templates.js';
import { reviewCardModel, reviewIndexCardModel } from './model.js';

describe('reviewCardHtml', () => {
  it('shows the eyebrow, title and figure with escaped text', () => {
    const html = reviewCardHtml(reviewCardModel({ epochFrom: 650, epochTo: 652, title: 'A <b> title', ogFigure: { value: '₳120M', label: 'largest single withdrawal' } }));
    expect(html).toContain('Governance Review · Epochs 650 to 652');
    expect(html).toContain('A &lt;b&gt; title');
    expect(html).toContain('₳120M');
    expect(html).toContain('largest single withdrawal');
  });

  it('clamps a 200-character title so it never overflows the canvas', () => {
    const longTitle = 'A'.repeat(200);
    const model = reviewCardModel({ epochFrom: 650, epochTo: 652, title: longTitle, ogFigure: { value: '₳120M', label: 'largest single withdrawal' } });
    expect(model.title.length).toBeLessThanOrEqual(96);
    expect(model.title.endsWith('…')).toBe(true);
  });
});

describe('reviewIndexCardHtml', () => {
  it('leads with the newest edition title and closes on the two counters', () => {
    const html = reviewIndexCardHtml(
      reviewIndexCardModel({ latestTitle: 'A <b> headline', editionCount: 5, epochFrom: 636, epochTo: 652 }),
    );
    expect(html).toContain('Governance Review');
    expect(html).toContain('A &lt;b&gt; headline');
    expect(html).toContain('editions published');
    expect(html).toContain('636 to 652');
  });

  it('keeps the edition counter singular for a single edition', () => {
    const m = reviewIndexCardModel({ latestTitle: 'First', editionCount: 1, epochFrom: 650, epochTo: 652 });
    expect(m.stats[0]).toEqual({ value: '1', label: 'edition published' });
  });

  it('clamps a long headline so it never overflows the canvas', () => {
    const m = reviewIndexCardModel({ latestTitle: 'A'.repeat(200), editionCount: 5, epochFrom: 636, epochTo: 652 });
    expect(m.title.length).toBeLessThanOrEqual(96);
    expect(m.title.endsWith('…')).toBe(true);
  });
});
