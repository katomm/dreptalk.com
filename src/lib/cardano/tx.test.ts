// Tests for shared Cardano transaction metadata helpers (CIP-20 tag).
import { describe, it, expect } from 'vitest';
import * as TransactionMetadatum from '@evolution-sdk/evolution/TransactionMetadatum';
import { DREPTALK_CIP20_LABEL, dreptalkCip20Metadatum } from './tx.js';

describe('DREPTALK_CIP20_LABEL', () => {
  it('is the CIP-20 label 674n', () => {
    expect(DREPTALK_CIP20_LABEL).toBe(674n);
  });
});

describe('dreptalkCip20Metadatum', () => {
  it('returns a non-null TransactionMetadatum map without throwing', () => {
    const result = dreptalkCip20Metadatum();
    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
    // The CIP-20 body must be a Map (global JS Map).
    expect(result instanceof Map).toBe(true);
  });

  it('encodes { msg: ["dreptalk.com"] } correctly', () => {
    const result = dreptalkCip20Metadatum() as TransactionMetadatum.Map;

    // The map has exactly one entry keyed by the text "msg".
    const msgKey = TransactionMetadatum.text('msg');
    expect(result.has(msgKey)).toBe(true);

    const msgValue = result.get(msgKey);
    expect(Array.isArray(msgValue)).toBe(true);

    const list = msgValue as TransactionMetadatum.List;
    expect(list).toHaveLength(1);
    expect(list[0]).toBe('dreptalk.com');
  });
});
