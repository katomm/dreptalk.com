import type {
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
import { MAX_SCRIPT_DISPLAY_DEPTH } from './constants.js';

export type PosRow = Record<`${string}_h` | `${string}_ti` | `${string}_ph` | `${string}_ix` | `${string}_tx`, unknown>;

/** Position right after a tx. Mirrors the library's position helper of the same name, which its index does not export. */
export const afterTx = (tx: TxPosition): Pos => ({
  blockHeight: tx.blockHeight,
  txIndex: tx.txIndex,
  txHash: tx.txHash,
  phase: 2,
  index: Number.MAX_SAFE_INTEGER,
});

/** Column values of a position in the order h, ti, ph, ix, tx. */
export function posBinds(p: Pos): [number, number, number, number, string] {
  return [p.blockHeight, p.txIndex, p.phase, p.index, p.txHash];
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
  return { blockHeight: Number(h), txIndex: Number(ti), phase: ph, index: Number(ix), txHash: String(tx) };
}

/** Like posFromRow, but all five columns NULL gives null. */
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
  signers: string;
  requiredSigners: string;
  invalidBefore: string | null;
  invalidHereafter: string | null;
} {
  return {
    signers: JSON.stringify(c.signers),
    requiredSigners: JSON.stringify(c.requiredSigners),
    invalidBefore: bigOrNull(c.invalidBefore),
    invalidHereafter: bigOrNull(c.invalidHereafter),
  };
}

const bigFromCol = (v: unknown): bigint | null => (v === null || v === undefined ? null : BigInt(String(v)));

/** Reads the columns signers, required_signers, invalid_before and invalid_hereafter. */
export function decodeContext(row: Record<string, unknown>): TxContext {
  return {
    signers: JSON.parse(String(col(row, 'signers'))) as string[],
    requiredSigners: JSON.parse(String(col(row, 'required_signers'))) as string[],
    invalidBefore: bigFromCol(col(row, 'invalid_before')),
    invalidHereafter: bigFromCol(col(row, 'invalid_hereafter')),
  };
}

/** Reads a drep_group_versions row. The seq column is TEXT because it can exceed 2^53. */
export function versionFromRow(row: Record<string, unknown>): GroupVersion {
  const url = col(row, 'profile_url');
  return {
    id: { txHash: String(col(row, 'group_tx')), index: Number(col(row, 'group_ix')) },
    at: posFromRow(row, 'at'),
    mode: String(col(row, 'mode')) as GroupVersion['mode'],
    control: String(col(row, 'control')),
    admission: col(row, 'admission') === null ? null : String(col(row, 'admission')),
    profile: url === null ? null : { url: String(url), dataHash: String(col(row, 'profile_hash')) },
    seq: BigInt(String(col(row, 'seq'))),
    status: String(col(row, 'status')) as GroupVersion['status'],
    createdAt: posFromRow(row, 'created'),
    profileSetAt: posOrNull(row, 'profile_set'),
  };
}

/** Reads a drep_group_instances row. */
export function instanceFromRow(row: Record<string, unknown>): StoredInstance {
  const reason = col(row, 'close_reason');
  return {
    joinId: { txHash: String(col(row, 'join_tx')), index: Number(col(row, 'join_ix')) },
    group: { txHash: String(col(row, 'group_tx')), index: Number(col(row, 'group_ix')) },
    member: credFromKey(String(col(row, 'cred'))),
    mode: String(col(row, 'mode')) as StoredInstance['mode'],
    joinedAt: posFromRow(row, 'joined'),
    approvedAt: posOrNull(row, 'approved'),
    closedAt: posOrNull(row, 'closed'),
    closeReason: reason === null ? null : (String(reason) as StoredInstance['closeReason']),
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
