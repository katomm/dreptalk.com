import { describe, it, expect } from 'vitest';
import { buildFaqLd } from './jsonld.js';

describe('buildFaqLd', () => {
  it('returns null for empty input', () => {
    expect(buildFaqLd([])).toBeNull();
    expect(buildFaqLd(undefined)).toBeNull();
  });

  it('builds a FAQPage with Question/Answer entries', () => {
    const ld = buildFaqLd([{ q: 'Q1', a: 'A1' }]) as Record<string, unknown>;
    expect(ld['@type']).toBe('FAQPage');
    const mainEntity = ld.mainEntity as Array<Record<string, unknown>>;
    expect(mainEntity[0]).toMatchObject({
      '@type': 'Question',
      name: 'Q1',
      acceptedAnswer: { '@type': 'Answer', text: 'A1' },
    });
  });

  it('drops inline code backticks from answers', () => {
    const ld = buildFaqLd([{ q: 'Q', a: 'Add it to `body.references`.' }]) as Record<string, unknown>;
    const mainEntity = ld.mainEntity as Array<Record<string, { text: string }>>;
    expect(mainEntity[0].acceptedAnswer.text).toBe('Add it to body.references.');
  });
});
