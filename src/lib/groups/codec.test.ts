import {
  type DecodedEvent,
  type NativeScript,
  credKey,
  decodePayload,
  endOf,
  posOfEvent,
} from 'drep-groups';
import { generateChain } from 'drep-groups/conformance';
import { describe, expect, it } from 'vitest';
import {
  afterTx,
  credFromKey,
  decodeContext,
  decodeEvent,
  encodeContext,
  encodeEvent,
  instanceFromRow,
  posBinds,
  posFromRow,
  posOrNull,
  scriptDisplayJson,
  versionFromRow,
} from './codec.js';

describe('positions', () => {
  it('round trips positions including END(h)', () => {
    for (const p of [posOfEvent({ txHash: 'ab'.repeat(32), blockHeight: 7, txIndex: 3 }, 2), endOf(41), endOf(-1)]) {
      const [h, ti, ph, ix, tx] = posBinds(p);
      expect(posFromRow({ a_h: h, a_ti: ti, a_ph: ph, a_ix: ix, a_tx: tx }, 'a')).toEqual(p);
    }
    expect(posOrNull({ a_h: null, a_ti: null, a_ph: null, a_ix: null, a_tx: null }, 'a')).toBeNull();
  });
  it('throws on a missing column', () => {
    expect(() => posFromRow({ a_h: 1 }, 'a')).toThrow();
  });
  it('builds the position after a tx like the library', () => {
    expect(afterTx({ txHash: 'cd'.repeat(32), blockHeight: 5, txIndex: 1 })).toEqual({
      blockHeight: 5,
      txIndex: 1,
      txHash: 'cd'.repeat(32),
      phase: 2,
      index: Number.MAX_SAFE_INTEGER,
    });
  });
});

describe('events', () => {
  it('round trips every decoded event shape of a generated chain', () => {
    const events: DecodedEvent[] = [];
    for (const seed of [1, 2]) {
      for (const input of generateChain(seed)) {
        if (input.kind !== 'tx' || !input.tx.payload) continue;
        const decoded = decodePayload(input.tx.payload);
        if (decoded) events.push(...decoded.events);
      }
    }
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.ok)).toBe(true);
    expect(events.some((e) => !e.ok)).toBe(true);
    for (const e of events) expect(decodeEvent(encodeEvent(e))).toEqual(e);
  });
  it('keeps a bigint above 2^53 through the tagged JSON', () => {
    const e = { ok: true, event: { tag: 'update', group: { local: 0 }, seq: 2n ** 63n, changes: {} } } as DecodedEvent;
    expect(decodeEvent(encodeEvent(e))).toEqual(e);
  });
});

describe('tx contexts', () => {
  it('round trips bigint validity and null bounds', () => {
    for (const [invalidBefore, invalidHereafter] of [
      [0n, 2n ** 63n],
      [null, null],
      [5n, null],
    ] as const) {
      const ctx = { signers: ['aa', 'bb'], requiredSigners: ['cc'], invalidBefore, invalidHereafter };
      const enc = encodeContext(ctx);
      expect(
        decodeContext({
          signers: enc.signers,
          required_signers: enc.requiredSigners,
          invalid_before: enc.invalidBefore,
          invalid_hereafter: enc.invalidHereafter,
        }),
      ).toEqual(ctx);
    }
  });
});

describe('credential keys', () => {
  it('inverts credKey for key and script credentials', () => {
    for (const c of [
      { kind: 'key', hash: '11'.repeat(28) },
      { kind: 'script', hash: '22'.repeat(28) },
    ] as const) {
      expect(credFromKey(credKey(c))).toEqual(c);
    }
    expect(() => credFromKey('nope')).toThrow();
  });
});

describe('rows', () => {
  const pos = (p: string, h: number) => ({
    [`${p}_h`]: h,
    [`${p}_ti`]: 1,
    [`${p}_ph`]: 2,
    [`${p}_ix`]: 0,
    [`${p}_tx`]: 'ab'.repeat(32),
  });
  const nullPos = (p: string) => ({ [`${p}_h`]: null, [`${p}_ti`]: null, [`${p}_ph`]: null, [`${p}_ix`]: null, [`${p}_tx`]: null });
  it('reads a version with a decimal seq above 2^53', () => {
    const v = versionFromRow({
      group_tx: 'cd'.repeat(32),
      group_ix: 0,
      ...pos('at', 9),
      mode: 'open',
      control: 'aa',
      admission: null,
      profile_url: 'https://x.test/p.json',
      profile_hash: 'bb',
      seq: '9007199254740993',
      status: 'active',
      ...pos('created', 8),
      ...nullPos('profile_set'),
    });
    expect(v.seq).toBe(9007199254740993n);
    expect(v.profile).toEqual({ url: 'https://x.test/p.json', dataHash: 'bb' });
    expect(v.profileSetAt).toBeNull();
    expect(v.at.blockHeight).toBe(9);
  });
  it('reads an instance with open approval and close', () => {
    const i = instanceFromRow({
      join_tx: 'ef'.repeat(32),
      join_ix: 1,
      group_tx: 'cd'.repeat(32),
      group_ix: 0,
      cred: `key:${'11'.repeat(28)}`,
      mode: 'permissioned',
      ...pos('joined', 4),
      ...pos('approved', 5),
      ...nullPos('closed'),
      close_reason: null,
    });
    expect(i.member).toEqual({ kind: 'key', hash: '11'.repeat(28) });
    expect(i.approvedAt?.blockHeight).toBe(5);
    expect(i.closedAt).toBeNull();
    expect(i.closeReason).toBeNull();
  });
});

describe('scriptDisplayJson', () => {
  it('caps display json depth without recursion', () => {
    let deep: NativeScript = { type: 'sig', keyHash: '11'.repeat(28) };
    for (let i = 0; i < 5000; i++) deep = { type: 'all', scripts: [deep] };
    expect(scriptDisplayJson(deep)).toBe('{"type":"tooDeep"}');
    const nOfK2of3: NativeScript = {
      type: 'nOfK',
      n: 2n,
      scripts: ['11', '22', '33'].map((h) => ({ type: 'sig', keyHash: h.repeat(28) }) as NativeScript),
    };
    expect(JSON.parse(scriptDisplayJson(nOfK2of3))).toMatchObject({ type: 'nOfK', n: '2' });
  });
});
