import { describe, it, expect } from 'vitest';
import { parseSurveyRefInput } from './surveyRef.js';

const TX = 'ab'.repeat(32); // 64 hex chars
const UP = TX.toUpperCase();

describe('parseSurveyRefInput', () => {
  it('accepts the canonical <txId>:<index> form', () => {
    expect(parseSurveyRefInput(`${TX}:0`)).toEqual({ ok: true, txId: TX, index: 0 });
    expect(parseSurveyRefInput(`${TX}:12`)).toEqual({ ok: true, txId: TX, index: 12 });
  });

  it('lower-cases the transaction id and trims surrounding space', () => {
    expect(parseSurveyRefInput(`  ${UP}:3  `)).toEqual({ ok: true, txId: TX, index: 3 });
  });

  it('accepts a URL that ends in the ref, on any host, ignoring query and fragment', () => {
    expect(parseSurveyRefInput(`https://tessera.example/survey/${TX}:1?utm=x#frag`))
      .toEqual({ ok: true, txId: TX, index: 1 });
    expect(parseSurveyRefInput(`https://my-own-instance.test/s/${TX}:0`))
      .toEqual({ ok: true, txId: TX, index: 0 });
  });

  it('rejects a malformed transaction id', () => {
    expect(parseSurveyRefInput(`${'a'.repeat(63)}:0`).ok).toBe(false);
    expect(parseSurveyRefInput(`${'z'.repeat(64)}:0`).ok).toBe(false);
  });

  it('rejects a bad index', () => {
    expect(parseSurveyRefInput(`${TX}:`).ok).toBe(false);
    expect(parseSurveyRefInput(`${TX}:-1`).ok).toBe(false);
    expect(parseSurveyRefInput(`${TX}:01`).ok).toBe(false); // leading zero is not canonical
    expect(parseSurveyRefInput(`${TX}:1.5`).ok).toBe(false);
  });

  it('rejects empty and junk input', () => {
    expect(parseSurveyRefInput('').ok).toBe(false);
    expect(parseSurveyRefInput('not a ref').ok).toBe(false);
    expect(parseSurveyRefInput(TX).ok).toBe(false); // no index
  });

  it('explains why it rejected, for the form to show', () => {
    const r = parseSurveyRefInput('nonsense');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
  });
});
