// Detection of pasted on-chain identifiers, checked before any full-text
// work. A resolved identifier short-circuits the search entirely (point
// lookup instead of index scan). Detection is pure; resolution against D1
// lives in lib/db/search.ts.

export type IdentifierQuery =
  | { kind: 'gov-action'; by: 'proposal_id' | 'id' | 'id-prefix'; value: string }
  | { kind: 'drep'; drepId: string };

/** Returns the identifier interpretation of q, or null when q is free text. */
export function detectIdentifier(q: string): IdentifierQuery | null {
  const s = q.trim().toLowerCase();
  if (/^gov_action1[a-z0-9]+$/.test(s)) {
    return { kind: 'gov-action', by: 'proposal_id', value: s };
  }
  if (/^drep(_script)?1[a-z0-9]+$/.test(s)) {
    return { kind: 'drep', drepId: s };
  }
  const hash = s.match(/^([0-9a-f]{64})(?:#(\d{1,6}))?$/);
  if (hash) {
    // DB ids are "<txHash>#<index>"; a bare hash matches by prefix (hex only,
    // so no LIKE wildcard can hide inside the value).
    return hash[2] != null
      ? { kind: 'gov-action', by: 'id', value: `${hash[1]}#${hash[2]}` }
      : { kind: 'gov-action', by: 'id-prefix', value: `${hash[1]}#%` };
  }
  return null;
}
