// Pure display resolver for a governance proposer. Maps a return_address to a
// render model the ProposerIdentity component and the GA list page both consume.
// The lookup is injectable so the branching is unit-testable without the registry.
import { getProposerByAddress, type Proposer } from '../../../config/proposers.js';
import { truncateId } from '../forum/view.js';

export type ProposerView =
  | { kind: 'none' }
  | { kind: 'known'; name: string; icon: string | null; website: string | null }
  | { kind: 'unknown'; seed: string; short: string };

export function proposerView(
  returnAddress: string | null | undefined,
  lookup: (a: string | null | undefined) => Proposer | null = getProposerByAddress,
): ProposerView {
  if (!returnAddress) return { kind: 'none' };
  const p = lookup(returnAddress);
  if (p) return { kind: 'known', name: p.name, icon: p.icon ?? null, website: p.website ?? null };
  return { kind: 'unknown', seed: returnAddress, short: truncateId(returnAddress, 18) };
}
