// POST /api/notifications/prefs: sets one event-type pref for one of the
// signed-in user's channel kinds (e.g. mute 'mention' on 'webpush').
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { setPref, NOTIFICATION_EVENT_TYPES } from '@/lib/db/notificationChannels';

export const prerender = false;

const schema = z.object({
  channel: z.literal('webpush'),
  eventType: z.enum(NOTIFICATION_EVENT_TYPES),
  enabled: z.boolean(),
});

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as App.Locals).user;
  if (!user) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }
  const db = runtimeEnv(locals as App.Locals).DB as D1Database | undefined;
  if (!db) {
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'invalid JSON' }, 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return jsonResponse({ ok: false, error: 'invalid input' }, 400);
  }

  await setPref(db, {
    userId: user.id,
    channel: parsed.data.channel,
    eventType: parsed.data.eventType,
    enabled: parsed.data.enabled,
  });
  return jsonResponse({ ok: true });
};
