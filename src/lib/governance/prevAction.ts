// Purpose-chain rules for the "previous action id" a chained Conway governance
// action needs (CIP-1694 purpose chains): NoConfidence/UpdateCommittee share
// the committee chain, NewConstitution and HardForkInitiation each have their
// own single-type chain. Pure logic only, no network and no D1, so the /ga/new
// context handler and the form field can both depend on this leaf module.
import { decodeBech32 } from '../crypto/bech32.js';
import { bytesToHex } from '../crypto/hex.js';

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
export function pickLastEnacted(rows: readonly ChainRow[]): ChainRow | null {
  let best: ChainRow | null = null;
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
export function openInChain(rows: readonly ChainRow[]): ChainRow[] {
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

const GOV_ACTION_BECH32_PREFIX = 'gov_action';
const HEX_INDEX_RE = /^([0-9a-fA-F]{64})#(\d+)$/;

/**
 * Parses a user-supplied previous-action reference, either the CIP-129
 * bech32 form (gov_action1...) or the <64-hex-tx-hash>#<index> form used as
 * the governance_actions.id key elsewhere in the app. Returns null for any
 * malformed input: wrong bech32 prefix, bad checksum, wrong payload length,
 * or a hex string that is not exactly 64 characters.
 */
export function parseGovActionRef(input: string): PrevActionRef | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const hexMatch = trimmed.match(HEX_INDEX_RE);
  if (hexMatch) {
    return { txHashHex: hexMatch[1].toLowerCase(), index: Number(hexMatch[2]) };
  }

  if (/^gov_action1[a-z0-9]+$/i.test(trimmed)) {
    try {
      const { prefix, data } = decodeBech32(trimmed.toLowerCase());
      if (prefix !== GOV_ACTION_BECH32_PREFIX) return null;
      // CIP-129 payload: 32-byte tx hash followed by a 1-byte action index.
      if (data.length !== 33) return null;
      return { txHashHex: bytesToHex(data.slice(0, 32)), index: data[32] };
    } catch {
      return null;
    }
  }

  return null;
}

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
  const chosenHash = chosen.txHashHex.toLowerCase();
  if (
    ctx.lastEnacted != null &&
    ctx.lastEnacted.txHash.toLowerCase() === chosenHash &&
    ctx.lastEnacted.index === chosen.index
  ) {
    return true;
  }
  return ctx.open.some(r => r.txHash.toLowerCase() === chosenHash && r.index === chosen.index);
}
