/// <reference types="@cloudflare/workers-types" />
// The resolver of DRepTalk's own group transactions over seeded engine state and a fake Koios.
import { env } from 'cloudflare:test';
import type { Credential } from 'drep-groups';
import { credKey } from 'drep-groups';
import { beforeEach, describe, expect, it } from 'vitest';
import { blockTime, fakeKoios, type FakeKoios, type FakeTx, T } from './__tests__/fixtures.js';
import { credBytes, hashBytes, MAX, type Row } from './codec.js';
import { DEPTH } from './constants.js';
import { NO_VERDICT_REASON, resolveGroupActions, txProcessed } from './resolve.js';
import { acquireLease, invocationOwner } from './store/lease.js';

const db = env.DB;
const NOW = 5_000;
let lease: string;

beforeEach(async () => {
  lease = (await acquireLease(db, invocationOwner())) as string;
});

const one = async (sql: string, ...binds: unknown[]): Promise<Row> => (await db.prepare(sql).bind(...binds).first<Row>()) as Row;
const row = (id: string): Promise<Row> =>
  one('SELECT resolution, resolved_at, resolved_h, never_included_at, spent_seen_h FROM pending_multisig_tx WHERE id = ?', id);

/** A stored label tx. */
async function stored(hash: string, h: number, ti = 0): Promise<void> {
  await db
    .prepare('INSERT INTO drep_group_txs (tx_hash, block_height, block_hash, tx_index, marker) VALUES (?, ?, ?, ?, 0)')
    .bind(hashBytes(hash), h, hashBytes(T(0xb0000 + h)), ti)
    .run();
}

/** The group cursor right after the tx at (h, ti). */
async function groupCursorAfter(h: number, ti = 0): Promise<void> {
  await db
    .prepare('UPDATE drep_group_meta SET G_h = ?, G_ti = ?, G_ph = 2, G_ix = ?, G_tx = ? WHERE id = 1')
    .bind(h, ti, MAX, hashBytes(T(0xc0000 + h)))
    .run();
}

interface Pending {
  id: string;
  body: string;
  events?: number;
  status?: 'collecting' | 'submitted' | 'cancelled';
  invalidHereafter?: number;
  feeInputs?: Array<{ txHash: string; index: number }>;
  controlSlot?: 0 | 1;
}

async function pending(p: Pending): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pending_multisig_tx (id, drep_id, action, action_params, unsigned_tx_cbor, body_hash, native_script, status,
         created_by, created_at, expires_at, subject_kind, event_count, invalid_hereafter, fee_inputs, control_slot)
       VALUES (?, 'g1', 'group_update', '{}', '00', ?, '{}', ?, 'u1', 1, 2, 'group', ?, ?, ?, ?)`,
    )
    .bind(
      p.id,
      p.body,
      p.status ?? 'submitted',
      p.events ?? 1,
      p.invalidHereafter ?? 1_000_000,
      p.feeInputs ? JSON.stringify(p.feeInputs) : null,
      p.controlSlot ?? 0,
    )
    .run();
}

async function outcome(hash: string, ix: number, valid: boolean, h: number, reason: string | null = valid ? null : 'rejected'): Promise<void> {
  await db
    .prepare('INSERT INTO drep_group_own_outcomes (tx_hash, idx, valid, reason, at_h, written_at) VALUES (?, ?, ?, ?, ?, 1)')
    .bind(hash, ix, valid ? 1 : 0, reason, h)
    .run();
}

let seq = 0;
/** A tracked credential with its applied cursor at (h, ti, 2, ix), or none. */
async function trackedAt(c: Credential, at: [number, number, number] | null): Promise<void> {
  seq++;
  await db
    .prepare(
      `INSERT INTO drep_group_tracked (cred, seq, known, history_done, applied_h, applied_ti, applied_ph, applied_ix, applied_tx)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      credBytes(credKey(c)),
      seq,
      at === null ? 0 : 1,
      at?.[0] ?? null,
      at?.[1] ?? null,
      at === null ? null : 2,
      at?.[2] ?? null,
      at === null ? null : hashBytes(T(0xd0000 + at[0])),
    )
    .run();
}

/** A credential plane event of the tx at (h, 0) for the subject. */
async function queued(hash: string, h: number, ix: number, c: Credential): Promise<void> {
  await db
    .prepare(
      `INSERT INTO drep_group_queue (tx_hash, idx, subject, at_h, at_ti, at_ph, at_ix, at_tx, event_json)
       VALUES (?, ?, ?, ?, 0, 2, ?, ?, '{}')`,
    )
    .bind(hashBytes(hash), ix, credBytes(credKey(c)), h, ix, hashBytes(hash))
    .run();
}

