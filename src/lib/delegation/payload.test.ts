import { describe, it, expect } from 'vitest';
import { parseDelegationChangePayload } from './payload.js';

describe('parseDelegationChangePayload', () => {
  it('parses a valid payload with from and to', () => {
    const raw = JSON.stringify({ from: { type: 'none' }, to: { type: 'abstain' } });
    expect(parseDelegationChangePayload(raw)).toEqual({ from: { type: 'none' }, to: { type: 'abstain' } });
  });

  it('parses a valid payload with from: null (baseline had no prior state)', () => {
    const raw = JSON.stringify({ from: null, to: { type: 'no_confidence' } });
    expect(parseDelegationChangePayload(raw)).toEqual({ from: null, to: { type: 'no_confidence' } });
  });

  it('parses a valid drep `to` with a drepId', () => {
    const raw = JSON.stringify({ from: null, to: { type: 'drep', drepId: 'drep1abc' } });
    expect(parseDelegationChangePayload(raw)).toEqual({ from: null, to: { type: 'drep', drepId: 'drep1abc' } });
  });

  it('drops an empty object (no `to` at all)', () => {
    expect(parseDelegationChangePayload(JSON.stringify({}))).toBeNull();
  });

  it('drops a payload with `to: null`', () => {
    expect(parseDelegationChangePayload(JSON.stringify({ to: null }))).toBeNull();
  });

  it('drops a payload with an unknown `to.type`', () => {
    expect(parseDelegationChangePayload(JSON.stringify({ to: { type: 'bogus' } }))).toBeNull();
  });

  it('drops a drep `to` missing drepId', () => {
    expect(parseDelegationChangePayload(JSON.stringify({ to: { type: 'drep' } }))).toBeNull();
  });

  it('drops syntactically invalid JSON', () => {
    expect(parseDelegationChangePayload('not json')).toBeNull();
  });

  it('drops a null payload', () => {
    expect(parseDelegationChangePayload(null)).toBeNull();
  });

  it('drops an empty string payload', () => {
    expect(parseDelegationChangePayload('')).toBeNull();
  });

  it('falls back to from: null when `from` is present but malformed', () => {
    const raw = JSON.stringify({ from: { type: 'bogus' }, to: { type: 'abstain' } });
    expect(parseDelegationChangePayload(raw)).toEqual({ from: null, to: { type: 'abstain' } });
  });
});
