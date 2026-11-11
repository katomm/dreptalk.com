import type {
  ChainTx,
  Credential,
  DecodedEvent,
  GroupVersion,
  NativeScript,
  Pos,
  StoredInstance,
  TxContext,
  TxPosition,
} from 'drep-groups';
import { bytesToHex, hexToBytes } from 'drep-groups';
import type { NativeScript as CliScript } from '../cardano/nativeScript.js';
import { MAX_SCRIPT_DISPLAY_DEPTH } from './constants.js';

/** A D1 result row. */
export type Row = Record<string, unknown>;

/** The order columns of a position, the keyset of a pass. */
export type Key = [number, number, number, number];
/** The keyset before the first position. */
export const START: Key = [-1, -1, -1, -1];

/** The largest tx index and event index a position takes, the index of a tx end. */
export const MAX = Number.MAX_SAFE_INTEGER;

/** The order columns of a position as binds: height, tx index, phase, index. */
export const order = (p: Pos): [number, number, number, number] => [p.blockHeight, p.txIndex, p.phase, p.index];

/** Position right after a tx. Mirrors the library's position helper of the same name, which its index does not export. */
export const afterTx = (tx: TxPosition): Pos => ({
  blockHeight: tx.blockHeight,
  txIndex: tx.txIndex,
  txHash: tx.txHash,
  phase: 2,
  index: MAX,
});

/** A BLOB column as bytes, whatever shape the driver returns it in. */
export function bytesFromCol(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return new Uint8Array(v);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  throw new Error('not a blob column');
}

/**
 * A hash or key hash as stored: its raw bytes. Only lowercase hex is accepted, the form the
 * library produces, so every stored value reads back as the exact string it was written from.
 */
export function hashBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error(`not lowercase hex: ${hex}`);
  return hexToBytes(hex);
}

/** Inverse of hashBytes. */
export function hashFromCol(v: unknown): string {
  return bytesToHex(bytesFromCol(v));
}

const optHash = (hex: string | null): Uint8Array | null => (hex === null ? null : hashBytes(hex));
export const optHashFromCol = (v: unknown): string | null => (v === null ? null : hashFromCol(v));

// A stored credential key is one kind byte and the hash, so key sorts before script as in credKey.
const CRED_KIND = { key: 0, script: 1 } as const;

/** A credKey string (`key:<hash>` or `script:<hash>`) as stored. */
export function credBytes(key: string): Uint8Array {
  const c = credFromKey(key);
  const hash = hashBytes(c.hash);
  const out = new Uint8Array(1 + hash.length);
  out[0] = CRED_KIND[c.kind];
  out.set(hash, 1);
  return out;
}

/** Inverse of credBytes: the credKey string. */
export function credKeyFromCol(v: unknown): string {
  const b = bytesFromCol(v);
  const kind = b[0] === CRED_KIND.key ? 'key' : b[0] === CRED_KIND.script ? 'script' : null;
  if (kind === null || b.length < 2) throw new Error('bad stored credential');
  return `${kind}:${bytesToHex(b.subarray(1))}`;
}

const KEY_HASH_BYTES = 28;

/** A list of key hashes as stored: the 28 byte hashes concatenated in order. */
export function hashListBytes(list: readonly string[]): Uint8Array {
  const out = new Uint8Array(list.length * KEY_HASH_BYTES);
  list.forEach((h, i) => {
    const b = hashBytes(h);
    if (b.length !== KEY_HASH_BYTES) throw new Error(`not a key hash: ${h}`);
    out.set(b, i * KEY_HASH_BYTES);
  });
  return out;
}

/** Inverse of hashListBytes. */
export function hashListFromCol(v: unknown): string[] {
  const b = bytesFromCol(v);
  if (b.length % KEY_HASH_BYTES !== 0) throw new Error('bad stored key hash list');
  const out: string[] = [];
  for (let i = 0; i < b.length; i += KEY_HASH_BYTES) out.push(bytesToHex(b.subarray(i, i + KEY_HASH_BYTES)));
  return out;
}

/** An event ref as its key columns. */
export const refBinds = (r: { txHash: string; index: number }): [Uint8Array, number] => [hashBytes(r.txHash), r.index];

/** An event ref read from its key columns. */
export const refFromCols = (tx: unknown, ix: unknown): { txHash: string; index: number } => ({
  txHash: hashFromCol(tx),
  index: Number(ix),
});

