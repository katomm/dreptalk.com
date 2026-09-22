import type { APIRoute } from 'astro';
import { enhanceStoredHtml, renderMarkdown } from '@/lib/markdown.js';
import { resolveBodyMentions } from '@/lib/forum/handlers.js';
import { checkRate } from '@/lib/rate.js';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { INFO_RATIONALE_MAX } from '@/lib/governance/infoActionLimits.js';

export const prerender = false;

// The governance submit form previews its Markdown fields (abstract,
// motivation, rationale) in one round trip. Four is one more than it sends,
// so a fourth field can be added without touching the route.
const MAX_PARTS = 4;

// Exactly the widest metadata field the submit form accepts. One cap for every
// part, because the route does not know which field a key names, and no
// headroom above it: the form enforces the same number with maxLength, so
// anything longer did not come from the form.
const MAX_PART_LENGTH = INFO_RATIONALE_MAX;

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }

  const env = runtimeEnv(locals as App.Locals);
  const rateLimiter = env.RATE_LIMITER;

  // The rate limiter is required; 503 when unbound so preview stays throttled.
  if (!rateLimiter) {
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }

  const allowed = await checkRate(rateLimiter, `preview:${user.id}`, {
    max: 60,
    windowSec: 60,
    now: Date.now(),
  });
  if (!allowed) {
    return jsonResponse({ ok: false, error: 'rate_limited' }, 429);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'invalid JSON' }, 400);
  }

  // A literal `null` body is valid JSON and would otherwise be read through
  // below, so it is refused here rather than throwing on a property access.
  if (body === null) {
    return jsonResponse({ ok: false, error: 'invalid input' }, 400);
  }

  // Parts mode, used by the governance submit form's review modal: several
  // short Markdown fields rendered in one round trip, each returned under its
  // own key. Mentions are not resolved here (a CIP-108 document has none) and
  // enhanceStoredHtml runs, because the island injects this HTML as is while
  // the forum applies that pass itself at display time.
  const parts = (body as { parts?: unknown } | null)?.parts;
  if (parts !== undefined) {
    if (typeof parts !== 'object' || parts === null || Array.isArray(parts)) {
      return jsonResponse({ ok: false, error: 'invalid input' }, 400);
    }
    const entries = Object.entries(parts as Record<string, unknown>);
    if (entries.length > MAX_PARTS) {
      return jsonResponse({ ok: false, error: 'too many parts' }, 400);
    }
    // Null-prototype: the keys come from the request, and writing a key like
    // __proto__ onto a plain object hits the prototype setter instead of
    // creating an own property, so that part would silently vanish.
    const html: Record<string, string> = Object.create(null);
    for (const [key, value] of entries) {
      if (typeof value !== 'string') {
        return jsonResponse({ ok: false, error: 'invalid input' }, 400);
      }
      if (value.length > MAX_PART_LENGTH) {
        return jsonResponse({ ok: false, error: 'part too long' }, 400);
      }
      html[key] = enhanceStoredHtml(renderMarkdown(value.trim()));
    }
    return jsonResponse({ html });
  }

  const rawMd = typeof (body as { bodyMd?: unknown } | null)?.bodyMd === 'string'
    ? (body as { bodyMd: string }).bodyMd.trim()
    : '';

  if (rawMd.length > 20000) {
    return jsonResponse({ ok: false, error: 'body too long' }, 400);
  }

  // Resolve @mentions so the preview matches the stored rendering (display
  // name as link text). Skipped when the DB binding is absent; the preview
  // then simply shows plain @slug text.
  const db = env.DB as D1Database | undefined;
  const { mentions } = db
    ? await resolveBodyMentions(db, rawMd)
    : { mentions: new Map<string, never>() };
  const html = renderMarkdown(rawMd, { mentions });

  return jsonResponse({ html });
};
