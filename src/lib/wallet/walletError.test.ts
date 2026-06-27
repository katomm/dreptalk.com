import { describe, it, expect } from 'vitest';
import { staleInputsMessage, readableError } from './walletError.js';

const STALE = 'Your previous transaction is still confirming. Please wait about 20 seconds, then try again.';

describe('staleInputsMessage', () => {
  it('matches the node code 3997 rejection', () => {
    expect(staleInputsMessage({ code: 3997, info: 'whatever' })).toBe(STALE);
  });

  it('matches the "All inputs are spent" message', () => {
    const err = { info: 'All inputs are spent. Transaction has probably already been included' };
    expect(staleInputsMessage(err)).toBe(STALE);
  });

  it('matches a BadInputsUTxO ledger rejection', () => {
    expect(staleInputsMessage(new Error('ValueNotConservedUTxO BadInputsUTxO'))).toBe(STALE);
  });

  it('returns null for unrelated errors', () => {
    expect(staleInputsMessage(new Error('User declined to sign'))).toBeNull();
    expect(staleInputsMessage({ code: 2, info: 'User rejected' })).toBeNull();
  });
});

describe('readableError', () => {
  it('returns the stale-inputs message for a double-submit rejection', () => {
    expect(readableError({ code: 3997, info: 'All inputs are spent.' })).toBe(STALE);
  });

  it('sentence-cases and punctuates other wallet errors', () => {
    expect(readableError({ info: 'user declined' })).toBe('User declined.');
  });

  it('falls back when no detail is present', () => {
    expect(readableError({})).toBe('Something went wrong. Please try again.');
  });
});
