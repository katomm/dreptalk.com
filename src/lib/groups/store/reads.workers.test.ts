/// <reference types="@cloudflare/workers-types" />
import { env } from 'cloudflare:test';
import type { ChangeSet, Credential, GroupVersion, Keys, Pos } from 'drep-groups';
import { credKey, endOf, refKey } from 'drep-groups';
import { describe, expect, it } from 'vitest';
import { credBytes, encodeEvent, hashBytes, hashListBytes } from '../codec.js';
import {
  frontiers,
  load,
  nextLabelTxs,
  pendingRecovery,
  queuedJoins,
  readyCredentials,
} from './reads.js';

const db = env.DB;

const hex = (n: number, len = 56): string => n.toString(16).padStart(len, '0');
const pos = (h: number, ti = 0, ph: 0 | 1 | 2 = 2, ix = 0, tx = hex(h * 100 + ti, 64)): Pos => ({
  blockHeight: h,
  txIndex: ti,
  phase: ph,
  index: ix,
  txHash: tx,
});
const certPos = (h: number, ix = 0): Pos => pos(h, 0, 0, ix);
const keyCred = (n: number): Credential => ({ kind: 'key', hash: hex(n) });
const cb = (c: Credential): Uint8Array => credBytes(credKey(c));
const optHash = (h: string | null): Uint8Array | null => (h === null ? null : hashBytes(h));
// The group a queued join names.
const QG = 'ee'.repeat(32);
const scriptCred = (n: number): Credential => ({ kind: 'script', hash: hex(n) });
// CBOR of the native script [0, h'..'], a single signature.
const sigScript = (n: number): Uint8Array => {
  const h = hex(n);
  const out = new Uint8Array(4 + 28);
  out.set([0x82, 0x00, 0x58, 0x1c]);
  for (let i = 0; i < 28; i++) out[4 + i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const emptyKeys = (): Keys => ({ instances: [], latestInstances: [], groupsAt: [], scriptsAt: [], credentialAt: [] });
const emptyChange = (): ChangeSet => ({
  scripts: [],
  memberScripts: [],
  versions: [],
  instances: [],
  verdicts: [],
  queued: [],
  txContexts: [],
  appliedQueue: [],
  effects: [],
});

// Plain SQL seeding, one helper per table.
const seed = {
  async tx(h: number, ti: number, opts: { marker?: boolean; bytes?: number; refetch?: boolean } = {}): Promise<string> {
    const txHash = hex(h * 100 + ti, 64);
    const marker = opts.marker ?? false;
    const bytes = opts.bytes ?? 100;
    await db
      .prepare(
        `INSERT INTO drep_group_txs (tx_hash, block_height, block_hash, tx_index, marker, payload, required_signers,
           witness_key_hashes, invalid_before, invalid_hereafter, is_valid, payload_repeated, bytes, refetch)
         VALUES (?, ?, X'0b', ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?)`,
      )
      .bind(
        hashBytes(txHash),
        h,
        ti,
        marker ? 1 : 0,
        marker ? null : new Uint8Array(bytes).fill(7),
        marker ? null : hashListBytes([hex(1)]),
        marker ? null : hashListBytes([hex(2)]),
        marker ? null : '5',
        marker ? null : 1,
        marker ? 0 : bytes,
        opts.refetch ? 1 : 0,
      )
      .run();
    return txHash;
  },
  async tracked(
    c: Credential,
    seq: number,
    known: number | null,
    historyDone: number,
    next: Pos | null,
    applied: Pos | null = null,
  ): Promise<void> {
    const n = next ?? { blockHeight: null, txIndex: null, phase: null, index: null, txHash: null };
    const a = applied ?? { blockHeight: null, txIndex: null, phase: null, index: null, txHash: null };
    await db
      .prepare(
        `INSERT INTO drep_group_tracked (cred, seq, drep_id, known, history_done,
           next_h, next_ti, next_ph, next_ix, next_tx, applied_h, applied_ti, applied_ph, applied_ix, applied_tx)
         VALUES (?, ?, 'drep1x', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(cb(c), seq, known, historyDone, n.blockHeight, n.txIndex, n.phase, n.index, optHash(n.txHash), a.blockHeight, a.txIndex, a.phase, a.index, optHash(a.txHash))
      .run();
  },
  async ledger(c: Credential, kind: 'reg' | 'unreg', h: number, certIndex = 0, witness: Uint8Array | null = null): Promise<void> {
    await db
      .prepare(
        `INSERT INTO drep_group_ledger (tx_hash, cert_index, cred, drep_id, kind, block_height, block_hash, tx_index,
           block_time, witness, witness_state)
         VALUES (?, ?, ?, 'drep1x', ?, ?, X'0b', 0, 0, ?, ?)`,
      )
      .bind(hashBytes(hex(h * 100, 64)), certIndex, cb(c), kind, h, witness, witness ? 'checked' : 'na')
      .run();
  },
  async queued(c: Credential, at: Pos, applied = 0, withContext = true): Promise<void> {
    await db
      .prepare(
        `INSERT INTO drep_group_queue (tx_hash, idx, subject, at_h, at_ti, at_ph, at_ix, at_tx, group_tx, group_ix, event_json, applied)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .bind(
        hashBytes(at.txHash),
        at.index,
        cb(c),
        at.blockHeight,
        at.txIndex,
        at.phase,
        at.index,
        hashBytes(at.txHash),
        hashBytes(QG),
        encodeEvent({ ok: true, event: { tag: 'join', group: { txHash: QG, index: 0 }, member: c } }),
        applied,
      )
      .run();
    if (withContext) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO drep_group_tx_context (tx_hash, block_height, tx_index, signers, required_signers, invalid_before, invalid_hereafter)
           VALUES (?, ?, ?, ?, X'', NULL, '9')`,
        )
        .bind(hashBytes(at.txHash), at.blockHeight, at.txIndex, hashListBytes([c.hash]))
        .run();
    }
  },
  async memberScript(c: Credential, at: Pos, bytes: Uint8Array): Promise<void> {
    await db
      .prepare(
        `INSERT INTO drep_group_member_scripts (cred, at_h, at_ti, at_ph, at_ix, at_tx, bytes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(cb(c), at.blockHeight, at.txIndex, at.phase, at.index, hashBytes(at.txHash), bytes)
      .run();
  },
  async script(hash: string, at: Pos, bytes: Uint8Array): Promise<void> {
    await db
      .prepare(`INSERT INTO drep_group_scripts (hash, at_h, at_ti, at_ph, at_ix, at_tx, bytes) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(hashBytes(hash), at.blockHeight, at.txIndex, at.phase, at.index, hashBytes(at.txHash), bytes)
      .run();
  },
  async version(group: { txHash: string; index: number }, at: Pos, status: 'active' | 'dissolved', seq: number): Promise<void> {
    await db
      .prepare(
        `INSERT INTO drep_group_versions (group_tx, group_ix, at_h, at_ti, at_ph, at_ix, at_tx, mode, control, admission,
           profile_url, profile_hash, seq, status, created_h, created_ti, created_ph, created_ix, created_tx)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', X'cc', NULL, NULL, NULL, ?, ?, 1, 0, 2, 0, ?)`,
      )
      .bind(hashBytes(group.txHash), group.index, at.blockHeight, at.txIndex, at.phase, at.index, hashBytes(at.txHash), String(seq), status, hashBytes(group.txHash))
      .run();
  },
  async instance(join: { txHash: string; index: number }, group: { txHash: string; index: number }, c: Credential, joined: Pos): Promise<void> {
    await db
      .prepare(
        `INSERT INTO drep_group_instances (join_tx, join_ix, group_tx, group_ix, cred, drep_id, mode,
           joined_h, joined_ti, joined_ph, joined_ix, joined_tx, counted_as)
         VALUES (?, ?, ?, ?, ?, 'drep1x', 'open', ?, ?, ?, ?, ?, 'open')`,
      )
      .bind(hashBytes(join.txHash), join.index, hashBytes(group.txHash), group.index, cb(c), joined.blockHeight, joined.txIndex, joined.phase, joined.index, hashBytes(joined.txHash))
      .run();
  },
  async meta(L: number, R: number | null): Promise<void> {
    await db.prepare('UPDATE drep_group_meta SET L = ?, R = ? WHERE id = 1').bind(L, R).run();
  },
};

describe('drep group store reads', () => {
  it('pages label txs by count and bytes and reports done', async () => {
    await seed.tx(10, 0);
    await seed.tx(11, 0);
    await seed.tx(11, 1, { marker: true });
    await seed.tx(12, 0);
    const first = await nextLabelTxs(db, endOf(9), 12, 2, 1e6);
    expect(first.txs.map((t) => t.tx.blockHeight)).toEqual([10, 11]);
    expect(first.done).toBe(false);
    expect(first.txs[0]).toEqual({
      bytes: 100,
      tx: {
        txHash: hex(1000, 64),
        blockHeight: 10,
        txIndex: 0,
        isValid: true,
        invalidBefore: 5n,
        invalidHereafter: null,
        requiredSigners: [hex(1)],
        witnessKeyHashes: [hex(2)],
        payload: new Uint8Array(100).fill(7),
        payloadRepeated: false,
        witnessScripts: [],
      },
    });
    expect((await nextLabelTxs(db, endOf(9), 12, 10, 150)).txs).toHaveLength(1);
    expect((await nextLabelTxs(db, endOf(9), 12, 10, 50)).txs).toHaveLength(1); // a single oversized tx alone
    const rest = await nextLabelTxs(db, { ...pos(10, 0), index: Number.MAX_SAFE_INTEGER }, 12, 10, 1e6);
    expect(rest.txs.map((t) => t.tx.blockHeight)).toEqual([11, 12]);
    expect(rest.done).toBe(true);
    expect((await nextLabelTxs(db, endOf(9), 11, 10, 1e6)).done).toBe(true);
    expect(await nextLabelTxs(db, endOf(12), 12, 10, 1e6)).toEqual({ txs: [], done: true });
  });

  it('answers registration from raw rows and member scripts from applied rows only', async () => {
    const c = scriptCred(9);
    await seed.tracked(c, 1, 1, 1, certPos(5));
    await seed.ledger(c, 'reg', 5, 0, sigScript(1));
    await seed.ledger(c, 'unreg', 8);
    const keys: Keys = { ...emptyKeys(), credentialAt: [[c, pos(6)], [c, certPos(5)], [c, pos(4)], [c, pos(9)]] };
    const v = await load(db, keys, []);
    expect(v.registeredAt(c, pos(6))).toBe(true);
    expect(v.registeredAt(c, certPos(5))).toBe(true);
    expect(v.registeredAt(c, pos(4))).toBe(false);
    expect(v.registeredAt(c, pos(9))).toBe(false);
    expect(v.firstUnregAfter(c, pos(6))).toEqual(certPos(8));
    expect(v.firstUnregAfter(c, pos(9))).toBeNull();
    expect(v.memberScriptAt(c, pos(6))).toBeNull();

    await seed.memberScript(c, certPos(5), sigScript(1));
    const w = await load(db, keys, []);
    expect(w.memberScriptAt(c, pos(6))).toEqual({ type: 'sig', keyHash: hex(1) });
    expect(w.memberScriptAt(c, pos(4))).toBeNull();
  });

  it('reports unloaded keys as missing and never merges the overlay', async () => {
    const g = { txHash: hex(1, 64), index: 0 };
    const other = { txHash: hex(2, 64), index: 0 };
    const c = keyCred(3);
    await seed.version(g, pos(1), 'active', 0);
    await seed.version(g, pos(3), 'active', 1);
    await seed.version(g, pos(5), 'dissolved', 2);
    await seed.script(hex(7), pos(2, 0, 1, -1), sigScript(7));
    const j1 = { txHash: hex(10, 64), index: 0 };
    const j2 = { txHash: hex(11, 64), index: 1 };
    await seed.instance(j1, g, c, pos(2));
    await seed.instance(j2, g, c, pos(4, 0, 2, 1));

    const all: Keys = {
      instances: [j1, j2, { txHash: hex(99, 64), index: 0 }],
      latestInstances: [[g, c], [other, c]],
      groupsAt: [[g, pos(4)], [g, pos(0)], [other, pos(4)]],
      scriptsAt: [[hex(7), pos(3)], [hex(7), pos(1)]],
      credentialAt: [[c, pos(4)]],
    };
    const subset: Keys = {
      instances: [j1, { txHash: hex(99, 64), index: 0 }],
      latestInstances: [[g, c]],
      groupsAt: [[g, pos(4)], [g, pos(0)]],
      scriptsAt: [[hex(7), pos(3)], [hex(7), pos(1)]],
      credentialAt: [],
    };
    const overlay = emptyChange();
    const unseen: GroupVersion = {
      id: other,
      at: pos(2),
      mode: 'open',
      control: 'cc',
      admission: null,
      profile: null,
      seq: 0n,
      status: 'active',
      createdAt: pos(2),
      profileSetAt: null,
    };
    overlay.versions.push(unseen);
    const v = await load(db, subset, [overlay]);
    expect(v.missing(all)).toEqual({
      instances: [j2],
      latestInstances: [[other, c]],
      groupsAt: [[other, pos(4)]],
      scriptsAt: [],
      credentialAt: [[c, pos(4)]],
    });
    expect(v.missing(subset)).toEqual(emptyKeys());
    expect(v.groupAt(other, pos(4))).toBeNull();

    expect(v.groupAt(g, pos(4))?.seq).toBe(1n);
    expect(v.groupAt(g, pos(4))?.at).toEqual(pos(3));
    expect(v.groupAt(g, pos(0))).toBeNull();
    expect(v.dissolvedAt(g)).toEqual(pos(5));
    expect(v.scriptAt(hex(7), pos(3))).toEqual({ type: 'sig', keyHash: hex(7) });
    expect(v.scriptAt(hex(7), pos(1))).toBeNull();
    expect(v.instance(j1)?.joinedAt).toEqual(pos(2));
    expect(v.instance({ txHash: hex(99, 64), index: 0 })).toBeNull();
    expect(v.latestInstance(g, c)?.joinId).toEqual(j2);
  });

  it('chunks keys so every statement stays within the bind limit', async () => {
    const g = { txHash: hex(1, 64), index: 0 };
    await seed.version(g, pos(1), 'active', 0);
    const groupsAt: Keys['groupsAt'] = Array.from({ length: 40 }, (_, i) => [g, pos(i + 1)]);
    groupsAt.push([g, endOf(4)]);
    const credentialAt: Keys['credentialAt'] = Array.from({ length: 45 }, (_, i) => [keyCred(i), pos(3)]);
    const v = await load(db, { ...emptyKeys(), groupsAt, credentialAt }, []);
    expect(v.missing({ ...emptyKeys(), groupsAt, credentialAt })).toEqual(emptyKeys());
    expect(v.groupAt(g, pos(40))?.seq).toBe(0n);
    expect(v.groupAt(g, endOf(4))?.seq).toBe(0n);
  });

  it('orders ready credentials by oldest unapplied input and bounds by min(G, END(R))', async () => {
    const [A, B, C, D, E] = [keyCred(0xa), keyCred(0xb), keyCred(0xc), keyCred(0xd), keyCred(0xe)];
    // cred A next 30, cred B next 20, cred C incomplete next 10, cred D known 0 next 50, E past END(R)
    await seed.tracked(A, 1, 1, 1, certPos(30));
    await seed.tracked(B, 2, 1, 1, certPos(20));
    await seed.tracked(C, 3, 1, 0, certPos(10));
    await seed.tracked(D, 4, 0, 0, pos(50));
    await seed.tracked(E, 5, 1, 1, certPos(45));
    await seed.ledger(A, 'reg', 30);
    await seed.ledger(B, 'reg', 20);
    await seed.ledger(C, 'reg', 10);
    await seed.queued(D, pos(50));
    await seed.ledger(E, 'reg', 45);
    const ready = await readyCredentials(db, 10, 100, { G: endOf(60), R: 40 });
    expect(ready.map((r) => r.c.hash)).toEqual([B.hash, A.hash, D.hash]);
    expect(ready[1]).toEqual({
      c: A,
      more: false,
      inputs: [
        {
          kind: 'ledger',
          at: { ...certPos(30), txHash: hex(3000, 64) },
          input: { kind: 'reg', credential: A, txHash: hex(3000, 64), blockHeight: 30, txIndex: 0, certIndex: 0, witnessScripts: [] },
        },
      ],
    });
    expect(ready[2].inputs).toEqual([
      {
        kind: 'event',
        q: {
          subject: D,
          at: pos(50),
          group: { txHash: QG, index: 0 },
          txHash: pos(50).txHash,
          event: { ok: true, event: { tag: 'join', group: { txHash: QG, index: 0 }, member: D } },
        },
        tx: { signers: [D.hash], requiredSigners: [], invalidBefore: null, invalidHereafter: 9n },
      },
    ]);
    expect((await readyCredentials(db, 2, 100, { G: endOf(60), R: null })).map((r) => r.c.hash)).toEqual([B.hash, A.hash]);
    expect((await readyCredentials(db, 10, 100, { G: endOf(25), R: 40 })).map((r) => r.c.hash)).toEqual([B.hash]);
  });

  it('pages inputs across credentials within maxInputs and sets more', async () => {
    const [A, B] = [scriptCred(0xa), keyCred(0xb)];
    await seed.tracked(A, 1, 1, 1, certPos(10), endOf(9));
    await seed.tracked(B, 2, 1, 1, pos(13), certPos(12));
    await seed.ledger(A, 'reg', 8, 0, sigScript(1)); // applied already
    await seed.ledger(A, 'reg', 10, 0, sigScript(1));
    await seed.ledger(A, 'unreg', 11);
    await seed.ledger(A, 'reg', 12, 1);
    await seed.ledger(B, 'reg', 12); // at its applied position
    await seed.queued(B, pos(13));
    await seed.queued(B, pos(13, 0, 2, 5), 1); // applied queue entry
    await seed.ledger(B, 'unreg', 14);
    await seed.queued(B, pos(15));
    const ready = await readyCredentials(db, 10, 4, { G: endOf(60), R: null });
    expect(ready.map((r) => [r.c.hash, r.inputs.length, r.more])).toEqual([
      [A.hash, 3, false],
      [B.hash, 1, true],
    ]);
    const a = ready[0].inputs;
    expect(a.map((x) => (x.kind === 'ledger' ? x.at : null))).toEqual([certPos(10), certPos(11), { ...certPos(12, 1) }]);
    expect(a[0].kind === 'ledger' && a[0].input.witnessScripts).toEqual([sigScript(1)]);
    expect(ready[1].inputs[0].kind).toBe('event');

    const wide = await readyCredentials(db, 10, 100, { G: endOf(60), R: null });
    expect(wide[1].inputs.map((x) => (x.kind === 'ledger' ? x.at.blockHeight : x.q.at.blockHeight))).toEqual([13, 14, 15]);
    expect(wide[1].more).toBe(false);
    const one = await readyCredentials(db, 10, 100, { G: endOf(14), R: null });
    expect(one[1].inputs).toHaveLength(2);
    expect(one[1].more).toBe(false);
  });

  it('holds the reported L below a marker flagged for refetch', async () => {
    await seed.meta(100, 90);
    expect(await frontiers(db)).toEqual({ L: 100, R: 90, G: endOf(-1) });
    await seed.tx(80, 0, { marker: true, refetch: true });
    await seed.tx(85, 0, { marker: true, refetch: true });
    expect((await frontiers(db)).L).toBe(79);
    await seed.meta(50, null);
    expect(await frontiers(db)).toEqual({ L: 50, R: null, G: endOf(-1) });
  });

  it('reads the first recovery slot', async () => {
    expect(await pendingRecovery(db)).toBeNull();
    await db.prepare("UPDATE drep_group_meta SET rec_first_kind = 'truncate', rec_first_above = 42").run();
    expect(await pendingRecovery(db)).toEqual({ kind: 'truncate', above: 42 });
    await db.prepare("UPDATE drep_group_meta SET rec_first_kind = 'rebuild', rec_first_above = NULL").run();
    expect(await pendingRecovery(db)).toEqual({ kind: 'rebuild' });
    await db.prepare("UPDATE drep_group_meta SET rec_first_kind = 'fork'").run();
    expect(await pendingRecovery(db)).toEqual({ kind: 'fork' });
  });

  it('answers queued joins from the overlay, the queue and markers', async () => {
    const c = keyCred(5);
    const inQueue = pos(20, 0, 2, 3);
    await seed.queued(c, inQueue);
    const markerTx = await seed.tx(21, 0, { marker: true });
    const plainTx = await seed.tx(22, 0);
    const overlay = emptyChange();
    const fromOverlay = pos(23, 0, 2, 1);
    const overlayEvent = { ok: false as const, reason: 'bad' };
    overlay.queued.push({ subject: c, at: fromOverlay, group: null, txHash: fromOverlay.txHash, event: overlayEvent });
    const refs = [
      { txHash: inQueue.txHash, index: 3 },
      { txHash: markerTx, index: 0 },
      { txHash: fromOverlay.txHash, index: 1 },
      { txHash: plainTx, index: 0 },
      { txHash: hex(777, 64), index: 0 },
    ];
    const out = await queuedJoins(db, refs, [emptyChange(), overlay]);
    expect(out).toEqual(
      new Map([
        [refKey(refs[0]), { ok: true, event: { tag: 'join', group: { txHash: QG, index: 0 }, member: c } }],
        [refKey(refs[1]), 'ignored'],
        [refKey(refs[2]), overlayEvent],
      ]),
    );
  });
});
