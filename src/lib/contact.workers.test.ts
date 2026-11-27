/// <reference types="@cloudflare/workers-types" />
// The contact form submission end to end in workerd: honeypot, missing
// bindings, the per-IP rate limit on the real RateLimiter Durable Object,
// validation, and what reaches the send_email binding. The mailer is a fake
// that records its calls, so nothing is sent.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { CONTACT_HONEYPOT_FIELD, submitContact, type ContactDeps } from './contact.js';

type SendArg = Parameters<SendEmail['send']>[0];

function fakeMailer(fail = false) {
  const sent: SendArg[] = [];
  return {
    sent,
    send: async (message: SendArg) => {
      if (fail) throw new Error('delivery failed');
      sent.push(message);
      return { messageId: `m-${sent.length}` };
    },
  };
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const valid = { email: 'someone@example.org', name: 'Some One', message: 'Hello there.' };

// Unique client IP per test, so a rate-limit window never carries over.
let seq = 0;
const ip = () => `198.51.100.${++seq}`;

function deps(mailer: ReturnType<typeof fakeMailer>, extra: Partial<ContactDeps> = {}): ContactDeps {
  return {
    rateLimiter: env.RATE_LIMITER,
    mailer,
    to: 'hello@dreptalk.com',
    from: 'noreply@send.dreptalk.com',
    now: 1_000_000,
    ...extra,
  };
}

describe('submitContact', () => {
  it('sends a valid message to the contact address with reply_to set to the sender', async () => {
    const mailer = fakeMailer();
    const result = await submitContact(form(valid), ip(), deps(mailer));
    expect(result).toEqual({ status: 'sent' });
    expect(mailer.sent).toHaveLength(1);
    const [message] = mailer.sent as (SendArg & { to: string; replyTo: unknown; text: string; from: unknown })[];
    expect(message.to).toBe('hello@dreptalk.com');
    expect(message.from).toEqual({ email: 'noreply@send.dreptalk.com', name: 'DRepTalk' });
    expect(message.replyTo).toEqual({ email: 'someone@example.org', name: 'Some One' });
    expect(message.subject).toBe('Contact form: Some One');
    expect(message.text).toContain('Hello there.');
  });

  it('uses the bare address as reply_to and subject when no name is given', async () => {
    const mailer = fakeMailer();
    await submitContact(form({ ...valid, name: '' }), ip(), deps(mailer));
    const [message] = mailer.sent as (SendArg & { replyTo: unknown })[];
    expect(message.replyTo).toBe('someone@example.org');
    expect(message.subject).toBe('Contact form: someone@example.org');
  });

  it('answers a filled honeypot with success and sends nothing', async () => {
    const mailer = fakeMailer();
    const result = await submitContact(form({ ...valid, [CONTACT_HONEYPOT_FIELD]: 'https://spam.example' }), ip(), deps(mailer));
    expect(result).toEqual({ status: 'sent' });
    expect(mailer.sent).toHaveLength(0);
  });

  it('returns field errors and the entered values for an invalid submission, without sending', async () => {
    const mailer = fakeMailer();
    const result = await submitContact(form({ email: 'not-an-address', message: '' }), ip(), deps(mailer));
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(Object.keys(result.errors).sort()).toEqual(['email', 'message']);
    expect(result.fields.email).toBe('not-an-address');
    expect(mailer.sent).toHaveLength(0);
  });

  it('limits one client to five messages an hour, independent of other clients', async () => {
    const mailer = fakeMailer();
    const client = ip();
    for (let i = 0; i < 5; i++) {
      expect((await submitContact(form(valid), client, deps(mailer))).status).toBe('sent');
    }
    expect((await submitContact(form(valid), client, deps(mailer))).status).toBe('rate_limited');
    expect(mailer.sent).toHaveLength(5);

    // Another client is unaffected, and the same client may write again an hour later.
    expect((await submitContact(form(valid), ip(), deps(mailer))).status).toBe('sent');
    const later = deps(mailer, { now: 1_000_000 + 3_600_000 });
    expect((await submitContact(form(valid), client, later)).status).toBe('sent');
  });

  it('counts invalid submissions against the limit too', async () => {
    const mailer = fakeMailer();
    const client = ip();
    for (let i = 0; i < 5; i++) {
      expect((await submitContact(form({ email: 'x' }), client, deps(mailer))).status).toBe('invalid');
    }
    expect((await submitContact(form(valid), client, deps(mailer))).status).toBe('rate_limited');
  });

  it('is unavailable without the mail binding, the rate limiter, or a recipient', async () => {
    const mailer = fakeMailer();
    for (const extra of [{ mailer: undefined }, { rateLimiter: undefined }, { to: '' }, { from: undefined }]) {
      const result = await submitContact(form(valid), ip(), deps(mailer, extra));
      expect(result.status).toBe('unavailable');
    }
    expect(mailer.sent).toHaveLength(0);
  });

  it('reports a failed delivery and keeps the entered values', async () => {
    const result = await submitContact(form(valid), ip(), deps(fakeMailer(true)));
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.fields.message).toBe('Hello there.');
  });
});
