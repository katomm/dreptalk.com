import { describe, it, expect } from 'vitest';
import { DRAFT_OPENING_BODY_MAX, POST_BODY_MAX, maxPostBody, plainTextLength } from './postLimits';

describe('maxPostBody', () => {
  it('gives only a Proposal Drafts opening post the long cap', () => {
    expect(maxPostBody('proposal-drafts', true)).toBe(DRAFT_OPENING_BODY_MAX);
    expect(maxPostBody('proposal-drafts', false)).toBe(POST_BODY_MAX);
    expect(maxPostBody('general', true)).toBe(POST_BODY_MAX);
    expect(maxPostBody(undefined, true)).toBe(POST_BODY_MAX);
  });
});

describe('plainTextLength', () => {
  it('counts text, not markup', () => {
    expect(plainTextLength('<h2>Summary</h2>\n<p>Two  words</p>')).toBe('Summary Two words'.length);
  });
});
