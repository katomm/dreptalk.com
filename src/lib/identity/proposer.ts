// Pure display resolver for a governance proposer. Maps a return_address to a
// render model the ProposerIdentity component and the GA list page both consume.
// The lookup is injectable so the branching is unit-testable without the registry.
import { getProposerByAddress, getProposers, type Proposer } from '../../../config/proposers.js';
import { truncateId } from '../forum/view.js';

export type ProposerView =
  | { kind: 'none' }
  | { kind: 'known'; name: string; icon: string | null; website: string | null }
  | { kind: 'declared'; name: string; extra: number; seed: string }
  | { kind: 'unknown'; seed: string; short: string };

/**
 * Lowercases and collapses whitespace so cosmetic variants still collide.
 * NFKC normalizes first and strips zero width and other invisible format
 * characters, because an untrusted name can insert those to render visually
 * identical to a curated org while comparing as a different string. The
 * guard only works if a spoofed name normalizes the same as the real one.
 */
function normalizeName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * True when a declared name claims a curated organisation. Reached only after the
 * registry lookup missed, so the address provably is not that organisation's: the
 * claim is an impersonation and the whole authors array is dropped. Names outside
 * the registry stay unverified, which is fine because the UI claims nothing about
 * them.
 */
function impersonatesRegistry(names: readonly string[], registry: () => readonly Proposer[]): boolean {
  const curated = new Set(registry().map((p) => normalizeName(p.name)));
  return names.some((n) => curated.has(normalizeName(n)));
}

export function proposerView(
  returnAddress: string | null | undefined,
  authorNames: readonly string[] | null = null,
  lookup: (a: string | null | undefined) => Proposer | null = getProposerByAddress,
  registry: () => readonly Proposer[] = getProposers,
): ProposerView {
  if (!returnAddress) return { kind: 'none' };
  const p = lookup(returnAddress);
  if (p) return { kind: 'known', name: p.name, icon: p.icon ?? null, website: p.website ?? null };
  if (authorNames && authorNames.length > 0 && !impersonatesRegistry(authorNames, registry)) {
    return { kind: 'declared', name: authorNames[0], extra: authorNames.length - 1, seed: returnAddress };
  }
  return { kind: 'unknown', seed: returnAddress, short: truncateId(returnAddress, 18) };
}
