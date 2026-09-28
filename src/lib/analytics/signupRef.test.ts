import { describe, it, expect } from 'vitest';
import { parseSignupRef, refFromUrl } from './signupRef.js';

describe('parseSignupRef', () => {
  it('accepts the closed vocabulary', () => {
    expect(parseSignupRef('delegate-dialog')).toBe('delegate-dialog');
    expect(parseSignupRef('match')).toBe('match');
    expect(parseSignupRef('drep-link:adatainment')).toBe('drep-link:adatainment');
    expect(parseSignupRef(`drep-link:${'a'.repeat(40)}`)).toBe(`drep-link:${'a'.repeat(40)}`);
  });

  it('rejects everything else', () => {
    expect(parseSignupRef('javascript:alert(1)')).toBeNull();
    expect(parseSignupRef('DELEGATE-DIALOG')).toBeNull();
    expect(parseSignupRef(`drep-link:${'a'.repeat(41)}`)).toBeNull();
    expect(parseSignupRef('drep-link:Not_A_Handle')).toBeNull();
    expect(parseSignupRef('drep-link:')).toBeNull();
    expect(parseSignupRef('/etc/passwd')).toBeNull();
    expect(parseSignupRef('a'.repeat(300))).toBeNull();
    expect(parseSignupRef(undefined)).toBeNull();
    expect(parseSignupRef(42)).toBeNull();
    expect(parseSignupRef('')).toBeNull();
  });
});

describe('refFromUrl', () => {
  it('reads and validates the ref of the current page', () => {
    expect(refFromUrl('?ref=drep-link:adatainment')).toBe('drep-link:adatainment');
    expect(refFromUrl('?foo=1&ref=match')).toBe('match');
  });

  it('returns null for a missing or hostile value', () => {
    expect(refFromUrl('')).toBeNull();
    expect(refFromUrl('?ref=%2Fetc%2Fpasswd')).toBeNull();
    expect(refFromUrl('?ref=<script>')).toBeNull();
  });
});
