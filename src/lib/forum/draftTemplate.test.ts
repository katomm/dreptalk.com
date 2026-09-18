import { describe, it, expect } from 'vitest';
import { DRAFT_TEMPLATE, initialDraftBody } from './draftTemplate';
import { renderMarkdown } from '../markdown';

describe('draft template', () => {
  it('prefills only a new topic in proposal-drafts', () => {
    expect(initialDraftBody('topic', 'proposal-drafts')).toBe(DRAFT_TEMPLATE);
    expect(initialDraftBody('topic', 'general')).toBe('');
    expect(initialDraftBody('post', 'proposal-drafts')).toBe('');
    expect(initialDraftBody('topic')).toBe('');
  });

  it('renders its headings and drops the hint comments', () => {
    const html = renderMarkdown(DRAFT_TEMPLATE);
    expect(html).toContain('<h2');
    expect(html).toContain('Requested amount');
    expect(html).not.toContain('<!--');
    expect(html).not.toContain('Treasury withdrawals only');
  });
});
