import { describe, it, expect } from 'vitest';
import { parseApproverRoles } from './pairing.js';

describe('parseApproverRoles', () => {
  it('returns null only for a DB NULL, meaning unbounded (legacy)', () => {
    expect(parseApproverRoles(null)).toBeNull();
  });

  it('parses and normalizes a well-formed cap', () => {
    expect(parseApproverRoles(JSON.stringify(['member', 'drep']))).toEqual(['drep', 'member']);
  });

  it('drops non-string elements before normalizing', () => {
    expect(parseApproverRoles(JSON.stringify(['drep', 42, null, {}]))).toEqual(['drep']);
  });

  it('fails closed to [] (never to null) for invalid JSON', () => {
    expect(parseApproverRoles('{bad json')).toEqual([]);
  });

  it('fails closed to [] (never to null) for valid JSON that is not an array', () => {
    expect(parseApproverRoles(JSON.stringify({ roles: ['drep'] }))).toEqual([]);
  });
});
