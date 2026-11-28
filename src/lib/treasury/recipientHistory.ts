// Groups treasury withdrawals by recipient so the detail page can show which
// other withdrawals named the same reward account, and builds the copy for it.
// Pure: the rows come from listTreasuryHistoryRows, already sorted newest first.
import { recipientKeyId, treasuryEntries, type RecipientKey } from '../governance/onchain.js';
import { governanceActionTitle, statusBadge } from '../governance/view.js';
import { formatAda } from '../format/ada.js';
import { truncateId } from '../forum/view.js';
import { proposerView } from '../identity/proposer.js';
import type { RecipientSummary } from './recipients.js';

export interface HistorySourceRow {
  id: string;
  title: string | null;
  status: string;
  returnAddress: string | null;
  submittedEpoch: number | null;
  submittedAt: number | null;
  slug: string | null;
  // Raw onchain_payload text.
  payload: string;
}

export interface HistoryItem {
  id: string;
  title: string;
  href: string | null;
  status: string;
  lovelace: bigint;
  returnAddress: string | null;
  submittedAt: number | null;
  submittedEpoch: number | null;
}

export interface RecipientHistory {
  items: HistoryItem[];
  enactedCount: number;
  enactedLovelace: bigint;
  others: { word: string; count: number }[];
}

// Sentence order of the non-enacted statuses, any other status follows alphabetically.
const OTHER_ORDER = ['ratified', 'active', 'pending', 'expired', 'dropped', 'closed'];

function otherRank(status: string): number {
  const i = OTHER_ORDER.indexOf(status);
  return i === -1 ? OTHER_ORDER.length : i;
}

function parsePayload(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function buildRecipientHistories(rows: HistorySourceRow[], keys: (RecipientKey | null)[]): Map<string, RecipientHistory> {
  const items = new Map<string, HistoryItem[]>();
  for (const k of keys) if (k) items.set(recipientKeyId(k), []);

  for (const r of rows) {
    // Sum this row's entries per wanted key, so a repeated recipient is one item.
    const sums = new Map<string, bigint>();
    for (const e of treasuryEntries(parsePayload(r.payload))) {
      if (!e.key) continue;
      const id = recipientKeyId(e.key);
      if (items.has(id)) sums.set(id, (sums.get(id) ?? 0n) + e.lovelace);
    }
    for (const [id, lovelace] of sums) {
      items.get(id)!.push({
        id: r.id,
        title: governanceActionTitle({ title: r.title, type: 'TreasuryWithdrawals', id: r.id }),
        href: r.slug ? `/t/${r.slug}/` : null,
        status: r.status,
        lovelace,
        returnAddress: r.returnAddress,
        submittedAt: r.submittedAt,
        submittedEpoch: r.submittedEpoch,
      });
    }
  }

  const out = new Map<string, RecipientHistory>();
  for (const [id, list] of items) out.set(id, summarizeItems(list));
  return out;
}

function summarizeItems(list: HistoryItem[]): RecipientHistory {
  let enactedCount = 0;
  let enactedLovelace = 0n;
  const counts = new Map<string, number>();
  for (const it of list) {
    if (it.status === 'enacted') {
      enactedCount++;
      enactedLovelace += it.lovelace;
    } else {
      counts.set(it.status, (counts.get(it.status) ?? 0) + 1);
    }
  }
  const others = [...counts.entries()]
    .sort(([a], [b]) => otherRank(a) - otherRank(b) || a.localeCompare(b))
    .map(([status, count]) => ({ word: statusBadge(status).label.toLowerCase(), count }));
  return { items: list, enactedCount, enactedLovelace, others };
}

/** Every withdrawal naming one address, for the address page, in the summary's order. */
export function historyFromSummary(s: RecipientSummary): RecipientHistory {
  return summarizeItems(
    s.shares.map((sh) => ({
      id: sh.action.id,
      title: governanceActionTitle({ title: sh.action.title, type: 'TreasuryWithdrawals', id: sh.action.id }),
      href: sh.action.slug ? `/t/${sh.action.slug}/` : null,
      status: sh.action.status,
      lovelace: sh.lovelace,
      returnAddress: sh.action.returnAddress,
      submittedAt: sh.action.submittedAt,
      submittedEpoch: sh.action.submittedEpoch,
    })),
  );
}

export function recipientHistorySentence(h: RecipientHistory): string {
  const n = h.items.length;
  if (n === 0) return 'No other treasury withdrawal goes to this address.';
  const parts: string[] = [];
  if (h.enactedCount > 0) parts.push(`${h.enactedCount} enacted (${formatAda(String(h.enactedLovelace))} paid)`);
  for (const o of h.others) parts.push(`${o.count} ${o.word}`);
  return `This address is the recipient in ${n} other treasury withdrawal${n === 1 ? '' : 's'}: ${parts.join(', ')}.`;
}

/** Sentence over the full list on an address page, where no action is excluded. */
export function addressHistorySentence(h: RecipientHistory): string {
  const n = h.items.length;
  const parts: string[] = [];
  if (h.enactedCount > 0) parts.push(`${h.enactedCount} enacted (${formatAda(String(h.enactedLovelace))} paid)`);
  for (const o of h.others) parts.push(`${o.count} ${o.word}`);
  return `This address is the recipient in ${n} treasury withdrawal${n === 1 ? '' : 's'}: ${parts.join(', ')}.`;
}

/** Label of the disclosure that lists the other withdrawals. */
export function recipientHistoryToggle(count: number): string {
  return count === 1 ? 'Show the withdrawal' : `Show the ${count} withdrawals`;
}

export function proposerCountLine(count: number): string {
  return count === 1 ? 'First governance action from this stake address.' : `${count} governance actions from this stake address.`;
}

/** One-line proposer for a history row: registry name or short address, null without a return address. */
export function proposerShortLabel(returnAddress: string | null): string | null {
  const v = proposerView(returnAddress);
  switch (v.kind) {
    case 'known':
      return v.name;
    case 'unknown':
      return v.short;
    case 'declared':
      return returnAddress ? truncateId(returnAddress, 18) : null;
    case 'none':
      return null;
  }
}

/** "paid" only once the treasury actually paid, which is enactment. */
export function payoutVerb(status: string): string {
  return status === 'enacted' ? 'paid to' : 'requested for';
}

export function payoutNotes(
  row: { key?: RecipientKey | null; address: string },
  returnAddress: string | null,
  // True when a label badge already names the proposer, so the plain note would repeat it.
  proposerLabelShown = false,
): string[] {
  const notes: string[] = [];
  if (row.key?.credType === 'scriptHash') notes.push('Script address');
  // Only a decoded recipient can equal an address, never the "(unknown recipient)" placeholder.
  if (row.key && returnAddress !== null && row.address === returnAddress && !proposerLabelShown) notes.push('Same stake address as the proposer.');
  return notes;
}
