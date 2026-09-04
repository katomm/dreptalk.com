import { describe, it, expect } from 'vitest';
import {
  CATEGORIES,
  GOVERNANCE_CATEGORY_SLUG,
  getCategories,
  getCategory,
  isDiscussion,
} from './categories';

describe('categories config', () => {
  it('all slugs are unique', () => {
    const slugs = CATEGORIES.map((c) => c.slug);
    const unique = new Set(slugs);
    expect(unique.size).toBe(slugs.length);
  });

  it('exactly one governance kind exists and it matches GOVERNANCE_CATEGORY_SLUG', () => {
    const govCategories = CATEGORIES.filter((c) => c.kind === 'governance');
    expect(govCategories).toHaveLength(1);
    expect(govCategories[0].slug).toBe(GOVERNANCE_CATEGORY_SLUG);
  });

  it('getCategories returns categories sorted ascending by position', () => {
    const sorted = getCategories({ surveys: true });
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].position).toBeGreaterThan(sorted[i - 1].position);
    }
  });

  it('the survey kind is listed only where the switch is on', () => {
    const kinds = (on: boolean) => getCategories({ surveys: on }).map((c) => c.kind);
    expect(kinds(true)).toContain('survey');
    expect(kinds(false)).not.toContain('survey');
    expect(getCategories({ surveys: false })).toHaveLength(CATEGORIES.length - 1);
  });

  it('getCategory returns undefined for unknown slug', () => {
    expect(getCategory('nope')).toBeUndefined();
  });

  it('isDiscussion returns false for governance-actions', () => {
    expect(isDiscussion('governance-actions')).toBe(false);
  });

  it('isDiscussion returns true for general', () => {
    expect(isDiscussion('general')).toBe(true);
  });
});
