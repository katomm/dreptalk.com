/// <reference types="@cloudflare/workers-types" />
// The bounded view the engine reads through. Every answer is read at load time for the key it
// belongs to, a key that was not loaded is reported by `missing` and answered with nothing.
import type {
  ChangeSet,
  Credential,
  EventRef,
  GroupVersion,
  Hex,
  Keys,
  NativeScript,
  Pos,
  StoredInstance,
  View,
} from 'drep-groups';
import { credKey, parseNativeScript, refKey } from 'drep-groups';
import { chunked, D1_MAX_BINDS } from '../../db/sql.js';
import {
  bytesFromCol,
  credBytes,
  credKeyFromCol,
  hashBytes,
  hashFromCol,
  instanceFromRow,
  order,
  posOrNull,
  refBinds,
  refFromCols,
  versionFromRow,
  type Row,
} from '../codec.js';
import { KEYED, KEYED_WIDTH } from './queries.js';

/** Mirrors the library's position key, which its index does not export. */
const posKey = (p: Pick<Pos, 'blockHeight' | 'txIndex' | 'phase' | 'index'>): string =>
  `${p.blockHeight},${p.txIndex},${p.phase},${p.index}`;

const rowPosKey = (r: Row): string => `${r.k_h},${r.k_ti},${r.k_ph},${r.k_ix}`;

function scriptFromCol(v: unknown): NativeScript | null {
  if (v === null || v === undefined) return null;
  const s = parseNativeScript(bytesFromCol(v));
  if (s === null) throw new Error('stored native script does not parse');
  return s;
}

class D1View implements View {
  readonly loaded = new Set<string>();
  readonly scripts = new Map<string, NativeScript | null>();
  readonly groups = new Map<string, GroupVersion | null>();
  readonly dissolves = new Map<string, Pos | null>();
  readonly credentials = new Map<string, { registered: boolean; unregAfter: Pos | null; memberScript: NativeScript | null }>();
  readonly instances = new Map<string, StoredInstance | null>();
  readonly latest = new Map<string, StoredInstance | null>();

  scriptAt(hash: Hex, at: Pos): NativeScript | null {
    return this.scripts.get(`s:${hash}@${posKey(at)}`) ?? null;
  }
  groupAt(group: EventRef, at: Pos): GroupVersion | null {
    return this.groups.get(`g:${refKey(group)}@${posKey(at)}`) ?? null;
  }
  dissolvedAt(group: EventRef): Pos | null {
    return this.dissolves.get(refKey(group)) ?? null;
  }
  registeredAt(c: Credential, at: Pos): boolean {
    return this.credentials.get(`c:${credKey(c)}@${posKey(at)}`)?.registered ?? false;
  }
  memberScriptAt(c: Credential, at: Pos): NativeScript | null {
    return this.credentials.get(`c:${credKey(c)}@${posKey(at)}`)?.memberScript ?? null;
  }
  firstUnregAfter(c: Credential, at: Pos): Pos | null {
    return this.credentials.get(`c:${credKey(c)}@${posKey(at)}`)?.unregAfter ?? null;
  }
  instance(join: EventRef): StoredInstance | null {
    return this.instances.get(refKey(join)) ?? null;
  }
  latestInstance(group: EventRef, c: Credential): StoredInstance | null {
    return this.latest.get(`${refKey(group)}|${credKey(c)}`) ?? null;
  }
  missing(k: Keys): Keys {
    const out = (s: string): boolean => !this.loaded.has(s);
    return {
      instances: k.instances.filter((r) => out(`i:${refKey(r)}`)),
      latestInstances: k.latestInstances.filter(([g, c]) => out(`l:${refKey(g)}|${credKey(c)}`)),
      groupsAt: k.groupsAt.filter(([g, p]) => out(`g:${refKey(g)}@${posKey(p)}`)),
      scriptsAt: k.scriptsAt.filter(([h, p]) => out(`s:${h}@${posKey(p)}`)),
      credentialAt: k.credentialAt.filter(([c, p]) => out(`c:${credKey(c)}@${posKey(p)}`)),
    };
  }
}

