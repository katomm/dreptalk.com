// Koios shaped inputs for the ingest tests: transaction CBOR around a label 8416 value and a fake
// Koios over a list of transactions and DRep registrations. Blocks follow every 20 seconds, so a
// block's time is its height times 20. Test only.
import { bytesToHex, GROUPS_LABEL, hexToBytes } from 'drep-groups';
import type { GroupsKoios } from '../ingest.js';
import { type Cbor, cbor } from './loadFixtures.js';

export { deepScriptBytes } from './engineFixtures.js';
export { ev, keyHex as K, payloadValue, sig, sigScript, txHex as T } from './loadFixtures.js';

/** A Conway transaction: body with required signers, native witness scripts, is_valid and a metadata map. */
export function txCbor(o: { payload?: Cbor; foreign?: Cbor; requiredSigners?: string[]; witnessScripts?: Cbor[] }): string {
  const body = new Map<number, Cbor>([
    [0, []],
    [1, []],
    [2, 170_000],
  ]);
  if (o.requiredSigners?.length) body.set(14, o.requiredSigners.map(hexToBytes));
  const wits = new Map<number, Cbor>();
  if (o.witnessScripts?.length) wits.set(1, o.witnessScripts);
  const value = o.foreign !== undefined ? o.foreign : o.payload;
  const aux = value === undefined ? null : new Map<number, Cbor>([[GROUPS_LABEL, value]]);
  return bytesToHex(cbor([body, wits, true, aux]));
}

export const blockTime = (h: number): number => h * 20;
/** The block hash at a height on the original chain. */
export const blockHash = (h: number): string => (0xb000_0000 + h).toString(16).padStart(64, '0');
/** The block hash at a height on a fork. */
export const forkHash = (h: number): string => (0xf000_0000 + h).toString(16).padStart(64, '0');

/** A transaction. Label txs are listed by txByMetalabel, others only serve their CBOR and position. */
export interface FakeTx {
  hash: string;
  height: number;
  index: number;
  cbor: string;
  label?: boolean;
}
export interface FakeReg {
  drepId: string;
  action: 'registered' | 'deregistered';
  hash: string;
  height: number;
  index: number;
  cert?: number;
}
export interface Chain {
  tip: number;
  txs: FakeTx[];
  regs: FakeReg[];
  /** The block hash at a height, null for no block. Defaults to blockHash. */
  hashAt?: (h: number) => string | null;
  /** Tx hashes txCborBatch leaves out. */
  leaveOut?: Set<string>;
  /** Tx hashes txStatus knows besides the chain's txs at or below the tip. */
  known?: Set<string>;
  /** UTxO refs (`hash#index`) utxoInfo reports spent, every other ref is unspent. */
  spent?: Set<string>;
}

export type FakeKoios = GroupsKoios & { calls: string[] };

export function fakeKoios(chain: Chain): FakeKoios {
  const calls: string[] = [];
  const hashOf = (h: number): string | null => (chain.hashAt ? chain.hashAt(h) : blockHash(h));
  const position = (hash: string) => {
    const t = chain.txs.find((x) => x.hash === hash) ?? chain.regs.find((x) => x.hash === hash);
    return t
      ? { tx_hash: hash, block_hash: hashOf(t.height) ?? blockHash(t.height), block_height: t.height, tx_block_index: t.index, tx_timestamp: blockTime(t.height) }
      : null;
  };
  const regRow = (r: FakeReg) => ({
    drep_id: r.drepId,
    action: r.action,
    block_time: blockTime(r.height),
    update_tx_hash: r.hash,
    cert_index: r.cert ?? 0,
  });
  const sorted = () =>
    [...chain.regs].sort((a, b) => a.height - b.height || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : (a.cert ?? 0) - (b.cert ?? 0)));
  const page = <R>(rows: R[], limit = 1000, offset = 0): R[] => rows.slice(offset, offset + limit);
  return {
    calls,
    async tip() {
      calls.push('tip');
      return { block_no: chain.tip, abs_slot: blockTime(chain.tip), epoch_no: 0 };
    },
    // One block per height, its slot is its time.
    async firstBlockAfterSlot(slot) {
      calls.push(`after:${slot}`);
      const h = Math.floor(slot / 20) + 1;
      return h <= chain.tip ? { height: h, slot: blockTime(h) } : null;
    },
    async txStatus(hashes) {
      calls.push(`status:${hashes.length}`);
      return new Map(
        hashes.map((h) => {
          const t = chain.txs.find((x) => x.hash === h && x.height <= chain.tip);
          return [h, t ? chain.tip - t.height + 1 : chain.known?.has(h) ? 1 : null];
        }),
      );
    },
    async utxoInfo(refs) {
      calls.push(`utxo:${refs.length}`);
      return refs.map((r) => ({ ...r, address: 'addr_test1x', isSpent: chain.spent?.has(`${r.txHash}#${r.index}`) ?? false }));
    },
    async txByMetalabel(_label, after, limit, offset) {
      calls.push(`label:${after}:${offset ?? 0}`);
      const rows = chain.txs
        .filter((t) => t.label !== false && t.height > after && t.height <= chain.tip)
        .sort((a, b) => a.height - b.height || a.index - b.index)
        .map((t) => ({ tx_hash: t.hash, block_hash: hashOf(t.height) ?? blockHash(t.height), block_height: t.height }));
      return page(rows, limit, offset);
    },
    async txCborBatch(hashes) {
      calls.push(`cbor:${hashes.length}`);
      return hashes.flatMap((h) => {
        const t = chain.txs.find((x) => x.hash === h);
        return t && !chain.leaveOut?.has(h) ? [{ tx_hash: h, cbor: t.cbor }] : [];
      });
    },
    async txPositionBatch(hashes) {
      return hashes.flatMap((h) => {
        const p = position(h);
        return p ? [p] : [];
      });
    },
    async drepRegistrationsSince(t, limit, offset) {
      calls.push(`regs:${t}:${offset ?? 0}`);
      return page(
        sorted()
          .filter((r) => blockTime(r.height) >= t && r.height <= chain.tip)
          .map(regRow),
        limit,
        offset,
      );
    },
    async drepRegistrationsFor(id, limit, offset) {
      calls.push(`regsFor:${offset ?? 0}`);
      return page(
        sorted()
          .filter((r) => r.drepId === id && r.height <= chain.tip)
          .map(regRow),
        limit,
        offset,
      );
    },
    async drepRegistrationsForMany(ids, limit, offset) {
      calls.push(`regsForMany:${ids.length}:${offset ?? 0}`);
      return page(
        sorted()
          .filter((r) => ids.includes(r.drepId) && r.height <= chain.tip)
          .map(regRow),
        limit,
        offset,
      );
    },
    async blockAt(h) {
      calls.push(`block:${h}`);
      const hash = h > chain.tip ? null : hashOf(h);
      return hash === null ? null : { hash, block_time: blockTime(h) };
    },
    // Koios knows an id as a DRep once it ever registered: here, when it has a registration row.
    async knownDrepIds(ids) {
      calls.push(`known:${ids.length}`);
      return new Set(ids.filter((id) => chain.regs.some((r) => r.drepId === id && r.height <= chain.tip)));
    },
  };
}
