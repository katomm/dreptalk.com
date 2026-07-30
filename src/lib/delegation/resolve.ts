// Pure interpretation of a FOUND Koios account_info row. Fail-closed: only a
// null delegation (none), the two auto markers, or a syntactically valid DRep id
// resolve; any other value is 'invalid' so an unexpected Koios spelling or format
// is never stored as a real DRep id. Transport (found/not_found/error) is the
// caller's job, not this resolver's.
import type { AccountInfo } from '../koios/client.js';
import { parseDrepId } from '../cardano/identity.js';

export type DelegationState =
  | { type: 'drep'; drepId: string }
  | { type: 'abstain' }
  | { type: 'no_confidence' }
  | { type: 'none' };

export type DelegationParseResult =
  | { kind: 'resolved'; state: DelegationState }
  | { kind: 'invalid'; raw: string };

// The two auto options as they appear in delegated_drep. Verify the exact
// spellings against a live Koios response at implementation time; add any real
// third form here. Do NOT document heuristic variants as verified API values.
const ABSTAIN = new Set(['abstain', 'drep_always_abstain']);
const NO_CONFIDENCE = new Set(['no_confidence', 'drep_always_no_confidence']);

export function resolveDelegation(info: AccountInfo): DelegationParseResult {
  const raw = info.delegated_drep;
  if (raw == null) return { kind: 'resolved', state: { type: 'none' } };
  const key = raw.toLowerCase();
  if (ABSTAIN.has(key)) return { kind: 'resolved', state: { type: 'abstain' } };
  if (NO_CONFIDENCE.has(key)) return { kind: 'resolved', state: { type: 'no_confidence' } };
  if (parseDrepId(raw)) return { kind: 'resolved', state: { type: 'drep', drepId: raw } };
  return { kind: 'invalid', raw };
}