/** One statement per chunk of keys, each at or below the bind limit. */
function keyed<K>(db: D1Database, name: keyof typeof KEYED, keys: K[], binds: (k: K) => unknown[]): D1PreparedStatement[] {
  return chunked(keys, Math.floor(D1_MAX_BINDS / KEYED_WIDTH[name])).map((c) =>
    db.prepare(KEYED[name](c.length)).bind(...c.flatMap(binds)),
  );
}

/**
 * Loads exactly the given keys. The overlay is not read: the engine asks the view only for what
 * its change sets do not answer, and the view never merges change sets.
 */
export async function load(db: D1Database, keys: Keys, _overlay: ChangeSet[]): Promise<View> {
  const parts: Array<[keyof typeof KEYED, D1PreparedStatement[]]> = [
    ['loadInstances', keyed(db, 'loadInstances', keys.instances, refBinds)],
    [
      'loadLatestInstances',
      keyed(db, 'loadLatestInstances', keys.latestInstances, ([g, c]) => [...refBinds(g), credBytes(credKey(c))]),
    ],
    ['loadGroupsAt', keyed(db, 'loadGroupsAt', keys.groupsAt, ([g, p]) => [...refBinds(g), ...order(p)])],
    ['loadScriptsAt', keyed(db, 'loadScriptsAt', keys.scriptsAt, ([h, p]) => [hashBytes(h), ...order(p)])],
    ['loadCredentialsAt', keyed(db, 'loadCredentialsAt', keys.credentialAt, ([c, p]) => [credBytes(credKey(c)), ...order(p)])],
  ];
  const stmts = parts.flatMap(([, s]) => s);
  const results = stmts.length === 0 ? [] : await db.batch<Row>(stmts);
  const v = new D1View();
  let i = 0;
  for (const [name, s] of parts) {
    for (const res of results.slice(i, i + s.length)) {
      for (const r of res.results ?? []) read(v, name, r);
    }
    i += s.length;
  }
  return v;
}

function read(v: D1View, name: keyof typeof KEYED, r: Row): void {
  switch (name) {
    case 'loadInstances': {
      const k = refKey(refFromCols(r.k_tx, r.k_ix));
      v.loaded.add(`i:${k}`);
      v.instances.set(k, r.join_tx === null ? null : instanceFromRow(r));
      return;
    }
    case 'loadLatestInstances': {
      const k = `${refKey(refFromCols(r.k_gtx, r.k_gix))}|${credKeyFromCol(r.k_cred)}`;
      v.loaded.add(`l:${k}`);
      v.latest.set(k, r.join_tx === null ? null : instanceFromRow(r));
      return;
    }
    case 'loadGroupsAt': {
      const g = refKey(refFromCols(r.k_gtx, r.k_gix));
      const k = `g:${g}@${rowPosKey(r)}`;
      v.loaded.add(k);
      v.groups.set(k, r.group_tx === null ? null : versionFromRow(r));
      if (!v.dissolves.has(g)) v.dissolves.set(g, posOrNull(r, 'dis'));
      return;
    }
    case 'loadScriptsAt': {
      const k = `s:${hashFromCol(r.k_hash)}@${rowPosKey(r)}`;
      v.loaded.add(k);
      v.scripts.set(k, scriptFromCol(r.bytes));
      return;
    }
    case 'loadCredentialsAt': {
      const k = `c:${credKeyFromCol(r.k_cred)}@${rowPosKey(r)}`;
      v.loaded.add(k);
      const unregAfter: Pos | null =
        r.u_h === null
          ? null
          : { blockHeight: Number(r.u_h), txIndex: Number(r.u_ti), phase: 0, index: Number(r.u_ix), txHash: hashFromCol(r.u_tx) };
      v.credentials.set(k, { registered: r.last_kind === 'reg', unregAfter, memberScript: scriptFromCol(r.m_bytes) });
      return;
    }
    default:
      throw new Error(`not a view statement: ${name}`);
  }
}