// Job keys are TEXT and some are built in SQL from the stored key columns. These give the same
// strings as the library's refKey and credKey.
/** SQL for refKey of the group in the columns `tx` and `ix`. */
export const refKeySql = (tx: string, ix: string): string => `lower(hex(${tx})) || '#' || CAST(${ix} AS INTEGER)`;
/** SQL for credKey of the stored credential in the column `cred`. */
export const credKeySql = (cred: string): string =>
  `CASE substr(${cred}, 1, 1) WHEN X'00' THEN 'key:' ELSE 'script:' END || lower(hex(substr(${cred}, 2)))`;

/** Column values of a position in the order h, ti, ph, ix, tx. */
export function posBinds(p: Pos): [number, number, number, number, Uint8Array] {
  return [p.blockHeight, p.txIndex, p.phase, p.index, hashBytes(p.txHash)];
}

function col(row: Record<string, unknown>, name: string): unknown {
  if (!(name in row)) throw new Error(`missing column ${name}`);
  return row[name];
}

/** Reads a position from its five prefixed columns. Throws on a missing or null column. */
export function posFromRow(row: Record<string, unknown>, prefix: string): Pos {
  const h = col(row, `${prefix}_h`);
  const ti = col(row, `${prefix}_ti`);
  const ph = col(row, `${prefix}_ph`);
  const ix = col(row, `${prefix}_ix`);
  const tx = col(row, `${prefix}_tx`);
  if (h === null || ti === null || ph === null || ix === null || tx === null) {
    throw new Error(`null position ${prefix}`);
  }
  if (ph !== 0 && ph !== 1 && ph !== 2) throw new Error(`bad phase in ${prefix}_ph`);
  return { blockHeight: Number(h), txIndex: Number(ti), phase: ph, index: Number(ix), txHash: hashFromCol(tx) };
}

/** Like posFromRow, but a NULL height and tx hash give null. Any other partly NULL position throws. */
export function posOrNull(row: Record<string, unknown>, prefix: string): Pos | null {
  if (col(row, `${prefix}_h`) === null && col(row, `${prefix}_tx`) === null) return null;
  return posFromRow(row, prefix);
}

/** Inverse of the library's credKey, which is `${kind}:${hash}`. */
export function credFromKey(s: string): Credential {
  const m = /^(key|script):([0-9a-f]+)$/.exec(s);
  if (!m) throw new Error(`bad credential key ${s}`);
  return { kind: m[1] as Credential['kind'], hash: m[2] };
}

function replacer(_k: string, v: unknown): unknown {
  if (typeof v === 'bigint') return { $n: v.toString() };
  if (v instanceof Uint8Array) return { $b: bytesToHex(v) };
  return v;
}

function reviver(_k: string, v: unknown): unknown {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === '$n' && typeof o.$n === 'string') return BigInt(o.$n);
    if (keys.length === 1 && keys[0] === '$b' && typeof o.$b === 'string') return hexToBytes(o.$b);
  }
  return v;
}

export function encodeEvent(e: DecodedEvent): string {
  return JSON.stringify(e, replacer);
}

export function decodeEvent(s: string): DecodedEvent {
  return JSON.parse(s, reviver) as DecodedEvent;
}

const bigOrNull = (v: bigint | null): string | null => (v === null ? null : v.toString());

export function encodeContext(c: TxContext): {
  signers: Uint8Array;
  requiredSigners: Uint8Array;
  invalidBefore: string | null;
  invalidHereafter: string | null;
} {
  return {
    signers: hashListBytes(c.signers),
    requiredSigners: hashListBytes(c.requiredSigners),
    invalidBefore: bigOrNull(c.invalidBefore),
    invalidHereafter: bigOrNull(c.invalidHereafter),
  };
}

const bigFromCol = (v: unknown): bigint | null => (v === null || v === undefined ? null : BigInt(String(v)));

/** Reads the columns signers, required_signers, invalid_before and invalid_hereafter. */
export function decodeContext(row: Record<string, unknown>): TxContext {
  return {
    signers: hashListFromCol(col(row, 'signers')),
    requiredSigners: hashListFromCol(col(row, 'required_signers')),
    invalidBefore: bigFromCol(col(row, 'invalid_before')),
    invalidHereafter: bigFromCol(col(row, 'invalid_hereafter')),
  };
}

/**
 * Column values of a version's fields mode, control, admission, profile_url, profile_hash,
 * resigned_control and resigned_admission.
 */
export const versionFieldBinds = (v: GroupVersion): unknown[] => [
  v.mode,
  hashBytes(v.control),
  optHash(v.admission),
  v.profile?.url ?? null,
  optHash(v.profile?.dataHash ?? null),
  hashListBytes(v.resignedControl),
  hashListBytes(v.resignedAdmission),
];

