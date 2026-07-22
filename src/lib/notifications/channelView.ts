// Shapes notification_channels rows for the settings islands: only fields the
// client may see. The stored subscription/chat id never leaves the server; a
// short SHA-256 fingerprint of the webpush endpoint lets the browser recognize
// its own subscription (it hashes its endpoint locally and compares).

import type { NotificationChannelRow } from '../db/notificationChannels.js';

export interface ClientChannel {
  id: string;
  channel: string;
  createdAt: number;
  /** Delivery cursor; equal to createdAt until the first successful send. */
  deliveredUntil: number;
  label: string | null;
  fingerprint: string | null;
}

const utf8 = new TextEncoder();

/** First 12 lowercase hex chars of SHA-256(endpoint). */
export async function endpointFingerprint(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8.encode(endpoint));
  return [...new Uint8Array(digest).slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Client-safe projection; fingerprints only webpush rows. */
export async function toClientChannels(rows: NotificationChannelRow[]): Promise<ClientChannel[]> {
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      channel: r.channel,
      createdAt: r.created_at,
      deliveredUntil: r.delivered_until,
      label: r.label,
      fingerprint: r.channel === 'webpush' ? await endpointFingerprint(r.endpoint) : null,
    })),
  );
}
