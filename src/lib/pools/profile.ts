// Pure view-model helpers for the SPO (pool) profile. No I/O. Mirrors
// src/lib/dreps/profile.ts so pool and DRep profiles behave identically.
import { truncateId } from '../forum/view.js';

/** Canonical profile path for a pool: the slug when assigned, else the raw id. */
export function poolPath(p: { poolId: string; slug?: string | null }): string {
  return `/spos/${p.slug ?? p.poolId}/`;
}

/** True when the requested segment is already canonical; the route 301s otherwise. */
export function isCanonicalPoolParam(p: { poolId: string; slug?: string | null }, param: string): boolean {
  return param === (p.slug ?? p.poolId);
}

/** Display name in precedence order: full name, then ticker, then a truncated id. */
export function poolDisplayName(p: { name: string | null; ticker: string | null; poolId: string }): string {
  return p.name ?? p.ticker ?? truncateId(p.poolId, 18);
}
