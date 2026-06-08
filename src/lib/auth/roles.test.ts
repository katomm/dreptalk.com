import { describe, it, expect } from 'vitest';
import { isWriter, isModerator, roleLabel, roleLabels } from './roles.js';

describe('isWriter', () => {
  it('is true for each on-chain writer role', () => {
    expect(isWriter(['drep'])).toBe(true);
    expect(isWriter(['spo'])).toBe(true);
    expect(isWriter(['cc'])).toBe(true);
    expect(isWriter(['proposer'])).toBe(true);
  });

  it('is true when a writer role is present among others', () => {
    expect(isWriter(['member', 'proposer'])).toBe(true);
  });

  it('is false for non-writer roles and empty input', () => {
    expect(isWriter(['member'])).toBe(false);
    expect(isWriter(['admin'])).toBe(false);
    expect(isWriter(['moderator'])).toBe(false);
    expect(isWriter([])).toBe(false);
  });
});

describe('isModerator', () => {
  it('is true for admin or moderator', () => {
    expect(isModerator(['admin'])).toBe(true);
    expect(isModerator(['moderator'])).toBe(true);
    expect(isModerator(['drep', 'moderator'])).toBe(true);
  });

  it('is false for writer-only and empty input', () => {
    expect(isModerator(['drep'])).toBe(false);
    expect(isModerator(['member'])).toBe(false);
    expect(isModerator([])).toBe(false);
  });
});

describe('roleLabel', () => {
  it('maps each role to its display label', () => {
    expect(roleLabel(['drep'])).toBe('DRep');
    expect(roleLabel(['spo'])).toBe('SPO');
    expect(roleLabel(['cc'])).toBe('CC');
    expect(roleLabel(['proposer'])).toBe('Proposer');
    expect(roleLabel(['admin'])).toBe('Admin');
    expect(roleLabel(['moderator'])).toBe('Moderator');
    expect(roleLabel(['member'])).toBe('Member');
  });

  it('shows the governance identity role before moderation when both are held', () => {
    expect(roleLabel(['admin', 'drep'])).toBe('DRep');
    expect(roleLabel(['proposer', 'drep'])).toBe('DRep'); // drep outranks proposer
    expect(roleLabel(['member', 'proposer'])).toBe('Proposer');
  });

  it('falls back to Member for empty or unknown roles', () => {
    expect(roleLabel([])).toBe('Member');
    expect(roleLabel(['something-unknown'])).toBe('Member');
  });
});

describe('roleLabels', () => {
  it('lists all known roles in priority order', () => {
    expect(roleLabels(['admin', 'drep'])).toEqual(['DRep', 'Admin']);
    expect(roleLabels(['proposer', 'drep', 'moderator'])).toEqual(['DRep', 'Proposer', 'Moderator']);
  });

  it('falls back to [Member] when nothing known is present', () => {
    expect(roleLabels([])).toEqual(['Member']);
    expect(roleLabels(['xyz'])).toEqual(['Member']);
  });
});
