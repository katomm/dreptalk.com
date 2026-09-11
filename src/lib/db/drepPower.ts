/// <reference types="@cloudflare/workers-types" />
// The voting-power side of the survey tally: which epoch the weights come from,
// what each responding credential weighs there, and the epoch's representative
// total. All queries use .prepare().bind(), never string-concatenated values.
//
// A credential is resolved on (dreps.hex, dreps.has_script), the bare hash form
// Koios serves, which is null only for the two pseudo-DReps, and those have no
// credential and can never respond. Deliberately NOT via drepIdFromKeyHash:
// that helper hardcodes the CIP-129 key header 0x22 and would mis-encode a
// script DRep, whose header is 0x23.
import { chunked, D1_MAX_BINDS } from './sql.js';

/**
 * Local voting power, as the tally pass resolved it. `weightOf` returns null
 * for a credential that resolves to no DRep row we can weigh, and 0n for one
 * that resolves to a DRep registered with no power. The two are different
 * outcomes, null leaves the weighted run, 0n stays in it.
 */
export interface PowerLookup {
  /** The epoch the weights were snapshotted at. */
  epoch: number;
  /** Representative DRep power at `epoch`, or null when unknown. Never "0" for unknown. */
  totalPower: string | null;
  weightOf(credentialHashHex: string, isScript: boolean): bigint | null;
}

/** The newest epoch the power history holds, or null when it holds nothing. */
export async function newestPowerEpoch(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare('SELECT MAX(epoch) AS epoch FROM drep_voting_power_history')
    .first<{ epoch: number | null }>();
  return row?.epoch ?? null;
}

/** A credential as the responses name it: the bare hash plus whether it is a script. */
export interface CredentialRef {
  hex: string;
  isScript: boolean;
}

function keyOf(hex: string, isScript: boolean): string {
  return `${isScript ? 'script' : 'key'}:${hex.toLowerCase()}`;
}

/**
 * Resolve every given credential's weight at the newest power epoch, and that
 * epoch's representative DRep total. Returns null when the history table is
 * empty, which is the one state where no tally can be written at all.
 *
 * A credential absent from the result weighs null, meaning locally
 * unresolvable, which is NOT the same as registered with no power, the latter
 * is present with 0n. The tally keeps the first in the head count only, and the
 * second in both readings.
 */
export async function loadPowerLookup(
  db: D1Database,
  credentials: readonly CredentialRef[],
): Promise<PowerLookup | null> {
  const epoch = await newestPowerEpoch(db);
  if (epoch === null) return null;

  const weights = new Map<string, bigint>();
  // Two binds per credential plus the epoch, so chunk well under the cap.
  for (const chunk of chunked(credentials, Math.floor((D1_MAX_BINDS - 1) / 2))) {
    if (chunk.length === 0) continue;
    const list = chunk.map(() => '(?, ?)').join(', ');
    const binds: (string | number)[] = [epoch];
    for (const c of chunk) binds.push(c.hex.toLowerCase(), c.isScript ? 1 : 0);
    const { results } = await db
      .prepare(
        `SELECT d.hex AS hex, d.has_script AS has_script, h.amount AS amount
         FROM dreps d
         JOIN drep_voting_power_history h ON h.drep_id = d.drep_id AND h.epoch = ?
         WHERE (LOWER(d.hex), d.has_script) IN (VALUES ${list})`,
      )
      .bind(...binds)
      .all<{ hex: string; has_script: number; amount: string }>();
    for (const r of results ?? []) {
      weights.set(keyOf(r.hex, r.has_script === 1), BigInt(r.amount));
    }
  }

  const totals = await db
    .prepare('SELECT total_drep_power FROM governance_epoch_stats WHERE epoch = ?')
    .bind(epoch)
    .first<{ total_drep_power: string }>();

  return {
    epoch,
    totalPower: totals?.total_drep_power ?? null,
    weightOf: (hex, isScript) => weights.get(keyOf(hex, isScript)) ?? null,
  };
}
