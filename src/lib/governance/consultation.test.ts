import { describe, it, expect } from 'vitest';
import { consultationFor, draftConsultationNote } from './consultation.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 16);

describe('consultation guardrails', () => {
  it('collects the rules and titles of the picked parameters', () => {
    expect(consultationFor(['k', 'tau'])).toBeNull();
    expect(consultationFor(['utxoCostPerByte'])).toEqual({ titles: ['UTxO cost per byte'], rules: ['PARAM-04a'] });
    expect(consultationFor(['minPoolCost', 'utxoCostPerByte'])).toEqual({
      titles: ['Minimum pool cost', 'UTxO cost per byte'],
      rules: ['PARAM-06a', 'PARAM-04a'],
    });
  });
});

describe('draftConsultationNote', () => {
  it('says nothing when no picked parameter carries the guardrail', () => {
    expect(draftConsultationNote(['k'], null, NOW)).toBeNull();
  });

  it('points out that no draft is linked', () => {
    const note = draftConsultationNote(['utxoCostPerByte'], null, NOW);
    expect(note).toContain('(PARAM-04a)');
    expect(note).toMatch(/No Proposal Draft/);
  });

  it('gives the age of a draft younger than 90 days', () => {
    const note = draftConsultationNote(['minPoolCost', 'utxoCostPerByte'], { createdAt: NOW - 12 * DAY - 1000 }, NOW);
    expect(note).toMatch(/12 days ago/);
    expect(note).toMatch(/normally pass/);
    expect(note).toContain('(PARAM-06a, PARAM-04a)');
    expect(draftConsultationNote(['utxoCostPerByte'], { createdAt: NOW - DAY }, NOW)).toMatch(/^Your linked draft was published 1 day ago\./);
    expect(draftConsultationNote(['utxoCostPerByte'], { createdAt: NOW - 1000 }, NOW)).toMatch(/^Your linked draft was published today\./);
  });

  it('confirms a draft that is at least 90 days old', () => {
    const note = draftConsultationNote(['utxoCostPerByte'], { createdAt: NOW - 104 * DAY }, NOW);
    expect(note).toMatch(/104 days ago/);
    expect(note).not.toMatch(/normally pass/);
    expect(note).toContain('(PARAM-04a)');
  });

  it('leaves out the age when the linked draft is not in the open list', () => {
    const note = draftConsultationNote(['utxoCostPerByte'], { createdAt: null }, NOW);
    expect(note).toContain('(PARAM-04a)');
    expect(note).not.toMatch(/ago|today|No Proposal Draft/);
  });
});
