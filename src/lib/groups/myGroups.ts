/// <reference types="@cloudflare/workers-types" />
// The account menu's link to the signed-in DRep's groups: the group page for one group, the group
// list for several. Read once per request and only where groups run, the menu renders on every
// page.
import { runtimeEnv } from '../api/response.js';
import { refFromCols } from './codec.js';
import { drepGroupsAvailable } from './gate.js';
import { groupIdString } from './ids.js';
import type { CardanoNetwork } from '../config/network.js';
import { Q } from './store/queries.js';

/** The link for the groups a DRep belongs to or asked to join, null for none. */
export async function myGroupsHref(db: D1Database, drepId: string): Promise<string | null> {
  const res = await db.prepare(Q.drepMemberships.sql).bind(drepId, 2).all<Record<string, unknown>>();
  const rows = res.results ?? [];
  if (rows.length === 0) return null;
  return rows.length === 1 ? `/groups/${groupIdString(refFromCols(rows[0].group_tx, rows[0].group_ix))}/` : '/groups/';
}

/** The menu entry, memoized on the request. A failed read leaves the entry out. */
export function myGroupsLink(locals: App.Locals, network: CardanoNetwork, drepId: string | null | undefined): Promise<{ href: string; label: string } | null> {
  if (!drepId || !drepGroupsAvailable(network)) return Promise.resolve(null);
  if (!locals.myGroups) {
    const db = runtimeEnv(locals).DB as D1Database | undefined;
    locals.myGroups = db
      ? myGroupsHref(db, drepId)
          .then((href) => (href ? { href, label: 'My groups' } : null))
          .catch(() => null)
      : Promise.resolve(null);
  }
  return locals.myGroups;
}
