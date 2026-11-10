// The history of a group page as a timeline: the applied events of one transaction read as one
// entry, worded by describeHistory. Pure, the page reads the events, versions, signers, policies,
// profiles and names. Policy and profile changes compare the version a transaction made with the
// version before it, both stored per change.
import type { Credential } from 'drep-groups';
import { describeHistory, type GroupChanges, type HistoryKind, type Names, noChanges, type ProfileFields, policyShape } from './describe.js';
import { type ScriptView, withoutResigned } from './view.js';

export interface HistoryInput {
  events: Array<{ txHash: string; eventIndex: number; tag: string; subject: Credential | null; blockHeight: number }>;
  /** Oldest first, the version before the oldest event's included when there is one. */
  versions: Array<{
    txHash: string;
    control: string;
    admission: string | null;
    profileHash: string | null;
    /** Keys resigned from each role, absent read as none. */
    resignedControl?: string[];
    resignedAdmission?: string[];
  }>;
  /** Key hashes that signed each transaction, payment keys included. */
  signers: ReadonlyMap<string, string[]>;
}

export interface HistoryEntry {
  txHash: string;
  blockHeight: number;
  kind: HistoryKind;
  text: string;
}

/**
 * One entry per transaction, newest first as the events come. Signers are narrowed to the keys of
 * the policies in force before the transaction. A profile is compared when both
 * documents are known, else the entry only says that it was updated.
 */
export function historyEntries(
  input: HistoryInput,
  ctx: {
    mode: 'open' | 'permissioned';
    scripts: ReadonlyMap<string, ScriptView | null>;
    profiles: ReadonlyMap<string, ProfileFields | null>;
    policyKeys: ReadonlySet<string>;
    names: Names;
  },
): HistoryEntry[] {
  const byTx = new Map<string, HistoryInput['events']>();
  for (const e of input.events) {
    const list = byTx.get(e.txHash);
    if (list) list.push(e);
    else byTx.set(e.txHash, [e]);
  }
  const script = (h: string | null | undefined): ScriptView | null => (h ? (ctx.scripts.get(h) ?? null) : null);
  const profile = (h: string | null | undefined): ProfileFields | null => (h ? (ctx.profiles.get(h) ?? null) : null);

  // The version in force before each transaction: walk the transactions oldest first, starting
  // from a version no listed transaction made, which is the one before the oldest event.
  const listed = new Set(byTx.keys());
  const made = (tx: string) => input.versions.filter((v) => v.txHash === tx).at(-1) ?? null;
  let current = input.versions.filter((v) => !listed.has(v.txHash)).at(-1) ?? null;
  const beforeOf = new Map<string, HistoryInput['versions'][number] | null>();
  for (const tx of [...byTx.keys()].reverse()) {
    beforeOf.set(tx, current);
    current = made(tx) ?? current;
  }
  type Version = HistoryInput['versions'][number];
  const lower = (ks: string[] | undefined): string[] => (ks ?? []).map((k) => k.toLowerCase());
  /**
   * The key a resign event of the transaction recorded: per role, the keys resigned after it and
   * not before, since a key can still be resigned from one role when it resigns from the other.
   * Without the version before, only a single resigned key is certain.
   */
  const resignedKey = (before: Version | null, after: Version | null): string | null => {
    const fresh = (was: string[] | undefined, now: string[] | undefined) => withoutResigned(lower(now), was);
    const keys = [...new Set([...fresh(before?.resignedControl, after?.resignedControl), ...fresh(before?.resignedAdmission, after?.resignedAdmission)])];
    return keys.length === 1 || (before && keys.length > 0) ? keys[0] : null;
  };
  const keysOf = (v: HistoryInput['versions'][number] | null): Set<string> =>
    new Set([script(v?.control), script(v?.admission)].flatMap((x) => policyShape(x)?.keys ?? []));

  return [...byTx].map(([txHash, list]) => {
    const events = [...list].sort((a, b) => a.eventIndex - b.eventIndex);
    const c: GroupChanges = noChanges(ctx.mode);
    const after = made(txHash);
    const before = beforeOf.get(txHash) ?? null;
    for (const e of events) {
      switch (e.tag) {
        case 'create':
          if (after) c.create = { control: script(after.control), admission: after.admission === null ? null : after.admission === after.control ? 'same' : script(after.admission) };
          else c.create = { control: null, admission: null };
          break;
        case 'update':
          if (!after) break;
          if (before?.control !== after.control) c.control = { before: script(before?.control), after: script(after.control) };
          if (before?.admission !== after.admission) {
            c.admission =
              c.control && after.admission === after.control ? 'same' : { before: script(before?.admission), after: script(after.admission) };
          }
          if (before?.profileHash !== after.profileHash) c.profile = { before: profile(before?.profileHash), after: profile(after.profileHash) };
          break;
        case 'dissolve':
          c.dissolve = true;
          break;
        case 'join':
          c.joins.push(e.subject);
          break;
        case 'approve':
          c.approvals.push(e.subject);
          break;
        case 'leave':
          c.leaves.push(e.subject);
          break;
        case 'remove':
          c.removals.push(e.subject);
          break;
        case 'resign':
          c.resigned = resignedKey(before, after);
          break;
      }
    }
    // Signers are the keys of the policies in force before, so the fee payer and newly added keys are not named.
    const inForce = before ? keysOf(before) : ctx.policyKeys;
    const signers = [...new Set(input.signers.get(txHash) ?? [])].filter((k) => inForce.has(k));
    return { txHash, blockHeight: events[0].blockHeight, ...describeHistory(c, signers, ctx.names) };
  });
}
