import { paramRowAsOf } from '../db/paramLog.js';
import { hasPoolEconomicsEpoch } from './poolEconomics.js';

/**
 * The parameter row and the pool data flag for a basis epoch. A D1 error (for
 * example a table that is not migrated yet) is logged once and answers with no
 * row and no pool data, so the page renders without an impact section.
 */
export async function loadBasisData(db: D1Database, basis: number): Promise<{ basisRow: Record<string, unknown> | null; poolDataStored: boolean }> {
  try {
    const [basisRow, poolDataStored] = await Promise.all([paramRowAsOf(db, basis), hasPoolEconomicsEpoch(db, basis)]);
    return { basisRow, poolDataStored };
  } catch (err) {
    console.error('param basis data unavailable', err);
    return { basisRow: null, poolDataStored: false };
  }
}