/** A fake Koios whose tip is at height `tip`, slot tip * 20, knowing the given chain txs. */
function koiosAt(tip: number, o: { txs?: FakeTx[]; known?: string[]; spent?: string[] } = {}): FakeKoios {
  return fakeKoios({ tip, txs: o.txs ?? [], regs: [], known: new Set(o.known ?? []), spent: new Set(o.spent ?? []) });
}

const resolve = (koios: FakeKoios) => resolveGroupActions({ db, lease, koios, now: NOW });
const M: Credential = { kind: 'key', hash: '50'.repeat(28) };

describe('resolveGroupActions', () => {
  it('resolves applied, partial and failed by outcomes', async () => {
    const [a, b, c] = [T(0x101), T(0x102), T(0x103)];
    await stored(a, 100);
    await stored(b, 101);
    await stored(c, 102);
    await groupCursorAfter(102);
    await pending({ id: 'a', body: a, events: 2 });
    await pending({ id: 'b', body: b, events: 2 });
    await pending({ id: 'c', body: c, events: 2 });
    await outcome(a, 0, true, 100);
    await outcome(a, 1, true, 100);
    await outcome(b, 0, true, 101);
    await outcome(b, 1, false, 101);
    await outcome(c, 0, false, 102);
    await outcome(c, 1, false, 102);
    const koios = koiosAt(200);
    expect(await resolve(koios)).toEqual({ resolved: 3, neverIncluded: 0 });
    expect(await row('a')).toMatchObject({ resolution: 'applied', resolved_at: NOW, resolved_h: 100, never_included_at: null });
    expect(await row('b')).toMatchObject({ resolution: 'partial', resolved_h: 101 });
    expect(await row('c')).toMatchObject({ resolution: 'failed', resolved_h: 102 });
    // Every row was processed, so Koios was not asked.
    expect(koios.calls).toEqual([]);
  });

  it('waits for an approval that waits on member history', async () => {
    const tx = T(0x201);
    await stored(tx, 100);
    await groupCursorAfter(150);
    await pending({ id: 'p', body: tx, events: 1 });
    // The member's history is not complete yet, its approval waits in the queue.
    await trackedAt(M, null);
    await queued(tx, 100, 0, M);
    expect(await txProcessed(db, tx)).toBe(false);
    expect(await resolve(koiosAt(200))).toEqual({ resolved: 0, neverIncluded: 0 });
    expect(await row('p')).toMatchObject({ resolution: null, resolved_at: null });
    // The credential is applied past the approval.
    await db
      .prepare('UPDATE drep_group_tracked SET history_done = 1, applied_h = 120, applied_ti = 0, applied_ph = 2, applied_ix = 0, applied_tx = ?')
      .bind(hashBytes(T(0x999)))
      .run();
    await outcome(tx, 0, true, 100);
    expect(await txProcessed(db, tx)).toBe(true);
    expect(await resolve(koiosAt(200))).toEqual({ resolved: 1, neverIncluded: 0 });
    expect(await row('p')).toMatchObject({ resolution: 'applied', resolved_h: 100 });
  });

  it('resolves a join whose subject has no later credential input', async () => {
    const tx = T(0x301);
    await stored(tx, 100);
    await groupCursorAfter(100);
    await pending({ id: 'j', body: tx, events: 1 });
    // appliedThrough is the join itself, the comparison is inclusive.
    await trackedAt(M, [100, 0, 0]);
    await queued(tx, 100, 0, M);
    await outcome(tx, 0, true, 100);
    expect(await txProcessed(db, tx)).toBe(true);
    await resolve(koiosAt(200));
    expect(await row('j')).toMatchObject({ resolution: 'applied', resolved_h: 100 });
  });

  it('keeps a stored tx behind the group cursor unresolved', async () => {
    const tx = T(0x351);
    await stored(tx, 120);
    await groupCursorAfter(110);
    await pending({ id: 's', body: tx, invalidHereafter: blockTime(50) });
    const koios = koiosAt(300);
    expect(await txProcessed(db, tx)).toBe(false);
    expect(await resolve(koios)).toEqual({ resolved: 0, neverIncluded: 0 });
    // A stored tx is on chain, it never reaches the never included probe.
    expect(koios.calls).toEqual([]);
    expect(await row('s')).toMatchObject({ resolution: null, never_included_at: null });
  });

  it('keeps a tx that is on chain behind a backlog confirming', async () => {
    const tx = T(0x401);
    await pending({ id: 'k', body: tx, invalidHereafter: blockTime(100) });
    // Far past expiry and depth, the ingest has not stored the tx yet but Koios knows it.
    const koios = koiosAt(100 + 1 + DEPTH + 50, { known: [tx] });
    expect(await resolve(koios)).toEqual({ resolved: 0, neverIncluded: 0 });
    expect(await row('k')).toMatchObject({ resolution: null, resolved_at: null, never_included_at: null });
    expect(koios.calls).toContain('status:1');
  });

  it('marks never included only past expiry plus depth with an unknown tx', async () => {
    const tx = T(0x501);
    await pending({ id: 'n', body: tx, invalidHereafter: blockTime(100), controlSlot: 1 });
    // The first block after the expiry slot is 101.
    const shallow = koiosAt(101 + DEPTH - 1);
    expect(await resolve(shallow)).toEqual({ resolved: 0, neverIncluded: 0 });
    expect(await row('n')).toMatchObject({ resolution: null, never_included_at: null });
    expect(shallow.calls).not.toContain('status:1');
    // Not yet past expiry: no probe at all.
    const early = koiosAt(100);
    await resolve(early);
    expect(early.calls).toEqual(['tip']);

    expect(await resolve(koiosAt(101 + DEPTH))).toEqual({ resolved: 0, neverIncluded: 1 });
    expect(await row('n')).toMatchObject({ resolution: 'never_included', resolved_at: NOW, never_included_at: NOW, resolved_h: null });
    // The control slot is free.
    const open = await one("SELECT COUNT(*) AS n FROM pending_multisig_tx WHERE drep_id = 'g1' AND control_slot = 1 AND resolved_at IS NULL");
    expect(open.n).toBe(0);
  });

  it('lets later outcomes override never included', async () => {
    const tx = T(0x601);
    await pending({ id: 'o', body: tx, invalidHereafter: blockTime(100), controlSlot: 1 });
    await resolve(koiosAt(101 + DEPTH));
    expect(await row('o')).toMatchObject({ resolution: 'never_included' });
    // The tx turns up after all and the engine processes it.
    await stored(tx, 101);
    await groupCursorAfter(101);
    await outcome(tx, 0, true, 101);
    expect(await resolve(koiosAt(200))).toEqual({ resolved: 1, neverIncluded: 0 });
    expect(await row('o')).toMatchObject({ resolution: 'applied', resolved_h: 101, never_included_at: null, resolved_at: NOW });
  });

  it('resolves when the groupless outcome write was lost', async () => {
    const tx = T(0x701);
    await stored(tx, 100);
    await groupCursorAfter(100);
    // A create and an orphan approve: only the create has an outcome.
    await pending({ id: 'l', body: tx, events: 2 });
    await outcome(tx, 0, true, 100);
    expect(await resolve(koiosAt(200))).toEqual({ resolved: 1, neverIncluded: 0 });
    expect(await row('l')).toMatchObject({ resolution: 'partial', resolved_h: 100 });
    // The missing verdict is read as not applied, no row is invented for it.
    const n = await one('SELECT COUNT(*) AS n FROM drep_group_own_outcomes WHERE tx_hash = ?', tx);
    expect(n.n).toBe(1);
    expect(NO_VERDICT_REASON).toBe('no verdict recorded');
  });

  it('marks never included DEPTH blocks after the fee input was first seen spent', async () => {
    const tx = T(0x801);
    const fee = { txHash: T(0x8f1), index: 0 };
    await pending({ id: 'f', body: tx, status: 'collecting', feeInputs: [fee], controlSlot: 1 });
    // Unspent: nothing changes.
    await resolve(koiosAt(150));
    expect(await row('f')).toMatchObject({ resolution: null, spent_seen_h: null });
    // Spent by another tx: the first sighting is stored.
    const spent = [`${fee.txHash}#0`];
    expect(await resolve(koiosAt(200, { spent }))).toEqual({ resolved: 0, neverIncluded: 0 });
    expect(await row('f')).toMatchObject({ resolution: null, spent_seen_h: 200 });
    expect(await resolve(koiosAt(200 + DEPTH - 1, { spent }))).toEqual({ resolved: 0, neverIncluded: 0 });
    expect(await row('f')).toMatchObject({ resolution: null, spent_seen_h: 200 });
    // An unspent answer clears the sighting, a new one starts over.
    await resolve(koiosAt(205));
    expect(await row('f')).toMatchObject({ spent_seen_h: null });
    await resolve(koiosAt(206, { spent }));
    expect(await row('f')).toMatchObject({ spent_seen_h: 206 });
    expect(await resolve(koiosAt(206 + DEPTH, { spent }))).toEqual({ resolved: 0, neverIncluded: 1 });
    expect(await row('f')).toMatchObject({ resolution: 'never_included', never_included_at: NOW, resolved_h: null });
  });

  it('keeps a spent fee input row whose tx Koios knows', async () => {
    const tx = T(0x901);
    const fee = { txHash: T(0x9f1), index: 1 };
    await pending({ id: 'g', body: tx, status: 'cancelled', feeInputs: [fee] });
    const spent = [`${fee.txHash}#1`];
    await resolve(koiosAt(200, { spent, known: [tx] }));
    expect(await resolve(koiosAt(200 + DEPTH, { spent, known: [tx] }))).toEqual({ resolved: 0, neverIncluded: 0 });
    expect(await row('g')).toMatchObject({ resolution: null, never_included_at: null });
  });
});
