import { describe, it, expect } from 'vitest';
import { friendlyPairError } from './ApproveDevice.js';

describe('friendlyPairError', () => {
  it('handles unknown_code error', () => {
    expect(friendlyPairError('unknown_code')).toBe(
      'That code is not valid or has expired. Ask the device to show a new one.',
    );
  });

  it('handles rate_limited error', () => {
    expect(friendlyPairError('rate_limited')).toBe(
      'Too many attempts. Please wait a few minutes and try again.',
    );
  });

  it('handles unauthorized error', () => {
    expect(friendlyPairError('unauthorized')).toBe(
      'Your session has expired. Please sign in again.',
    );
  });

  it('handles forbidden error', () => {
    expect(friendlyPairError('forbidden')).toBe(
      'Could not complete this from here. Please reload and try again.',
    );
  });

  it('returns default message for unknown error', () => {
    expect(friendlyPairError('unknown_error_type')).toBe(
      'Could not complete this right now. Please try again.',
    );
  });

  it('returns default message when error is undefined', () => {
    expect(friendlyPairError(undefined)).toBe(
      'Could not complete this right now. Please try again.',
    );
  });
});
