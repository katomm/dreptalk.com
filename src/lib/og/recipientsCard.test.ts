import { describe, it, expect } from 'vitest';
import { resolveNetwork } from '../config/network.js';
import { buildRecipientsPage } from '../treasury/recipientsPage.js';
import type { TreasuryActionRow } from '../treasury/recipients.js';
import { recipientCardModel, recipientsCardModel } from './recipientsCard.js';
import { recipientCardHtml, recipientsCardHtml } from './templates.js';
import { ogCardVersion } from './version.js';

const cfg = resolveNetwork('mainnet');
const A = 'a'.repeat(56);
const B = 'b'.repeat(56);
const pay = (...e: [string, number][]) =>
  JSON.stringify({ tag: 'TreasuryWithdrawals', contents: [e.map(([h, l]) => [{ credential: { scriptHash: h } }, l]), null] });
const row = (status: string, payload: string): TreasuryActionRow => ({
  id: `o${Math.random()}#0`, title: 'T', status, returnAddress: null, submittedEpoch: 600, submittedAt: null,
  enactedEpoch: status === 'enacted' ? 650 : null, slug: null, payload,
});
const page = (labels: { credType: 'scriptHash'; hash: string; label: string; sourceActionId: string; sourceQuote: string }[]) =>
  buildRecipientsPage({ rows: [row('enacted', pay([A, 708_000_000], [B, 292_000_000]))], balances: [], currentEpoch: null, cfg, nowSec: 0, labels });

describe('recipients cards', () => {
  it('leads with the largest share by label', () => {
    const m = recipientsCardModel(page([{ credType: 'scriptHash', hash: A, label: 'Big contract', sourceActionId: 'x#0', sourceQuote: A }]));
    expect(m.lead).toBe('70.8 % to Big contract');
    expect(m.segments.map((s) => s.pct)).toEqual([70.8, 29.2]);
    expect(recipientsCardHtml(m)).toContain('Where the treasury money went');
  });

  it('has no lead and no bar when nothing is paid', () => {
    const m = recipientsCardModel(buildRecipientsPage({ rows: [], balances: [], currentEpoch: null, cfg, nowSec: 0 }));
    expect(m.lead).toBeNull();
    expect(m.segments).toEqual([]);
    expect(recipientsCardHtml(m)).toContain('paid from the treasury');
  });

  it('changes the version when only a label changes', () => {
    const v = (label: string) =>
      ogCardVersion([JSON.stringify(recipientsCardModel(page([{ credType: 'scriptHash', hash: A, label, sourceActionId: 'x#0', sourceQuote: A }])))]);
    expect(v('One')).not.toBe(v('Two'));
  });

  it('renders an address card with its title', () => {
    const d = page([]);
    const m = recipientCardModel(d.summaries[0], null);
    expect(m.withdrawals).toBe(1);
    expect(recipientCardHtml(m)).toContain('Treasury recipient, 1 withdrawal');
  });
});
