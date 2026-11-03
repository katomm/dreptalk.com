/// <reference types="@cloudflare/workers-types" />
// Judges an unsigned DRep group transaction with the library's engine rules over the committed D1
// state, and reads the current state of one group. Registration and member scripts of the members
// the caller names come from Koios, so a first time founder or joiner is judged by the current
// ledger answer even when DRepTalk never ingested its registration history.
import {
  type Credential,
  comparePos,
  credKey,
  decodeTransaction,
  encodeNativeScript,
  type EventRef,
  endOf,
  type Keys,
  type NativeScript,
  nativeScriptHash,
  type Pos,
  type Preview,
  previewTransaction,
  type View,
} from 'drep-groups';
import { type NativeScript as CliScript, parseNativeScriptJson } from '../cardano/nativeScript.js';
import { blake2b256 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';
import type { createKoiosClient } from '../koios/client.js';
import type { GroupState } from './actions.js';
import { drepIdForCredential } from './ids.js';
import { frontiers, load, pendingRecovery, queuedJoins, readyCredentials } from './store/reads.js';

type KoiosClient = ReturnType<typeof createKoiosClient>;

/** The preview would not be exact now. Callers answer it with 503. */
export class PreviewUnavailable extends Error {}

/**
 * Koios answers for the credentials in `asked`, all keyed by credKey: those whose DRep status is
 * registered (active or not) and the native scripts of script DReps.
 */
export interface LiveFacts {
  registered: Set<string>;
  memberScripts: Map<string, NativeScript>;
  asked: Set<string>;
}

/** cardano-cli script JSON in the library's shape. */
function toLibraryScript(s: CliScript): NativeScript {
  switch (s.type) {
    case 'sig':
      return { type: 'sig', keyHash: s.keyHash };
    case 'all':
    case 'any':
      return { type: s.type, scripts: s.scripts.map(toLibraryScript) };
    case 'atLeast':
      return { type: 'nOfK', n: BigInt(s.required), scripts: s.scripts.map(toLibraryScript) };
    case 'before':
    case 'after':
      return { type: s.type, slot: BigInt(s.slot) };
  }
}

/** A script DRep's native script, null unless Koios returns one whose hash is the credential. */
async function memberScriptOf(koios: Pick<KoiosClient, 'scriptInfo'>, hash: string): Promise<NativeScript | null> {
  const info = await koios.scriptInfo(hash);
  if (info?.type !== 'timelock') return null;
  try {
    const cli = parseNativeScriptJson(info.value);
    const s = cli ? toLibraryScript(cli) : null;
    return s && nativeScriptHash(encodeNativeScript(s)) === hash ? s : null;
  } catch {
    return null;
  }
}

/** Current registration and member scripts of the members, from Koios. Koios errors propagate. */
export async function liveFactsFor(koios: Pick<KoiosClient, 'drepInfo' | 'scriptInfo'>, members: Credential[]): Promise<LiveFacts> {
  const unique = new Map(members.map((c) => [credKey({ kind: c.kind, hash: c.hash.toLowerCase() }), { kind: c.kind, hash: c.hash.toLowerCase() }]));
  const live: LiveFacts = { registered: new Set(), memberScripts: new Map(), asked: new Set(unique.keys()) };
  await Promise.all(
    [...unique].map(async ([k, c]) => {
      const [info, script] = await Promise.all([
        koios.drepInfo(drepIdForCredential(c)),
        c.kind === 'script' ? memberScriptOf(koios, c.hash) : Promise.resolve(null),
      ]);
      if (info?.drep_status === 'registered') live.registered.add(k);
      if (script) live.memberScripts.set(k, script);
    }),
  );
  return live;
}

/** The store's view with registration and member scripts of the asked credentials answered by Koios. */
function withLive(view: View, live: LiveFacts): View {
  return {
    scriptAt: (hash, at) => view.scriptAt(hash, at),
    groupAt: (group, at) => view.groupAt(group, at),
    dissolvedAt: (group) => view.dissolvedAt(group),
    registeredAt: (c, at) => {
      const k = credKey(c);
      return live.asked.has(k) ? live.registered.has(k) : view.registeredAt(c, at);
    },
    memberScriptAt: (c, at) => {
      const k = credKey(c);
      return live.asked.has(k) ? (live.memberScripts.get(k) ?? null) : view.memberScriptAt(c, at);
    },
    firstUnregAfter: (c, at) => view.firstUnregAfter(c, at),
    instance: (join) => view.instance(join),
    latestInstance: (group, c) => view.latestInstance(group, c),
    missing: (keys) => view.missing(keys),
  };
}

/** The first height after everything ingested, R is null before the first ledger frontier. */
async function previewHeight(db: D1Database): Promise<number> {
  const f = await frontiers(db);
  return Math.max(f.L, f.R ?? f.L) + 1;
}

/**
 * Refuses unless the preview is exact: no recovery open, the ledger frontier at or above the
 * label frontier, and no engine work left (the group cursor at the end of L and no credential
 * with an input at or below its bound), which is the state in which an engine run reports no more.
 */
async function assertSettled(db: D1Database): Promise<number> {
  if ((await pendingRecovery(db)) !== null) throw new PreviewUnavailable('group index is recovering');
  const f = await frontiers(db);
  if (f.R !== null && f.R < f.L) throw new PreviewUnavailable('ledger data is catching up');
  if (comparePos(f.G, endOf(f.L)) < 0) throw new PreviewUnavailable('group index is catching up');
  const ready = await readyCredentials(db, 1, 1, { G: f.G, R: f.R });
  if (ready.some((r) => r.inputs.length > 0)) throw new PreviewUnavailable('group index is catching up');
  return Math.max(f.L, f.R ?? f.L) + 1;
}

/**
 * Every event of the transaction judged as if it were the next one on chain, with the given
 * required signers and the signer set as its vkey witnesses. The tx hash is a hash of the full
 * bytes, it only identifies the tx within the preview, which writes nothing.
 */
export async function previewGroupTx(
  db: D1Database,
  txCbor: Uint8Array,
  requiredSigners: string[],
  signerSet: string[],
  live: LiveFacts,
): Promise<Preview> {
  const blockHeight = await assertSettled(db);
  const tx = {
    ...decodeTransaction(txCbor, { txHash: bytesToHex(blake2b256(txCbor)), blockHeight, txIndex: Number.MAX_SAFE_INTEGER }),
    blockHeight,
    txIndex: Number.MAX_SAFE_INTEGER,
    requiredSigners: requiredSigners.map((k) => k.toLowerCase()),
    witnessKeyHashes: signerSet.map((k) => k.toLowerCase()),
  };
  return previewTransaction(
    {
      load: async (keys: Keys) => withLive(await load(db, keys, []), live),
      queuedJoins: (refs: EventRef[]) => queuedJoins(db, refs, []),
    },
    tx,
  );
}

const noKeys = (): Keys => ({ instances: [], latestInstances: [], groupsAt: [], scriptsAt: [], credentialAt: [] });

/** The group's committed version with its policies, null for a group the store does not hold. */
export async function readGroupState(db: D1Database, group: EventRef): Promise<GroupState | null> {
  const at: Pos = endOf(await previewHeight(db));
  const v = (await load(db, { ...noKeys(), groupsAt: [[group, at]] }, [])).groupAt(group, at);
  if (!v) return null;
  const hashes = v.admission !== null && v.admission !== v.control ? [v.control, v.admission] : [v.control];
  const scripts = await load(db, { ...noKeys(), scriptsAt: hashes.map((h): [string, Pos] => [h, at]) }, []);
  const policy = (hash: string) => {
    const s = scripts.scriptAt(hash, at);
    if (!s) throw new Error(`group policy ${hash} is not stored`);
    return Object.assign(s, { hash });
  };
  const control = policy(v.control);
  return {
    ref: v.id,
    mode: v.mode,
    status: v.status,
    seq: v.seq,
    control,
    admission: v.admission === null ? null : v.admission === v.control ? control : policy(v.admission),
  };
}
