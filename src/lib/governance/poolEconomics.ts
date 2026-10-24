/// <reference types="@cloudflare/workers-types" />
// Pool distribution for the parameter change impact panels. The gov-sync phase
// `pool-economics` reads it from Koios once per epoch and stores one D1 row,
// the routes only read that row. Active stake moves once per epoch. Relative
// imports only: the gov-sync bundle loads this module.
import { epochFromUnix, type NetworkConfig } from '../config/network.js';
import { KOIOS_PAGE_CAP, type PoolListRow } from '../koios/client.js';
import { basisEpoch, type BasisInput } from './basisEpoch.js';
import type { PoolEconomicsJson } from './paramImpact.js';

const MAX_PAGES = 20;

export interface PoolEconomicsKoios {
  poolList(offset: number): Promise<PoolListRow[]>;
  totals(): Promise<{
    epochNo: number;
    reservesLovelace: string;
    supplyLovelace: string | null;
  } | null>;
}

const toAda = (lovelace: string | null) => (lovelace && /^\d+$/.test(lovelace) ? Number(BigInt(lovelace) / 1_000_000n) : 0);

/** Null when the list is truncated (20 full pages) or the totals carry no supply. */
export async function readPoolEconomics(koios: PoolEconomicsKoios): Promise<PoolEconomicsJson | null> {
  const rows: PoolListRow[] = [];
  for (let pageNo = 0; ; pageNo++) {
    if (pageNo === MAX_PAGES) return null;
    const page = await koios.poolList(pageNo * KOIOS_PAGE_CAP);
    rows.push(...page);
    if (page.length < KOIOS_PAGE_CAP) break;
  }
  const totals = await koios.totals();
  if (!totals?.supplyLovelace) return null;
  const pools: [number, number, string][] = rows
    .filter((row) => row.active_stake && /^\d+$/.test(row.active_stake) && row.active_stake !== '0')
    .map((row) => [toAda(row.active_stake), toAda(row.pledge), row.fixed_cost && /^\d+$/.test(row.fixed_cost) ? row.fixed_cost : '0']);
  pools.sort((a, b) => b[0] - a[0]);
  return {
    epoch: totals.epochNo,
    supplyLovelace: totals.supplyLovelace,
    reservesLovelace: totals.reservesLovelace,
    pools,
  };
}

/** The newest stored distribution, or null before the first cron run. */
export async function loadPoolEconomics(db: D1Database): Promise<{ epoch: number; body: string } | null> {
  return db.prepare('SELECT epoch, body FROM pool_economics ORDER BY epoch DESC LIMIT 1').first<{ epoch: number; body: string }>();
}

/** Whether a distribution is stored for exactly this epoch. */
export async function hasPoolEconomicsEpoch(db: D1Database, epoch: number): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS present FROM pool_economics WHERE epoch = ?').bind(epoch).first();
  return row !== null;
}

/** The stored distribution of exactly this epoch, or null. */
export async function loadPoolEconomicsEpoch(db: D1Database, epoch: number): Promise<{ epoch: number; body: string } | null> {
  return db.prepare('SELECT epoch, body FROM pool_economics WHERE epoch = ?').bind(epoch).first<{ epoch: number; body: string }>();
}

/**
 * The epochs retention keeps besides the newest: the basis epoch of every
 * ParameterChange row, and every epoch from the oldest still open proposal's
 * submission on (null when none is open).
 */
export function poolEconomicsKeepEpochs(
  rows: readonly (BasisInput & { submittedEpoch: number | null })[],
): { basis: Set<number>; keepFrom: number | null } {
  const basis = new Set<number>();
  let keepFrom: number | null = null;
  for (const row of rows) {
    const epoch = basisEpoch(row);
    if (epoch !== null) basis.add(epoch);
    if ((row.status === 'active' || row.status === 'pending') && row.submittedEpoch !== null) {
      keepFrom = keepFrom === null ? row.submittedEpoch : Math.min(keepFrom, row.submittedEpoch);
    }
  }
  return { basis, keepFrom };
}

/** Epochs below the new one that no proposal needs. Empty when a read fails, so no row is lost. */
async function staleEpochs(db: D1Database, epoch: number): Promise<number[]> {
  try {
    const [actions, stored] = await Promise.all([
      db
        .prepare(
          "SELECT status, decided_epoch AS decidedEpoch, ratified_epoch AS ratifiedEpoch, enacted_epoch AS enactedEpoch, expiry_epoch AS expiryEpoch, submitted_epoch AS submittedEpoch FROM governance_actions WHERE type = 'ParameterChange'",
        )
        .all<BasisInput & { submittedEpoch: number | null }>(),
      db.prepare('SELECT epoch FROM pool_economics WHERE epoch < ?').bind(epoch).all<{ epoch: number }>(),
    ]);
    const { basis, keepFrom } = poolEconomicsKeepEpochs(actions.results);
    return stored.results.map((r) => r.epoch).filter((e) => !basis.has(e) && (keepFrom === null || e < keepFrom));
  } catch (err: unknown) {
    console.error('[pool-economics] retention read failed, keeping every row', err);
    return [];
  }
}

/**
 * Stores the distribution of the clock's epoch. Skips Koios when that epoch is
 * stored already. Data labelled with another epoch (Koios lagging at an epoch
 * boundary) is not stored, so the next tick retries. A Koios error rejects.
 */
export async function syncPoolEconomics(args: {
  db: D1Database;
  koios: PoolEconomicsKoios;
  cfg: NetworkConfig;
  now: number;
}): Promise<{ epoch: number; written: 0 | 1; failed: 0 | 1 }> {
  const { db, koios, cfg, now } = args;
  const epoch = epochFromUnix(Math.floor(now / 1000), cfg);
  const stored = await db.prepare('SELECT MAX(epoch) AS epoch FROM pool_economics').first<{ epoch: number | null }>();
  if (stored?.epoch === epoch) return { epoch, written: 0, failed: 0 };
  const data = await readPoolEconomics(koios);
  if (!data) return { epoch, written: 0, failed: 1 };
  if (data.epoch !== epoch) return { epoch, written: 0, failed: 0 };
  await db.prepare('INSERT OR REPLACE INTO pool_economics (epoch, body, computed_at) VALUES (?, ?, ?)').bind(epoch, JSON.stringify(data), now).run();
  const stale = await staleEpochs(db, epoch);
  if (stale.length > 0) await db.batch(stale.map((e) => db.prepare('DELETE FROM pool_economics WHERE epoch = ?').bind(e)));
  return { epoch, written: 1, failed: 0 };
}
