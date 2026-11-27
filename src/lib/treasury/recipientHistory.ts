// Groups treasury withdrawals by recipient so the detail page can show which
// other withdrawals named the same reward account, and builds the copy for it.
// Pure: the rows come from listTreasuryHistoryRows, already sorted newest first.
import { recipientKeyId, treasuryEntries, type RecipientKey } from '../governance/onchain.js';
import { governanceActionTitle, statusBadge } from '../governance/view.js';
import { formatAda } from '../format/ada.js';
import { truncateId } from '../forum/view.js';
import { proposerView } from '../identity/proposer.js';

export interface HistorySourceRow {
  id: string;
  proposalId: string | null;
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
  if (items.size === 0) return new Map();

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
  for (const [id, list] of items) {
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
    out.set(id, { items: list, enactedCount, enactedLovelace, others });
  }
  return out;
}

export function recipientHistorySentence(h: RecipientHistory): string {
  const n = h.items.length;
  if (n === 0) return 'No other treasury withdrawal names this address.';
  let s = `Named in ${n} other treasury withdrawal${n === 1 ? '' : 's'}`;
  if (h.enactedCount > 0) s += `, ${h.enactedCount} enacted (${formatAda(String(h.enactedLovelace))} paid)`;
  for (const o of h.others) s += `, ${o.count} ${o.word}`;
  return `${s}.`;
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

export function payoutNotes(row: { key?: RecipientKey | null; address: string }, returnAddress: string | null): string[] {
  const notes: string[] = [];
  if (row.key?.credType === 'scriptHash') notes.push('Script address');
  // Only a decoded recipient can equal an address, never the "(unknown recipient)" placeholder.
  if (row.key && returnAddress !== null && row.address === returnAddress) notes.push('Same stake address as the proposer.');
  return notes;
}
