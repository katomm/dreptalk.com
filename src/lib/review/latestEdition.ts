// The newest live Governance Review edition as the gov-sync cron reads it. The
// editions are bundled into the app worker only, so the cron asks the app
// through a service binding (GET /api/review/latest.json) instead of guessing
// from its own bundle: what the app answers is by definition live, so an
// announcement never points at a page that is not deployed yet.
import type { LatestEdition } from '../db/reviewAnnouncements.js';
import { parseSlug } from './windows.js';

/** The part of a service binding (Fetcher) this module uses; tests pass a stub. */
export interface SiteFetcher {
  fetch(input: string): Promise<Response>;
}

export const LATEST_EDITION_PATH = '/api/review/latest.json';

/** Strict shape check of the endpoint body; anything off is null. */
export function parseLatestEdition(raw: unknown): LatestEdition | null {
  if (!raw || typeof raw !== 'object') return null;
  const { edition, slug, title } = raw as Record<string, unknown>;
  if (typeof edition !== 'number' || !Number.isInteger(edition) || edition < 1) return null;
  if (typeof slug !== 'string' || !parseSlug(slug)) return null;
  if (typeof title !== 'string' || title.trim() === '') return null;
  return { edition, slug, title };
}

/**
 * Null when the app has no edition (404). Any other failure throws, so the
 * cron phase records it instead of reading as a quiet run.
 */
export async function fetchLatestEdition(site: SiteFetcher, origin: string): Promise<LatestEdition | null> {
  const res = await site.fetch(`${origin}${LATEST_EDITION_PATH}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`latest edition endpoint answered ${res.status}`);
  const parsed = parseLatestEdition(await res.json());
  if (!parsed) throw new Error('latest edition endpoint returned a malformed body');
  return parsed;
}
