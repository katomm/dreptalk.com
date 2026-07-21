// Node-env unit tests for the @mention autocomplete logic: trigger detection,
// candidate filtering/ranking, and insertion.
import { describe, it, expect } from 'vitest';
import {
  detectMentionQuery,
  filterCandidates,
  insertMention,
  MAX_SUGGESTIONS,
} from './mentionAutocomplete';
import type { MentionCandidate } from '../db/mentionCandidates';

const c = (slug: string, name: string, kind: 'drep' | 'pool' = 'drep'): MentionCandidate => ({ slug, name, kind });

describe('detectMentionQuery', () => {
  it('detects @ at start, after whitespace, parenthesis and quote-marker', () => {
    expect(detectMentionQuery('@al', 3)).toEqual({ start: 0, query: 'al' });
    expect(detectMentionQuery('hi @al', 6)).toEqual({ start: 3, query: 'al' });
    expect(detectMentionQuery('(@al', 4)).toEqual({ start: 1, query: 'al' });
    expect(detectMentionQuery('>@al', 4)).toEqual({ start: 1, query: 'al' });
    expect(detectMentionQuery('hi @', 4)).toEqual({ start: 3, query: '' });
  });

  it('rejects emails, mid-word @, and queries interrupted by other characters', () => {
    expect(detectMentionQuery('foo@al', 6)).toBeNull();
    expect(detectMentionQuery('hi @a l', 7)).toBeNull();
    expect(detectMentionQuery('hi @a.', 6)).toBeNull();
    expect(detectMentionQuery('no at here', 5)).toBeNull();
  });

  it('uses the caret position, not the end of the text', () => {
    expect(detectMentionQuery('hi @al rest', 6)).toEqual({ start: 3, query: 'al' });
    expect(detectMentionQuery('hi @al rest', 11)).toBeNull();
  });

  it('caps the query at 63 chars', () => {
    expect(detectMentionQuery(`@${'a'.repeat(64)}`, 65)).toBeNull();
  });
});

describe('filterCandidates', () => {
  const pool = [c('alice-drep', 'Alice'), c('bob', 'Bobby'), c('cardano-alice', 'Team Alice'), c('dave', 'Alison')];

  it('ranks slug prefix, then name prefix, then substring', () => {
    expect(filterCandidates(pool, 'ali').map((x) => x.slug)).toEqual([
      'alice-drep',    // slug prefix
      'dave',          // name prefix (Alison)
      'cardano-alice', // substring
    ]);
  });

  it('is case-insensitive and returns everything capped for an empty query', () => {
    expect(filterCandidates(pool, 'ALI')[0].slug).toBe('alice-drep');
    expect(filterCandidates(pool, '').length).toBe(4);
    const many = Array.from({ length: 20 }, (_, i) => c(`s${i}`, `Name ${i}`));
    expect(filterCandidates(many, '').length).toBe(MAX_SUGGESTIONS);
  });

  it('matches nothing gracefully', () => {
    expect(filterCandidates(pool, 'zzz')).toEqual([]);
  });
});

describe('insertMention', () => {
  it('replaces the active query with the canonical slug plus a space', () => {
    const out = insertMention('hi @al rest', { start: 3, query: 'al' }, 6, 'alice-drep');
    expect(out.text).toBe('hi @alice-drep  rest');
    expect(out.caret).toBe(3 + '@alice-drep '.length);
  });

  it('works at the end of the text', () => {
    const out = insertMention('hi @al', { start: 3, query: 'al' }, 6, 'alice-drep');
    expect(out.text).toBe('hi @alice-drep ');
    expect(out.caret).toBe(out.text.length);
  });
});
