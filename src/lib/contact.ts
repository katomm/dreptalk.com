/// <reference types="@cloudflare/workers-types" />
// Contact form behind /contact/, the second fast contact channel the imprint
// links next to the email address. The page posts to itself, so the form
// works without JavaScript and every outcome renders inline on the page.
//
// Delivery goes through the Workers send_email binding (EMAIL): from the
// sending subdomain address in CONTACT_FROM_EMAIL, to the imprint contact
// address (LEGAL_CONTACT_EMAIL), with reply_to set to the sender so a reply
// from the inbox goes straight back to them.

import type { RateLimiter } from './rateLimiterDO.js';
import { checkRate } from './rate.js';

export const CONTACT_EMAIL_MAX = 254;
export const CONTACT_NAME_MAX = 100;
export const CONTACT_MESSAGE_MAX = 5000;

// Name of the honeypot field. Hidden from people and assistive technology, so
// only a bot fills it in. A filled honeypot is answered with the normal success
// state and nothing is sent, which gives the bot no signal to adapt to.
export const CONTACT_HONEYPOT_FIELD = 'website';

// Per-IP limit. A person writes once or twice, so five messages an hour leaves
// room for a correction while keeping a single client from flooding the inbox.
const RATE_MAX = 5;
const RATE_WINDOW_SEC = 3600;

// Deliberately loose: one @, something on both sides, a dot in the domain, no
// whitespace. The real check is whether a reply arrives.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ContactFields {
  email: string;
  name: string;
  message: string;
}

export type ContactFieldErrors = Partial<Record<keyof ContactFields, string>>;

export type ContactResult =
  | { status: 'sent' }
  | { status: 'invalid'; fields: ContactFields; errors: ContactFieldErrors }
  | { status: 'rate_limited'; fields: ContactFields }
  | { status: 'unavailable'; fields: ContactFields }
  | { status: 'failed'; fields: ContactFields };

/** What sending needs from the runtime. The page passes the real bindings, tests a fake mailer. */
export interface ContactDeps {
  rateLimiter?: DurableObjectNamespace<RateLimiter>;
  mailer?: Pick<SendEmail, 'send'>;
  /** Recipient, the imprint contact address. */
  to?: string;
  /** Sender address on the sending subdomain. */
  from?: string;
  now: number;
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

// Control characters (CR and LF included) never belong in a single-line field,
// and in the subject line they could only be an attempt at header injection.
function singleLine(value: string): string {
  return value.replace(/\p{Cc}+/gu, ' ').trim();
}

/** Reads and trims the three fields. Pure, exported for tests. */
export function readContactFields(form: FormData): ContactFields {
  return {
    email: singleLine(field(form, 'email')),
    name: singleLine(field(form, 'name')),
    // Line breaks are the point of a message, so only normalize them.
    message: field(form, 'message').replace(/\r\n?/g, '\n').trim(),
  };
}

/** Server-side validation, the same limits the form enforces in the browser. Pure, exported for tests. */
export function validateContactFields(fields: ContactFields): ContactFieldErrors {
  const errors: ContactFieldErrors = {};
  if (!fields.email) {
    errors.email = 'Please enter your email address.';
  } else if (fields.email.length > CONTACT_EMAIL_MAX || !EMAIL_RE.test(fields.email)) {
    errors.email = 'Please enter a valid email address.';
  }
  if (fields.name.length > CONTACT_NAME_MAX) {
    errors.name = `Please keep the name to ${CONTACT_NAME_MAX} characters.`;
  }
  if (!fields.message) {
    errors.message = 'Please enter a message.';
  } else if (fields.message.length > CONTACT_MESSAGE_MAX) {
    errors.message = `Please keep the message to ${CONTACT_MESSAGE_MAX} characters.`;
  }
  return errors;
}

/** True when the hidden honeypot field carries anything at all. */
export function isHoneypotFilled(form: FormData): boolean {
  return field(form, CONTACT_HONEYPOT_FIELD).trim() !== '';
}

/** Plain text body of the notification email. Exported for tests. */
export function contactEmailText(fields: ContactFields): string {
  return [
    `From: ${fields.name ? `${fields.name} <${fields.email}>` : fields.email}`,
    '',
    fields.message,
    '',
    '(Sent through the DRepTalk contact form. Reply to this email to answer the sender.)',
  ].join('\n');
}

/**
 * Handles one submission. Order: honeypot (silent success), bindings present,
 * per-IP rate limit, validation, send. The rate limit counts every submission
 * that reaches it, invalid ones too, so a script cannot probe without cost.
 */
export async function submitContact(form: FormData, clientIp: string, deps: ContactDeps): Promise<ContactResult> {
  if (isHoneypotFilled(form)) return { status: 'sent' };

  const fields = readContactFields(form);
  const to = deps.to?.trim();
  const from = deps.from?.trim();
  if (!deps.rateLimiter || !deps.mailer || !to || !from) {
    return { status: 'unavailable', fields };
  }

  const allowed = await checkRate(deps.rateLimiter, `contact:${clientIp}`, {
    max: RATE_MAX,
    windowSec: RATE_WINDOW_SEC,
    now: deps.now,
  });
  if (!allowed) return { status: 'rate_limited', fields };

  const errors = validateContactFields(fields);
  if (Object.keys(errors).length > 0) return { status: 'invalid', fields, errors };

  try {
    await deps.mailer.send({
      from: { email: from, name: 'DRepTalk' },
      to,
      replyTo: fields.name ? { email: fields.email, name: fields.name } : fields.email,
      subject: `Contact form: ${fields.name || fields.email}`,
      text: contactEmailText(fields),
    });
  } catch (err) {
    // Logs only that delivery failed, never the sender's data.
    console.error('contact form: send failed', err instanceof Error ? err.message : err);
    return { status: 'failed', fields };
  }
  return { status: 'sent' };
}
