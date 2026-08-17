import { describe, it, expect } from 'vitest';
import { parseDrepEventPayload } from './notifyPayload.js';

describe('parseDrepEventPayload', () => {
  it('parses a valid vote-event payload (gaId + title)', () => {
    const raw = JSON.stringify({ sourceTime: 1_700_000_000, gaId: 'ga1abc', title: 'Reduce fees' });
    expect(parseDrepEventPayload(raw)).toEqual({ sourceTime: 1_700_000_000, gaId: 'ga1abc', title: 'Reduce fees' });
  });

  it('parses a valid vote-event payload with a null title (title omitted from result)', () => {
    const raw = JSON.stringify({ sourceTime: 1_700_000_000, gaId: 'ga1abc', title: null });
    expect(parseDrepEventPayload(raw)).toEqual({ sourceTime: 1_700_000_000, gaId: 'ga1abc' });
  });

  it('parses the cast choice when the payload carries one', () => {
    const raw = JSON.stringify({ sourceTime: 1_700_000_000, gaId: 'ga1abc', title: 'Reduce fees', vote: 'Yes' });
    expect(parseDrepEventPayload(raw)).toEqual({ sourceTime: 1_700_000_000, gaId: 'ga1abc', title: 'Reduce fees', vote: 'Yes' });
  });

  it('omits a non-string or empty vote from the result', () => {
    expect(parseDrepEventPayload(JSON.stringify({ sourceTime: 1, gaId: 'ga1', vote: 7 }))).toEqual({ sourceTime: 1, gaId: 'ga1' });
    expect(parseDrepEventPayload(JSON.stringify({ sourceTime: 1, gaId: 'ga1', vote: '' }))).toEqual({ sourceTime: 1, gaId: 'ga1' });
  });

  it('parses a valid vote-event payload with extra fields ignored (sourceTimeApprox)', () => {
    const raw = JSON.stringify({ sourceTime: 1_700_000_000, gaId: 'ga1abc', title: 'Reduce fees', sourceTimeApprox: true });
    expect(parseDrepEventPayload(raw)).toEqual({ sourceTime: 1_700_000_000, gaId: 'ga1abc', title: 'Reduce fees' });
  });

  it('parses a valid status-event payload (drepId + from/to)', () => {
    const raw = JSON.stringify({
      sourceTime: 1_700_000_000,
      drepId: 'drep1xyz',
      from: { effective: 'active', status: 'active' },
      to: { effective: 'inactive', status: 'inactive' },
    });
    expect(parseDrepEventPayload(raw)).toEqual({
      sourceTime: 1_700_000_000,
      drepId: 'drep1xyz',
      from: { effective: 'active', status: 'active' },
      to: { effective: 'inactive', status: 'inactive' },
    });
  });

  it('drops a status-event payload missing `to`', () => {
    const raw = JSON.stringify({ sourceTime: 1, drepId: 'drep1xyz', from: { effective: 'active', status: 'active' } });
    expect(parseDrepEventPayload(raw)).toBeNull();
  });

  it('drops a status-event payload with a malformed `from`', () => {
    const raw = JSON.stringify({
      sourceTime: 1,
      drepId: 'drep1xyz',
      from: { effective: 'active' },
      to: { effective: 'inactive', status: 'inactive' },
    });
    expect(parseDrepEventPayload(raw)).toBeNull();
  });

  it('drops a payload missing sourceTime', () => {
    expect(parseDrepEventPayload(JSON.stringify({ gaId: 'ga1abc', title: 'x' }))).toBeNull();
  });

  it('drops a payload with neither gaId nor drepId', () => {
    expect(parseDrepEventPayload(JSON.stringify({ sourceTime: 1 }))).toBeNull();
  });

  it('drops an empty object', () => {
    expect(parseDrepEventPayload(JSON.stringify({}))).toBeNull();
  });

  it('drops syntactically invalid JSON', () => {
    expect(parseDrepEventPayload('not json')).toBeNull();
  });

  it('drops a null payload', () => {
    expect(parseDrepEventPayload(null)).toBeNull();
  });

  it('drops an empty string payload', () => {
    expect(parseDrepEventPayload('')).toBeNull();
  });

  it('never throws on odd top-level shapes (fuzz)', () => {
    const badShapes = ['42', 'true', 'null', '[]', '"just a string"', JSON.stringify({ sourceTime: 'not-a-number', gaId: 'ga1' })];
    for (const raw of badShapes) {
      expect(() => parseDrepEventPayload(raw)).not.toThrow();
      expect(parseDrepEventPayload(raw)).toBeNull();
    }
  });
});
