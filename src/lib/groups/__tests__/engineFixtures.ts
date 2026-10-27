/// <reference types="@cloudflare/workers-types" />
// Engine change sets built directly from the library types, no engine run, plus helpers that
// measure what a commit binds.
import type {
  ChangeSet,
  Credential,
  CursorUpdate,
  EventRef,
  GroupVersion,
  NativeScript,
  Pos,
  StoredInstance,
} from 'drep-groups';
import { parseNativeScript } from 'drep-groups';
import type { PreRead } from '../store/commit.js';

export type Unit = { change: ChangeSet; cursor: CursorUpdate };

export const hex = (n: number, len = 56): string => n.toString(16).padStart(len, '0');
export const txHashOf = (h: number, ti = 0): string => hex(h * 100 + ti, 64);
export const pos = (h: number, ti = 0, ph: 0 | 1 | 2 = 2, ix = 0): Pos => ({
  blockHeight: h,
  txIndex: ti,
  phase: ph,
  index: ix,
  txHash: txHashOf(h, ti),
});
export const ref = (h: number, ix = 0, ti = 0): EventRef => ({ txHash: txHashOf(h, ti), index: ix });
export const keyCred = (n: number): Credential => ({ kind: 'key', hash: hex(n) });

export const emptyChange = (): ChangeSet => ({
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

export const emptyPreRead = (): PreRead => ({
  instances: new Map(),
  dissolves: new Map(),
  firstUnreg: new Map(),
  verdictsKnown: new Set(),
  groups: new Map(),
});

/** A version of a group created at `created`, written at `at`. */
export function version(group: EventRef, created: Pos, at: Pos, over: Partial<GroupVersion> = {}): GroupVersion {
  return {
    id: group,
    at,
    mode: 'open',
    control: hex(1),
    admission: null,
    profile: null,
    seq: 0n,
    status: 'active',
    createdAt: created,
    profileSetAt: null,
    ...over,
  };
}

export function instance(join: EventRef, group: EventRef, member: Credential, joinedAt: Pos, over: Partial<StoredInstance> = {}): StoredInstance {
  return {
    joinId: join,
    group,
    member,
    mode: 'open',
    joinedAt,
    approvedAt: null,
    closedAt: null,
    closeReason: null,
    ...over,
  };
}

// CBOR of the native script [0, h'..'], a single signature.
export function sigScriptBytes(n: number): Uint8Array {
  const h = hex(n);
  const out = new Uint8Array(4 + 28);
  out.set([0x82, 0x00, 0x58, 0x1c]);
  for (let i = 0; i < 28; i++) out[4 + i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** CBOR of `depth` nested `all` scripts around one signature: [1, [[1, [ ... [0, h] ]]]]. */
export function deepScriptBytes(depth: number): Uint8Array {
  const sig = sigScriptBytes(1);
  const out = new Uint8Array(3 * (depth - 1) + sig.length);
  for (let i = 0; i < depth - 1; i++) out.set([0x82, 0x01, 0x81], i * 3);
  out.set(sig, 3 * (depth - 1));
  return out;
}

export function deepScript(depth: number): { bytes: Uint8Array; script: NativeScript } {
  const bytes = deepScriptBytes(depth);
  const script = parseNativeScript(bytes);
  if (script === null) throw new Error('deep script does not parse');
  return { bytes, script };
}

/** Wraps a database so every bind records its parameter count. */
export function bindCountingDb(db: D1Database): { db: D1Database; maxBinds: () => number } {
  let max = 0;
  const wrapStmt = (st: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(st, {
      get(target, p) {
        if (p === 'bind') {
          return (...args: unknown[]) => {
            max = Math.max(max, args.length);
            return target.bind(...args);
          };
        }
        const v = Reflect.get(target, p);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  const counted = new Proxy(db, {
    get(target, p) {
      if (p === 'prepare') return (sql: string) => wrapStmt(target.prepare(sql));
      const v = Reflect.get(target, p);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { db: counted, maxBinds: () => max };
}

/**
 * Group units of `txs` label txs. Each tx publishes 8 scripts and carries 64 events: 32 updates
 * of 32 distinct groups, each with a new anchor and a verdict, and 32 joins queued for 32
 * distinct subjects.
 */
export function worstCaseGroupUnits(txs: number): Unit[] {
  const units: Unit[] = [];
  for (let t = 0; t < txs; t++) {
    const h = 1000 + t;
    const change = emptyChange();
    for (let s = 0; s < 8; s++) {
      const bytes = sigScriptBytes(t * 100 + s + 1);
      change.scripts.push({ hash: hex(t * 100 + s + 1), script: parseNativeScript(bytes) as NativeScript, bytes, at: pos(h, 0, 1, -1) });
    }
    for (let e = 0; e < 32; e++) {
      const group = ref(10 + t * 32 + e);
      const at = pos(h, 0, 2, e);
      change.versions.push(
        version(group, pos(10 + t * 32 + e), at, {
          seq: BigInt(e + 1),
          profile: { url: `https://example.org/${t}/${e}.json`, dataHash: hex(e, 64) },
          profileSetAt: at,
        }),
      );
      change.verdicts.push({
        ref: { txHash: at.txHash, index: e },
        tag: 'update',
        valid: true,
        reason: null,
        at,
        group,
        subject: null,
      });
    }
    for (let e = 32; e < 64; e++) {
      const at = pos(h, 0, 2, e);
      const group = ref(10 + t * 32 + (e - 32));
      const subject = keyCred(t * 100 + e);
      change.queued.push({
        subject,
        at,
        group,
        txHash: at.txHash,
        event: { ok: true, event: { tag: 'join', group, member: subject } },
      });
    }
    change.txContexts.push({
      txHash: txHashOf(h),
      context: { signers: [hex(1)], requiredSigners: [hex(1)], invalidBefore: null, invalidHereafter: 100n },
    });
    units.push({ change, cursor: { kind: 'group', G: { ...pos(h), index: Number.MAX_SAFE_INTEGER } } });
  }
  return units;
}

/** Credential units, each with `inputs / units` inputs, every input a join into a group of its own. */
export function worstCaseCredentialUnits(units: number, inputs: number): Unit[] {
  const per = Math.floor(inputs / units);
  const out: Unit[] = [];
  for (let u = 0; u < units; u++) {
    const c = keyCred(5000 + u);
    const change = emptyChange();
    let last = pos(2000);
    for (let i = 0; i < per; i++) {
      const h = 2000 + u * per + i;
      const at = pos(h, 0, 2, 0);
      const group = ref(100 + u * per + i);
      const join = { txHash: at.txHash, index: 0 };
      const inst = instance(join, group, c, at);
      change.instances.push(inst);
      change.effects.push({ kind: 'instanceCreated', instance: inst });
      change.appliedQueue.push(join);
      change.verdicts.push({ ref: join, tag: 'join', valid: true, reason: null, at, group, subject: c });
      last = at;
    }
    out.push({ change, cursor: { kind: 'credential', credential: c, appliedThrough: last } });
  }
  return out;
}
