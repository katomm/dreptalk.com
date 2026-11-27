// Pure parts of the contact form: field reading, validation, honeypot and the
// email body. The submission flow with the real rate limiter is covered in
// contact.workers.test.ts.
import { describe, it, expect } from 'vitest';
import {
  CONTACT_EMAIL_MAX,
  CONTACT_HONEYPOT_FIELD,
  CONTACT_MESSAGE_MAX,
  CONTACT_NAME_MAX,
  contactEmailText,
  isHoneypotFilled,
  readContactFields,
  validateContactFields,
} from './contact.js';

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const valid = { email: 'someone@example.org', name: 'Some One', message: 'Hello there.' };

describe('readContactFields', () => {
  it('trims the fields and treats missing ones as empty', () => {
    expect(readContactFields(form({ email: '  a@b.co ', message: ' hi ' }))).toEqual({
      email: 'a@b.co',
      name: '',
      message: 'hi',
    });
  });

  it('flattens line breaks and other control characters in the single-line fields', () => {
    const fields = readContactFields(form({ email: 'a@b.co', name: 'Eve\r\nBcc: x@y.z', message: 'x' }));
    expect(fields.name).toBe('Eve Bcc: x@y.z');
  });

  it('keeps line breaks in the message, normalized to LF', () => {
    expect(readContactFields(form({ email: 'a@b.co', message: 'one\r\ntwo\rthree' })).message).toBe('one\ntwo\nthree');
  });

  it('ignores a file sent in place of a text field', () => {
    const data = form({ message: 'x' });
    data.set('email', new Blob(['a@b.co']), 'email.txt');
    expect(readContactFields(data).email).toBe('');
  });
});

describe('validateContactFields', () => {
  it('accepts a complete submission, with or without a name', () => {
    expect(validateContactFields(valid)).toEqual({});
    expect(validateContactFields({ ...valid, name: '' })).toEqual({});
  });

  it('requires an email address and a message', () => {
    const errors = validateContactFields({ email: '', name: '', message: '' });
    expect(Object.keys(errors).sort()).toEqual(['email', 'message']);
  });

  it('rejects an email address without an @ or a dotted domain', () => {
    for (const email of ['plain', 'a@b', 'a b@c.de', '@c.de']) {
      expect(validateContactFields({ ...valid, email }).email).toBeDefined();
    }
  });

  it('holds every field to its cap, with no headroom above it', () => {
    const atCap = {
      email: `${'a'.repeat(CONTACT_EMAIL_MAX - 7)}@ex.org`,
      name: 'n'.repeat(CONTACT_NAME_MAX),
      message: 'm'.repeat(CONTACT_MESSAGE_MAX),
    };
    expect(atCap.email).toHaveLength(CONTACT_EMAIL_MAX);
    expect(validateContactFields(atCap)).toEqual({});

    const over = validateContactFields({
      email: `a${atCap.email}`,
      name: `${atCap.name}n`,
      message: `${atCap.message}m`,
    });
    expect(Object.keys(over).sort()).toEqual(['email', 'message', 'name']);
  });
});

describe('isHoneypotFilled', () => {
  it('is false for an empty or whitespace-only honeypot, true for anything else', () => {
    expect(isHoneypotFilled(form(valid))).toBe(false);
    expect(isHoneypotFilled(form({ ...valid, [CONTACT_HONEYPOT_FIELD]: '  ' }))).toBe(false);
    expect(isHoneypotFilled(form({ ...valid, [CONTACT_HONEYPOT_FIELD]: 'https://spam.example' }))).toBe(true);
  });
});

describe('contactEmailText', () => {
  it('names the sender and carries the message', () => {
    const text = contactEmailText(valid);
    expect(text).toContain('From: Some One <someone@example.org>');
    expect(text).toContain('Hello there.');
  });

  it('falls back to the bare address without a name', () => {
    expect(contactEmailText({ ...valid, name: '' })).toContain('From: someone@example.org\n');
  });
});
