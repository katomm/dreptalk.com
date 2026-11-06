/// <reference types="@cloudflare/workers-types" />
// The listing count rule of migration 0128 as test oracles: each DRep counts toward its oldest
// active membership only, by join position and then the group key.
import { comparePos, credKey, refKey } from 'drep-groups';
import type { DisplayProjection } from 'drep-groups/conformance';
import { expect } from 'vitest';

/** The counted members of every group with one, by refKey, from the library's display projection. */
export function expectedCounted(proj: DisplayProjection): Map<string, number> {
  const lead = new Map<string, DisplayProjection['instances'][number]>();
  for (const i of proj.instances) {
    if (i.state !== 'active') continue;
    const k = credKey(i.member);
    const cur = lead.get(k);
    const before =
      cur === undefined ||
      comparePos(i.joinedAt, cur.joinedAt) < 0 ||
      (comparePos(i.joinedAt, cur.joinedAt) === 0 &&
        (i.group.txHash < cur.group.txHash || (i.group.txHash === cur.group.txHash && i.group.index < cur.group.index)));
    if (before) lead.set(k, i);
  }
  const out = new Map<string, number>();
  for (const i of lead.values()) out.set(refKey(i.group), (out.get(refKey(i.group)) ?? 0) + 1);
  return out;
}

const n = async (db: D1Database, sql: string): Promise<number> => Number((await db.prepare(sql).first<{ n: number }>())?.n ?? 0);

// Each credential's oldest open instance, the lead the triggers must have stored.
const WANT = `SELECT cred, group_tx, group_ix FROM (
    SELECT cred, group_tx, group_ix, ROW_NUMBER() OVER (
      PARTITION BY cred ORDER BY joined_h, joined_ti, joined_ph, joined_ix, group_tx, group_ix) AS rn
    FROM drep_group_instances WHERE counted_as = 'open') WHERE rn = 1`;

/**
 * The stored leads and counted members agree with the stored counted_as caches at any time, also
 * while lazy closes are still running, and listed groups never outnumber the distinct DReps with an
 * open membership.
 */
export async function expectLeadsConsistent(db: D1Database): Promise<void> {
  const got = {
    missing: await n(db, `SELECT COUNT(*) AS n FROM (${WANT} EXCEPT SELECT cred, group_tx, group_ix FROM drep_group_leads)`),
    extra: await n(db, `SELECT COUNT(*) AS n FROM (SELECT cred, group_tx, group_ix FROM drep_group_leads EXCEPT ${WANT})`),
    miscounted: await n(
      db,
      `SELECT COUNT(*) AS n FROM drep_groups g WHERE g.counted_members <>
        (SELECT COUNT(*) FROM drep_group_leads l WHERE l.group_tx = g.group_tx AND l.group_ix = g.group_ix)`,
    ),
    orphaned: await n(
      db,
      `SELECT COUNT(*) AS n FROM drep_group_leads l
        WHERE NOT EXISTS (SELECT 1 FROM drep_groups g WHERE g.group_tx = l.group_tx AND g.group_ix = l.group_ix)`,
    ),
  };
  expect(got).toEqual({ missing: 0, extra: 0, miscounted: 0, orphaned: 0 });
  const listed = await n(db, 'SELECT COUNT(*) AS n FROM drep_groups WHERE counted_members >= 1');
  const dreps = await n(db, "SELECT COUNT(DISTINCT cred) AS n FROM drep_group_instances WHERE counted_as = 'open'");
  expect(listed).toBeLessThanOrEqual(dreps);
}
