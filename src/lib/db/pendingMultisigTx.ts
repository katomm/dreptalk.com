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

export async function addPendingWitness(
  db: D1Database,
  id: string,
  witness: { key_hash: string; witness_hex: string },
  _now: number,
): Promise<'added' | 'gone'> {
  const row = await getPendingMultisig(db, id);
  if (row?.status !== 'collecting') return 'gone';
  const list = JSON.parse(row.witnesses) as Array<{ key_hash: string; witness_hex: string }>;
  if (list.some((w) => w.key_hash === witness.key_hash)) return 'added'; // idempotent on duplicate key
  list.push(witness);
  await db.prepare(`UPDATE pending_multisig_tx SET witnesses = ? WHERE id = ?`).bind(JSON.stringify(list), id).run();
  return 'added';
}

export async function markPendingSubmitted(db: D1Database, id: string, txHash: string, _now: number): Promise<void> {
  await db.prepare(`UPDATE pending_multisig_tx SET status = 'submitted', tx_hash = ? WHERE id = ?`).bind(txHash, id).run();
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
