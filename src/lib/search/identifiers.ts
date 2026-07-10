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
    // DB ids are "<txHash>#<index>"; a bare hash matches by SUBSTR prefix in
    // lib/db/search.ts (see comment there for the SUBSTR-vs-LIKE rationale).
    return hash[2] != null
      ? { kind: 'gov-action', by: 'id', value: `${hash[1]}#${hash[2]}` }
      : { kind: 'gov-action', by: 'id-prefix', value: `${hash[1]}#` };
  }
  // CIP-129 hex form (explorer.cardano.org and similar tools): the 64-hex tx
  // hash with the action index appended as hex bytes and no '#', e.g.
  // "...e0ccf0a" where 0a = index 10. Decode the byte(s) to the decimal index
  // so it resolves to the same "<txHash>#<index>" DB id as the other forms.
  const cip129 = s.match(/^([0-9a-f]{64})((?:[0-9a-f]{2}){1,4})$/);
  if (cip129) {
    return { kind: 'gov-action', by: 'id', value: `${cip129[1]}#${parseInt(cip129[2], 16)}` };
  }
  return null;
}