/** Reads a drep_group_versions row. The seq column is TEXT because it can exceed 2^53. */
export function versionFromRow(row: Record<string, unknown>): GroupVersion {
  const url = col(row, 'profile_url');
  return {
    id: { txHash: hashFromCol(col(row, 'group_tx')), index: Number(col(row, 'group_ix')) },
    at: posFromRow(row, 'at'),
    mode: String(col(row, 'mode')) as GroupVersion['mode'],
    control: hashFromCol(col(row, 'control')),
    admission: optHashFromCol(col(row, 'admission')),
    profile: url === null ? null : { url: String(url), dataHash: hashFromCol(col(row, 'profile_hash')) },
    seq: BigInt(String(col(row, 'seq'))),
    status: String(col(row, 'status')) as GroupVersion['status'],
    createdAt: posFromRow(row, 'created'),
    profileSetAt: posOrNull(row, 'profile_set'),
    resignedControl: hashListFromCol(col(row, 'resigned_control')),
    resignedAdmission: hashListFromCol(col(row, 'resigned_admission')),
  };
}

/** Reads a drep_group_instances row. */
export function instanceFromRow(row: Record<string, unknown>): StoredInstance {
  const reason = col(row, 'close_reason');
  return {
    joinId: { txHash: hashFromCol(col(row, 'join_tx')), index: Number(col(row, 'join_ix')) },
    group: { txHash: hashFromCol(col(row, 'group_tx')), index: Number(col(row, 'group_ix')) },
    member: credFromKey(credKeyFromCol(col(row, 'cred'))),
    mode: String(col(row, 'mode')) as StoredInstance['mode'],
    joinedAt: posFromRow(row, 'joined'),
    approvedAt: posOrNull(row, 'approved'),
    closedAt: posOrNull(row, 'closed'),
    closeReason: reason === null ? null : (String(reason) as StoredInstance['closeReason']),
  };
}

/**
 * Reads a non marker drep_group_txs row. required_signers and witness_key_hashes are key hash
 * lists as in hashListBytes, invalid_before and invalid_hereafter decimal TEXT. Witness scripts are not
 * stored with the tx, the group plane never reads them.
 */
export function labelTxFromRow(row: Record<string, unknown>): ChainTx {
  const payload = col(row, 'payload');
  return {
    txHash: hashFromCol(col(row, 'tx_hash')),
    blockHeight: Number(col(row, 'block_height')),
    txIndex: Number(col(row, 'tx_index')),
    isValid: Number(col(row, 'is_valid')) === 1,
    invalidBefore: bigFromCol(col(row, 'invalid_before')),
    invalidHereafter: bigFromCol(col(row, 'invalid_hereafter')),
    requiredSigners: hashListFromCol(col(row, 'required_signers')),
    witnessKeyHashes: hashListFromCol(col(row, 'witness_key_hashes')),
    payload: payload === null ? undefined : bytesFromCol(payload),
    payloadRepeated: Number(col(row, 'payload_repeated')) === 1,
    witnessScripts: [],
  };
}

function scriptDepth(root: NativeScript): number {
  let max = 0;
  const stack: Array<[NativeScript, number]> = [[root, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop() as [NativeScript, number];
    if (depth > max) max = depth;
    if (max > MAX_SCRIPT_DISPLAY_DEPTH) return max;
    if (node.type === 'all' || node.type === 'any' || node.type === 'nOfK') {
      for (const child of node.scripts) stack.push([child, depth + 1]);
    }
  }
  return max;
}

/** JSON of a native script for display. Past MAX_SCRIPT_DISPLAY_DEPTH only a marker is kept, measured without recursion. */
export function scriptDisplayJson(s: NativeScript): string {
  if (scriptDepth(s) > MAX_SCRIPT_DISPLAY_DEPTH) return '{"type":"tooDeep"}';
  return JSON.stringify(s, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

/** The native script back from its display JSON, null for the depth marker or anything unreadable. */
export function scriptFromDisplayJson(json: string): NativeScript | null {
  try {
    const s = JSON.parse(json, (k, v) => ((k === 'n' || k === 'slot') && typeof v === 'string' ? BigInt(v) : v)) as NativeScript;
    return s && typeof s === 'object' && s.type !== ('tooDeep' as string) ? s : null;
  } catch {
    return null;
  }
}

/** A cardano-cli or Koios native script in the library's shape. */
export function libraryScript(s: CliScript): NativeScript {
  switch (s.type) {
    case 'sig':
      return { type: 'sig', keyHash: s.keyHash };
    case 'all':
    case 'any':
      return { type: s.type, scripts: s.scripts.map(libraryScript) };
    case 'atLeast':
      return { type: 'nOfK', n: BigInt(s.required), scripts: s.scripts.map(libraryScript) };
    case 'before':
    case 'after':
      return { type: s.type, slot: BigInt(s.slot) };
  }
}
