import { describe, it, expect } from 'vitest';
import { isWriter, isModerator, roleLabels, rolesFromUser } from './roles.js';

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

describe('roleLabels', () => {
  it('maps each role to its display label', () => {
    expect(roleLabels(['drep'])).toEqual(['DRep']);
    expect(roleLabels(['spo'])).toEqual(['SPO']);
    expect(roleLabels(['cc'])).toEqual(['CC']);
    expect(roleLabels(['proposer'])).toEqual(['Proposer']);
    expect(roleLabels(['admin'])).toEqual(['Admin']);
    expect(roleLabels(['moderator'])).toEqual(['Moderator']);
    expect(roleLabels(['member'])).toEqual(['Member']);
  });

  it('lists all known roles in priority order (identity before moderation)', () => {
    expect(roleLabels(['admin', 'drep'])).toEqual(['DRep', 'Admin']);
    expect(roleLabels(['proposer', 'drep', 'moderator'])).toEqual(['DRep', 'Proposer', 'Moderator']);
    expect(roleLabels(['member', 'proposer'])).toEqual(['Proposer', 'Member']);
  });

  it('falls back to [Member] when nothing known is present', () => {
    expect(roleLabels([])).toEqual(['Member']);
    expect(roleLabels(['something-unknown'])).toEqual(['Member']);
  });
});

describe('rolesFromUser', () => {
  const none = { is_drep: false, is_proposer: false, is_spo: false, is_cc: false };

  it('maps each on-chain flag to its role', () => {
    expect(rolesFromUser({ ...none, is_drep: true }, null)).toEqual(['drep']);
    expect(rolesFromUser({ ...none, is_proposer: true }, null)).toEqual(['proposer']);
    expect(rolesFromUser({ ...none, is_spo: true }, null)).toEqual(['spo']);
    expect(rolesFromUser({ ...none, is_cc: true }, null)).toEqual(['cc']);
  });

  it('preserves the drep, proposer, spo, cc order for multi-role accounts', () => {
    expect(rolesFromUser({ is_drep: true, is_proposer: true, is_spo: true, is_cc: true }, null)).toEqual([
      'drep',
      'proposer',
      'spo',
      'cc',
    ]);
  });

  it('appends the moderator role when present', () => {
    expect(rolesFromUser({ ...none, is_drep: true }, 'moderator')).toEqual(['drep', 'moderator']);
  });

  it('falls back to member when nothing else applies', () => {
    expect(rolesFromUser(none, null)).toEqual(['member']);
  });
});
