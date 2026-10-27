/// <reference types="@cloudflare/workers-types" />
import { env } from 'cloudflare:test';
import { endOf, LeaseLostError } from 'drep-groups';
import { describe, expect, it } from 'vitest';
import { deactivateDreps, upsertDrep } from '../../db/dreps.js';
import { drepArgs } from '../../drepLink/__fixtures__/drepHandles.js';
import { credBytes, posFromRow } from '../codec.js';
import { acquireLease, invocationOwner, releaseLease, writeBatch } from './lease.js';

const db = env.DB;

async function expire(): Promise<void> {
  await db.prepare('UPDATE drep_group_lease SET expires_at = 0').run();
}

async function count(sql: string): Promise<number> {
  return Number((await db.prepare(sql).first<{ n: number }>())?.n);
}

describe('drep group lease', () => {
  it('seeds the meta row with G at the end of height -1', async () => {
    const row = await db.prepare('SELECT * FROM drep_group_meta WHERE id = 1').first<Record<string, unknown>>();
    expect(row).toMatchObject({ L: -1, R: null, lib_version: null, reg_offset: 0, rebuilding: 0, probe_active: 0 });
    expect(posFromRow(row as Record<string, unknown>, 'G')).toEqual(endOf(-1));
  });

  it('lets one holder hold the lease and rejects a stale token inside the batch', async () => {
    const a = await acquireLease(db, invocationOwner());
    expect(a).not.toBeNull();
    expect(await acquireLease(db, invocationOwner())).toBeNull();
    await writeBatch(db, a as string, [db.prepare('UPDATE drep_group_meta SET reg_offset = 7 WHERE id = 1')]);
    await expire();
    await expect(
      writeBatch(db, a as string, [db.prepare('UPDATE drep_group_meta SET reg_offset = 9 WHERE id = 1')]),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect((await db.prepare('SELECT reg_offset FROM drep_group_meta').first())?.reg_offset).toBe(7);
    expect(await count('SELECT COUNT(*) AS n FROM drep_group_lease_check')).toBe(0);
    expect(await acquireLease(db, invocationOwner())).not.toBeNull();
  });

  it('renews a live lease for the same owner with a new token', async () => {
    const first = await acquireLease(db, 'x');
    const second = await acquireLease(db, 'x');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    await expect(writeBatch(db, first as string, [])).rejects.toBeInstanceOf(LeaseLostError);
    await writeBatch(db, second as string, []);
  });

  it('a stale release leaves the next holder its lease', async () => {
    const a = await acquireLease(db, invocationOwner());
    await expire();
    const b = await acquireLease(db, invocationOwner());
    expect(b).not.toBeNull();
    await releaseLease(db, a as string);
    await expect(writeBatch(db, b as string, [])).resolves.toBeUndefined();
  });

  it('an empty write batch still checks the lease', async () => {
    const stale = await acquireLease(db, invocationOwner());
    await expire();
    await expect(writeBatch(db, stale as string, [])).rejects.toBeInstanceOf(LeaseLostError);
  });

  it('keeps other CHECK failures as errors', async () => {
    const token = (await acquireLease(db, invocationOwner())) as string;
    const bad = db
      .prepare(
        `INSERT INTO drep_group_ledger (tx_hash, cert_index, cred, drep_id, kind, block_height, block_hash, tx_index, block_time, witness_state)
         VALUES (X'0f', 0, X'00aa', 'drep1x', 'x', 1, X'0b', 0, 0, 'na')`,
      );
    const err = await writeBatch(db, token, [bad]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LeaseLostError);
    expect(String(err)).toMatch(/CHECK constraint failed/);
  });
});

async function track(cred: string, seq: number, known: number | null, historyDone: number): Promise<void> {
  await db
    .prepare('INSERT INTO drep_group_tracked (cred, seq, drep_id, known, history_done) VALUES (?, ?, ?, ?, ?)')
    .bind(credBytes(cred), seq, `drep_${cred}`, known, historyDone)
    .run();
}

async function tracked(cred: string): Promise<{ complete: number; pending_witness: number }> {
  return (await db
    .prepare('SELECT complete, pending_witness FROM drep_group_tracked WHERE cred = ?')
    .bind(credBytes(cred))
    .first()) as { complete: number; pending_witness: number };
}

function ledgerRow(cred: string, idx: number, state: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO drep_group_ledger (tx_hash, cert_index, cred, drep_id, kind, block_height, block_hash, tx_index, block_time, witness_state)
       VALUES (X'0f', ?, ?, 'drep1x', 'reg', 1, X'0b', 0, 0, ?)`,
    )
    .bind(idx, credBytes(cred), state);
}

describe('drep group tracking', () => {
  it('computes completeness in the generated column', async () => {
    await track('script:01', 1, 0, 0);
    await track('script:02', 2, 1, 1);
    await track('script:03', 3, 1, 1);
    await track('script:04', 4, null, 1);
    await ledgerRow('script:03', 0, 'pending').run();
    expect((await tracked('script:01')).complete).toBe(1);
    expect((await tracked('script:02')).complete).toBe(1);
    expect((await tracked('script:03')).complete).toBe(0);
    expect((await tracked('script:04')).complete).toBe(0);
  });

  it('keeps pending_witness exact through the ledger triggers', async () => {
    await track('script:aa', 1, 1, 0);
    await track('script:bb', 2, 1, 0);
    expect((await tracked('script:bb')).pending_witness).toBe(0);
    await db.batch([ledgerRow('script:aa', 0, 'pending'), ledgerRow('script:aa', 1, 'pending'), ledgerRow('script:aa', 2, 'na')]);
    expect((await tracked('script:aa')).pending_witness).toBe(2);
    await db.prepare("UPDATE drep_group_ledger SET witness_state = 'checked' WHERE cert_index = 0").run();
    expect((await tracked('script:aa')).pending_witness).toBe(1);
    await db.prepare('DELETE FROM drep_group_ledger WHERE cert_index IN (1, 2)').run();
    expect((await tracked('script:aa')).pending_witness).toBe(0);
    expect((await tracked('script:bb')).pending_witness).toBe(0);
  });

  it('deduplicates jobs by kind and key', async () => {
    const token = (await acquireLease(db, invocationOwner())) as string;
    const enqueue = () => [
      db.prepare("INSERT OR IGNORE INTO drep_group_jobs (kind, job_key, group_tx, group_ix) VALUES ('recompute', 'g#0', X'0e', 0)"),
      db.prepare("INSERT OR IGNORE INTO drep_group_jobs (kind, job_key, group_tx, group_ix) VALUES ('power', 'g#0', X'0e', 0)"),
      db.prepare("INSERT OR IGNORE INTO drep_group_jobs (kind, job_key, cred) VALUES ('repair', 'key:aa', X'00aa')"),
    ];
    for (let i = 0; i < 3; i++) await writeBatch(db, token, enqueue());
    const rows = await db.prepare('SELECT kind, COUNT(*) AS n FROM drep_group_jobs GROUP BY kind ORDER BY kind').all();
    expect(rows.results).toEqual([
      { kind: 'power', n: 1 },
      { kind: 'recompute', n: 1 },
      { kind: 'repair', n: 1 },
    ]);
  });
});

describe('drep group power changes', () => {
  const OPEN = 'drep1open';
  const SOLO = 'drep1solo';

  async function openInstance(drepId: string): Promise<void> {
    await db
      .prepare(
        `INSERT INTO drep_group_instances (join_tx, join_ix, group_tx, group_ix, cred, drep_id, mode,
           joined_h, joined_ti, joined_ph, joined_ix, joined_tx, counted_as)
         VALUES (X'0a', 0, X'0e', 0, X'00aa', ?, 'open', 1, 0, 1, 0, X'0a', 'open')`,
      )
      .bind(drepId)
      .run();
  }

  const queue = async () =>
    (await db.prepare('SELECT drep_id, seq, after_key FROM drep_group_power_changes ORDER BY seq').all()).results;

  it('queues a DRep inserted fresh while it holds an open instance', async () => {
    await openInstance(OPEN);
    await upsertDrep(db, { ...drepArgs(OPEN, null), votingPower: '100' });
    expect(await queue()).toEqual([{ drep_id: OPEN, seq: 1, after_key: null }]);
  });

  it('moves a queued DRep behind every other queued row on its next change', async () => {
    await upsertDrep(db, { ...drepArgs(OPEN, null), votingPower: '100' });
    await upsertDrep(db, { ...drepArgs(SOLO, null), votingPower: '100' });
    await openInstance(OPEN);
    await db
      .prepare("INSERT INTO drep_group_instances (join_tx, join_ix, group_tx, group_ix, cred, drep_id, mode, joined_h, joined_ti, joined_ph, joined_ix, joined_tx, counted_as) VALUES (X'0a02', 0, X'0e', 0, X'00bb', ?, 'open', 1, 0, 1, 0, X'0a02', 'open')")
      .bind(SOLO)
      .run();
    await upsertDrep(db, { ...drepArgs(OPEN, null), votingPower: '150' });
    await upsertDrep(db, { ...drepArgs(SOLO, null), votingPower: '150' });
    const before = Number((await queue()).find((r) => r.drep_id === OPEN)?.seq);
    await upsertDrep(db, { ...drepArgs(OPEN, null), votingPower: '175' });
    const rows = await queue();
    expect(rows.map((r) => r.drep_id)).toEqual([SOLO, OPEN]);
    expect(Number(rows[1].seq)).toBeGreaterThan(before);
    expect(Number(rows[1].seq)).toBeGreaterThan(Number(rows[0].seq));
  });

  it('queues a power change from both DRep write paths in the same statement', async () => {
    await upsertDrep(db, { ...drepArgs(OPEN, null), votingPower: '100' });
    await upsertDrep(db, { ...drepArgs(SOLO, null), votingPower: '100' });
    await openInstance(OPEN);
    await db.prepare('DELETE FROM drep_group_power_changes').run();

    // Unchanged power and a DRep without an open instance: no row.
    await upsertDrep(db, { ...drepArgs(OPEN, null), votingPower: '100' });
    await upsertDrep(db, { ...drepArgs(SOLO, null), votingPower: '200' });
    expect(await queue()).toEqual([]);

    await upsertDrep(db, { ...drepArgs(OPEN, null), votingPower: '150' });
    const first = await queue();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ drep_id: OPEN, after_key: null });

    await db.prepare("UPDATE drep_group_power_changes SET after_key = 'k'").run();
    await deactivateDreps(db, [
      { drepId: OPEN, status: 'retired', deposit: null, expiresEpochNo: null, lastSyncedAt: 1 },
    ]);
    const second = await queue();
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ drep_id: OPEN, after_key: null });
    expect(Number(second[0].seq)).toBeGreaterThan(Number(first[0].seq));
  });
});
