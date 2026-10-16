import { describe, it, expect } from 'vitest';
import { PARAM_KEYS, PARAM_DEFS } from './paramDefs.js';
import { CONSULTATION_DAYS, consultationFor, draftConsultationNote } from './consultation.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 16);

describe('consultation guardrails', () => {
  it('flags exactly the parameters in the two critical lists of constitution section 2.1', () => {
    const flagged = PARAM_KEYS.filter((key) => PARAM_DEFS[key].consultation !== null);
    expect(flagged.map((key) => [key, PARAM_DEFS[key].consultation])).toEqual([
      ['minPoolCost', 'PARAM-06a'],
      ['utxoCostPerByte', 'PARAM-04a'],
    ]);
    expect(CONSULTATION_DAYS).toBe(90);
  });

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
    expect(draftConsultationNote(['utxoCostPerByte'], null, NOW)).toBe(
      'The constitution asks that at least 90 days normally pass between publishing an off-chain proposal to change UTxO cost per byte and submitting it on chain (PARAM-04a). No Proposal Draft is linked yet.',
    );
  });

  it('gives the age of a draft younger than 90 days', () => {
    expect(draftConsultationNote(['minPoolCost', 'utxoCostPerByte'], { createdAt: NOW - 12 * DAY - 1000 }, NOW)).toBe(
      'Your linked draft was published 12 days ago. The constitution asks that at least 90 days normally pass between publishing an off-chain proposal to change minimum pool cost and UTxO cost per byte and submitting it on chain (PARAM-06a, PARAM-04a).',
    );
    expect(draftConsultationNote(['utxoCostPerByte'], { createdAt: NOW - DAY }, NOW)).toMatch(/^Your linked draft was published 1 day ago\./);
    expect(draftConsultationNote(['utxoCostPerByte'], { createdAt: NOW - 1000 }, NOW)).toMatch(/^Your linked draft was published today\./);
  });

  it('confirms a draft that is at least 90 days old', () => {
    expect(draftConsultationNote(['utxoCostPerByte'], { createdAt: NOW - 104 * DAY }, NOW)).toBe(
      'Your linked draft was published 104 days ago, at least the 90 days the constitution asks for (PARAM-04a).',
    );
  });

  it('leaves out the age when the linked draft is not in the open list', () => {
    expect(draftConsultationNote(['utxoCostPerByte'], { createdAt: null }, NOW)).toBe(
      'The constitution asks that at least 90 days normally pass between publishing an off-chain proposal to change UTxO cost per byte and submitting it on chain (PARAM-04a).',
    );
  });
});
