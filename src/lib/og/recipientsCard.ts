// Open Graph card models for the treasury recipients pages: the overview card
// (total paid, the concentration bar, the largest share) and one card per
// address (paid, not paid, withdrawals, per year). Shared by the /og routes
// (render them) and the pages (version their og:image URL by the whole model),
// so a label correction alone gives a new URL. The runway is never on a card.
import { formatAda, formatAdaCompact } from '../format/ada.js';
import type { AddressLabel } from '../treasury/labels.js';
import { yearRows, type RecipientSummary } from '../treasury/recipients.js';
import { addressName, pctText, type RecipientsPageData } from '../treasury/recipientsPage.js';
import { accentForType } from './theme.js';

// Light-theme values of the segment colors (satori cannot read CSS variables).
const COLORS = ['#6d28d9', '#2563c9', '#0f766e', '#b45309', '#7c3aed', '#c2410c'];
const OTHER = '#b8bcc4';

export interface RecipientsCardModel {
  accent: string;
  totalPaid: string;
  segments: { label: string; pct: number; color: string }[];
  /** "70.8 % to the Intersect 2025 treasury reserve contract", null when nothing is paid. */
  lead: string | null;
}

export function recipientsCardModel(d: RecipientsPageData): RecipientsCardModel {
  const segments = d.segments.map((s, i) => ({
    label: s.summary ? addressName(s.summary, d.labels.get(s.id) ?? null) : `${s.folded} other addresses`,
    pct: s.pct,
    color: s.id === 'other' ? OTHER : COLORS[i % COLORS.length],
  }));
  return {
    accent: accentForType('TreasuryWithdrawals'),
    totalPaid: formatAda(String(d.totalPaid)) ?? '0 ₳',
    segments,
    lead: segments.length > 0 ? `${pctText(segments[0].pct)} to ${segments[0].label}` : null,
  };
}

export interface RecipientCardModel {
  accent: string;
  title: string;
  paid: string;
  notPaid: string | null;
  withdrawals: number;
  years: { year: number; paid: number; notPaid: number }[];
}

export function recipientCardModel(s: RecipientSummary, label: AddressLabel | null): RecipientCardModel {
  return {
    accent: accentForType('TreasuryWithdrawals'),
    title: addressName(s, label),
    paid: formatAda(String(s.paid)) ?? '0 ₳',
    notPaid: s.notPaid > 0n ? (formatAdaCompact(String(s.notPaid)) ?? null) : null,
    withdrawals: s.withdrawals,
    years: yearRows(s).map((y) => ({ year: y.year, paid: Number(y.paid) / 1e6, notPaid: Number(y.notPaid) / 1e6 })),
  };
}
