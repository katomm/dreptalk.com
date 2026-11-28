// Labels for treasury recipient addresses. Two sources, mainnet only:
// 'proposal' from the curated config (the proposer named the address in its own
// text), 'proposer' when every withdrawal naming the address was submitted from
// that same address and it belongs to one registry proposer. The config wins.
import { RECIPIENT_LABELS, type RecipientLabel } from '../../../config/treasury-recipients.js';
import type { CardanoNetwork } from '../config/network.js';
import { recipientKeyId, type RecipientKey } from '../governance/onchain.js';
import { proposerView } from '../identity/proposer.js';
import { payoutNotes, type RecipientHistory } from './recipientHistory.js';
import type { RecipientSummary } from './recipients.js';

export type AddressLabel = { kind: 'proposal'; label: string; sourceActionId: string } | { kind: 'proposer'; name: string };

function configLabel(key: RecipientKey, labels: readonly RecipientLabel[]): AddressLabel | null {
  const hit = labels.find((l) => l.credType === key.credType && l.hash === key.hash);
  return hit ? { kind: 'proposal', label: hit.label, sourceActionId: hit.sourceActionId } : null;
}

/** Registry name when every return address equals the recipient and is a registry address. */
function proposerLabel(recipientAddress: string, returnAddresses: readonly (string | null)[]): AddressLabel | null {
  if (returnAddresses.length === 0 || returnAddresses.some((a) => a !== recipientAddress)) return null;
  const v = proposerView(recipientAddress);
  return v.kind === 'known' ? { kind: 'proposer', name: v.name } : null;
}

export function labelFor(
  s: RecipientSummary,
  network: CardanoNetwork,
  labels: readonly RecipientLabel[] = RECIPIENT_LABELS,
): AddressLabel | null {
  if (network !== 'mainnet' || !s.key || !s.address) return null;
  return configLabel(s.key, labels) ?? proposerLabel(s.address, s.shares.map((sh) => sh.action.returnAddress));
}

/**
 * Label of one payout row on an action page. `allReturnAddresses` are the return
 * addresses of every withdrawal naming the recipient (this one included), so the
 * proposer label follows the same rule as the overview, and it shows only where
 * this action's own return address is the recipient.
 */
export function labelForPayout(
  key: RecipientKey | null,
  recipientAddress: string,
  actionReturnAddress: string | null,
  allReturnAddresses: readonly (string | null)[],
  network: CardanoNetwork,
  labels: readonly RecipientLabel[] = RECIPIENT_LABELS,
): AddressLabel | null {
  if (network !== 'mainnet' || !key) return null;
  const cfg = configLabel(key, labels);
  if (cfg) return cfg;
  if (actionReturnAddress !== recipientAddress) return null;
  return proposerLabel(recipientAddress, allReturnAddresses);
}

export interface PayoutRowView {
  label: AddressLabel | null;
  notes: string[];
  history: RecipientHistory | null;
}

/**
 * Everything one payout row on an action page shows besides the amount: the
 * address label, the plain notes and the recipient history. The proposer rule
 * needs every withdrawal naming the address, the history's plus this one, and
 * the plain "same as the proposer" note is dropped when the label says it.
 */
export function payoutRowView(
  row: { key?: RecipientKey | null; address: string },
  histories: Map<string, RecipientHistory> | null | undefined,
  returnAddress: string | null,
  network: CardanoNetwork,
): PayoutRowView {
  const key = row.key ?? null;
  const history = key ? (histories?.get(recipientKeyId(key)) ?? null) : null;
  // Without the loaded histories the other withdrawals are unknown, so the
  // proposer rule cannot be judged: an empty list keeps it off.
  const all = histories == null ? [] : [returnAddress, ...(history?.items ?? []).map((i) => i.returnAddress)];
  const label = labelForPayout(key, row.address, returnAddress, all, network);
  return { label, notes: payoutNotes(row, returnAddress, label?.kind === 'proposer'), history };
}
