import { describe, it, expect } from 'vitest';
import { reviewCardHtml } from './templates.js';
import { reviewCardModel } from './model.js';

describe('reviewCardHtml', () => {
  it('shows the eyebrow, title and figure with escaped text', () => {
    const html = reviewCardHtml(reviewCardModel({ epochFrom: 650, epochTo: 652, title: 'A <b> title', ogFigure: { value: '₳120M', label: 'largest single withdrawal' } }));
    expect(html).toContain('Governance Review · Epochs 650 to 652');
    expect(html).toContain('A &lt;b&gt; title');
    expect(html).toContain('₳120M');
    expect(html).toContain('largest single withdrawal');
  });
});
