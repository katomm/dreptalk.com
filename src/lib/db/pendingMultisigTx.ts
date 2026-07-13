export type PendingMultisigRow = {
  id: string;
  drep_id: string;
  action: 'vote';
  action_params: string;
  unsigned_tx_cbor: string;
  body_hash: string;
  native_script: string;
  witnesses: string;
  status: 'collecting' | 'submitted' | 'expired';
  tx_hash: string | null;
  created_by: string;
  created_at: number;
  expires_at: number;
};

export async function createPendingMultisig(
  db: D1Database,
  rec: {
    id: string;
    drepId: string;
    action: 'vote';
    actionParams: string;
    unsignedTxCbor: string;
    bodyHash: string;
    nativeScript: string;
    createdBy: string;
    createdAt: number;
    expiresAt: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pending_multisig_tx
         (id, drep_id, action, action_params, unsigned_tx_cbor, body_hash, native_script, witnesses, status, tx_hash, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 'collecting', NULL, ?, ?, ?)`,
    )
    .bind(rec.id, rec.drepId, rec.action, rec.actionParams, rec.unsignedTxCbor, rec.bodyHash, rec.nativeScript, rec.createdBy, rec.createdAt, rec.expiresAt)
    .run();
}

export async function getPendingMultisig(db: D1Database, id: string): Promise<PendingMultisigRow | null> {
  return (await db.prepare(`SELECT * FROM pending_multisig_tx WHERE id = ?`).bind(id).first<PendingMultisigRow>()) ?? null;
}

// Optimistic-concurrency retries: witnesses live in a single JSON column, so two
// co-signers appending at once would otherwise clobber each other (last write
// wins, one signature silently lost). The UPDATE is guarded on the exact prior
// value read (compare-and-swap); a losing writer sees 0 changed rows and retries
// against the now-current value. A handful of attempts covers realistic
// concurrency (a native script has a small, bounded signer set).
const ADD_WITNESS_MAX_ATTEMPTS = 8;

export async function addPendingWitness(
  db: D1Database,
  id: string,
  witness: { key_hash: string; witness_hex: string },
  _now: number,
): Promise<'added' | 'gone'> {
  for (let attempt = 0; attempt < ADD_WITNESS_MAX_ATTEMPTS; attempt++) {
    const row = await getPendingMultisig(db, id);
    if (row?.status !== 'collecting') return 'gone';
    const list = JSON.parse(row.witnesses) as Array<{ key_hash: string; witness_hex: string }>;
    if (list.some((w) => w.key_hash === witness.key_hash)) return 'added'; // idempotent on duplicate key
    list.push(witness);
    // Compare-and-swap: only write when witnesses is still exactly what we read,
    // and the row is still collecting. A concurrent append changes the blob, so
    // this matches 0 rows and we loop with a fresh read.
    const res = await db
      .prepare(`UPDATE pending_multisig_tx SET witnesses = ? WHERE id = ? AND witnesses = ? AND status = 'collecting'`)
      .bind(JSON.stringify(list), id, row.witnesses)
      .run();
    if ((res.meta.changes ?? 0) > 0) return 'added';
  }
  // Exhausted retries under sustained contention: report as not-added so the
  // caller can surface a retry rather than a false success.
  return 'gone';
}

// Atomically claim the collecting -> submitted transition. The status predicate
// makes this a compare-and-swap: only the first of two concurrent submits flips
// the row (changes > 0); the loser matches no row and must not record a vote or
// overwrite tx_hash. Returns whether this call performed the transition.
export async function markPendingSubmitted(db: D1Database, id: string, txHash: string, _now: number): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE pending_multisig_tx SET status = 'submitted', tx_hash = ? WHERE id = ? AND status = 'collecting'`)
    .bind(txHash, id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function listPendingForDrep(db: D1Database, drepId: string, now: number): Promise<PendingMultisigRow[]> {
  const res = await db
    .prepare(`SELECT * FROM pending_multisig_tx WHERE drep_id = ? AND status = 'collecting' AND expires_at > ? ORDER BY created_at DESC`)
    .bind(drepId, now)
    .all<PendingMultisigRow>();
  return res.results ?? [];
}

export async function deleteExpiredPending(db: D1Database, now: number): Promise<number> {
  const res = await db.prepare(`DELETE FROM pending_multisig_tx WHERE status = 'collecting' AND expires_at <= ?`).bind(now).run();
  return res.meta.changes ?? 0;
}
