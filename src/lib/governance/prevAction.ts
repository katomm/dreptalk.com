// Purpose-chain rules for the "previous action id" a chained Conway governance
// action needs (CIP-1694 purpose chains): NoConfidence/UpdateCommittee share
// the committee chain, NewConstitution and HardForkInitiation each have their
// own single-type chain. Pure logic only, no network and no D1, so the /ga/new
// context handler and the form field can both depend on this leaf module.

/** A resolved previous-action reference: the tx hash and output index it points at. */
export type PrevActionRef = {
  txHashHex: string;
  index: number;
};

/** A governance action as surfaced to the prev-action field and its context. */
export type GovActionRef = {
  txHash: string;
  index: number;
  // CIP-129 bech32 gov_action1... identifier.
  id: string;
  type: string;
  title: string | null;
  proposedEpoch: number;
  version?: { major: number; minor: number };
};

// Minimal structural shape of a Koios /proposal_list row, matching the fields
// this module needs. Imported from koios/client.ts when that export exists so
// the two never drift, but kept as an independent type alias here so this
// module stays a leaf (no import of the Koios client itself).
export type ChainRow = {
  proposal_tx_hash: string;
  proposal_index: number;
  proposal_id: string;
  proposal_type: string;
  proposed_epoch?: number | null;
  ratified_epoch?: number | null;
  enacted_epoch?: number | null;
  expired_epoch?: number | null;
  dropped_epoch?: number | null;
};

// Form type names accepted by the submit page's type selector.
export type GovActionFormType =
  | 'NoConfidence'
  | 'HardForkInitiation'
  | 'NewConstitution'
  | 'UpdateCommittee'
  | 'InfoAction';

// The one runtime list of form types. Every other module that needs to
// iterate, validate or default to a form type imports this instead of
// keeping its own copy, so the list and the union type can't drift.
export const GOV_ACTION_FORM_TYPES = [
  'InfoAction',
  'NoConfidence',
  'HardForkInitiation',
  'NewConstitution',
  'UpdateCommittee',
] as const satisfies readonly GovActionFormType[];

// Compile-time guard: fails to typecheck if a union member is ever added to
// GovActionFormType without adding it to the list above.
type MissingFormType = Exclude<GovActionFormType, (typeof GOV_ACTION_FORM_TYPES)[number]>;
const _exhaustiveFormTypes: MissingFormType extends never ? true : never = true;
void _exhaustiveFormTypes;

// Purpose chains keyed by their Koios proposal_type names. NoConfidence and
// NewCommittee (Koios's name for what the form calls UpdateCommittee) share
// one chain because either can supersede the sitting committee.
const COMMITTEE_CHAIN = ['NoConfidence', 'NewCommittee'] as const;
const CONSTITUTION_CHAIN = ['NewConstitution'] as const;
const HARD_FORK_CHAIN = ['HardForkInitiation'] as const;

/**
 * The Koios proposal_type name for a form type. The two vocabularies differ in
 * exactly one place: the form calls it UpdateCommittee, Koios calls it
 * NewCommittee (the same name COMMITTEE_CHAIN above uses). Every other form
 * type is spelled the same on both sides, so it maps to itself.
 */
export function koiosProposalType(formType: GovActionFormType): string {
  return formType === 'UpdateCommittee' ? 'NewCommittee' : formType;
}

/** Returns the Koios proposal_type names in the form type's purpose chain, or null when the type is unchained (InfoAction). */
export function chainForType(type: GovActionFormType): readonly string[] | null {
  switch (type) {
    case 'NoConfidence':
    case 'UpdateCommittee':
      return COMMITTEE_CHAIN;
    case 'NewConstitution':
      return CONSTITUTION_CHAIN;
    case 'HardForkInitiation':
      return HARD_FORK_CHAIN;
    case 'InfoAction':
      return null;
  }
}

/**
 * Picks the chain root among a purpose chain's rows: the one with the highest
 * ratified_epoch. Koios sets ratified_epoch as soon as ratification happens
 * and fills enacted_epoch only later at the epoch boundary, so ratified_epoch
 * is the earliest reliable signal of which row is now the chain's root.
 * Returns null when no row in the chain has been ratified yet.
 */
export function pickLastEnacted<T extends ChainRow>(rows: readonly T[]): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (r.ratified_epoch == null) continue;
    if (best == null || (best.ratified_epoch as number) < r.ratified_epoch) {
      best = r;
    }
  }
  return best;
}

/**
 * Rows still open in a purpose chain: none of ratified, enacted, expired or
 * dropped has happened yet. Sorted by proposed_epoch descending (newest
 * first), stable for ties so callers get a deterministic order.
 */
export function openInChain<T extends ChainRow>(rows: readonly T[]): T[] {
  return rows
    .map((r, i) => ({ r, i }))
    .filter(
      ({ r }) =>
        r.ratified_epoch == null &&
        r.enacted_epoch == null &&
        r.expired_epoch == null &&
        r.dropped_epoch == null,
    )
    .sort((a, b) => (b.r.proposed_epoch ?? 0) - (a.r.proposed_epoch ?? 0) || a.i - b.i)
    .map(({ r }) => r);
}

/**
 * True when a candidate row is the action a PrevActionRef points at. The two
 * sides spell the tx hash differently (a ref carries txHashHex, a row carries
 * txHash) and their casing is not guaranteed to agree, so the hash is compared
 * case-insensitively and the index exactly. The one place this comparison is
 * written, so no caller can drift into a case-sensitive version of it.
 */
export function matchesRef(ref: PrevActionRef, candidate: { txHash: string; index: number }): boolean {
  return ref.txHashHex.toLowerCase() === candidate.txHash.toLowerCase() && ref.index === candidate.index;
}

/**
 * The "<64-hex-txHash>#<index>" key shape, which is what governance_actions.id
 * holds and what formatGovActionKey below writes. Lowercase only, since that
 * is how the tx hash and the stored id are both written (see sync.ts, which
 * keys the id off proposal_tx_hash straight from Koios). The one place this
 * shape is spelled out, so a route and a transaction builder cannot end up
 * accepting slightly different ids.
 */
export const GOV_ACTION_KEY_RE = /^[0-9a-f]{64}#\d{1,5}$/;

/** Formats a PrevActionRef as the "<txHashHex>#<index>" key used as governance_actions.id. */
export function formatGovActionKey(ref: PrevActionRef): string {
  return `${ref.txHashHex}#${ref.index}`;
}

/**
 * True when the chosen previous-action ref is still valid against the fresh
 * chain context: it matches the chain's last-enacted root, or it is one of
 * the still-open rows in the chain. When chosen is null (the user is
 * submitting the first proposal of an empty chain, e.g. the preprod
 * constitution chain today), the result is true exactly when the chain has
 * no last-enacted root either, so an empty selection cannot go stale under
 * one that silently gained a root between page load and submit.
 */
export function refStillPresent(
  chosen: PrevActionRef | null,
  ctx: { lastEnacted: GovActionRef | null; open: readonly GovActionRef[] },
): boolean {
  if (chosen === null) return ctx.lastEnacted === null;
  if (ctx.lastEnacted != null && matchesRef(chosen, ctx.lastEnacted)) return true;
  return ctx.open.some(r => matchesRef(chosen, r));
}
