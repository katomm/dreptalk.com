import { describe, it, expect } from 'vitest';
import { resolveNetwork } from '../config/network.js';
import type { TreasuryActionRow } from './recipients.js';
import { buildRecipientsPage, proposersLine, recipientsCsv } from './recipientsPage.js';
import { runwayResultText } from './runwayText.js';
import type { EpochBalance } from './runway.js';

const cfg = resolveNetwork('mainnet');
const pay = (...e: [string, number][]) =>
  JSON.stringify({ tag: 'TreasuryWithdrawals', contents: [e.map(([h, l]) => [{ credential: { scriptHash: h } }, l]), null] });
let n = 0;
const row = (status: string, payload: string, over: Partial<TreasuryActionRow> = {}): TreasuryActionRow => ({
  id: `p${n++}#0`,
  title: 'T',
  status,
  returnAddress: null,
  submittedEpoch: 600,
  submittedAt: null,
  enactedEpoch: status === 'enacted' ? 650 : null,
  slug: null,
  payload,
  ...over,
});

function balances(from: number, to: number): EpochBalance[] {
  const out: EpochBalance[] = [];
  let R = 6_000_000_000_000_000n;
  let T = 1_500_000_000_000_000n;
  for (let e = from; e <= to; e++) {
    out.push({ epoch: e, treasury: T, reserves: R });
    T += (R * 5n) / 10_000n;
    R -= R / 1000n;
  }
  return out;
}

const A = 'a'.repeat(56);
const B = 'b'.repeat(56);
const now = Date.UTC(2026, 10, 28) / 1000;

describe('buildRecipientsPage', () => {
  it('keeps every total on the same grouped rows', () => {
    const d = buildRecipientsPage({
      rows: [row('enacted', pay([A, 7_000_000], [B, 3_000_000])), row('expired', pay([A, 5]))],
      balances: balances(500, 670),
      currentEpoch: 671,
      cfg,
      nowSec: now,
      labels: [],
    });
    expect(d.totalPaid).toBe(10_000_000n);
    expect(d.addressCount).toBe(2);
    expect(d.paidLast12).toBe(10_000_000n);
    expect(d.segments.map((s) => s.lovelace)).toEqual([7_000_000n, 3_000_000n]);
    expect(d.runway?.presets[0].lovelacePerYear).toBe(d.paidLast12);
    expect(d.runway?.inputs.lastClosedEpoch).toBe(670);
  });

  it('ends the treasury tile and history at the last closed epoch', () => {
    const bal = [...balances(500, 670), { epoch: 671, treasury: 1n, reserves: 1n }];
    const d = buildRecipientsPage({ rows: [], balances: bal, currentEpoch: 671, cfg, nowSec: now, labels: [] });
    expect(d.treasuryEpoch).toBe(670);
    expect(d.runway?.history.at(-1)?.epoch).toBe(670);
    expect(d.treasury).toBe(d.runway?.inputs.treasury);
  });

  it('renders a zero state without bar, chart or runway', () => {
    const d = buildRecipientsPage({ rows: [], balances: [], currentEpoch: null, cfg, nowSec: now });
    expect(d.totalPaid).toBe(0n);
    expect(d.segments).toEqual([]);
    expect(d.quarters).toEqual([]);
    expect(d.runway).toBeNull();
    expect(d.treasury).toBeNull();
  });

  it('leaves the runway out with short history', () => {
    const d = buildRecipientsPage({ rows: [], balances: balances(600, 670), currentEpoch: 671, cfg, nowSec: now });
    expect(d.runway).toBeNull();
  });

  it('counts payouts without an enactment epoch', () => {
    const d = buildRecipientsPage({ rows: [row('enacted', pay([A, 1]), { enactedEpoch: null })], balances: [], currentEpoch: null, cfg, nowSec: now });
    expect(d.undatedPayouts).toBe(1);
    expect(d.totalPaid).toBe(1n);
  });
});

describe('page copy', () => {
  it('writes the runway result with the spending rate', () => {
    expect(runwayResultText(532_000_000_000_000n, { endEpoch: 1, endYear: 2031, horizonYear: 2056, points: [] })).toBe(
      'At 532M ₳ a year the treasury is empty around 2031.',
    );
    expect(runwayResultText(50_000_000_000_000n, { endEpoch: null, endYear: null, horizonYear: 2056, points: [] })).toBe(
      'At 50M ₳ a year the treasury lasts beyond 2056.',
    );
  });

  it('lists proposers by count with a rest count', () => {
    const d = buildRecipientsPage({
      rows: [
        row('enacted', pay([A, 1]), { returnAddress: 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp' }),
        row('enacted', pay([A, 1]), { returnAddress: 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp' }),
        row('enacted', pay([A, 1]), { returnAddress: 'stake1u9other1' }),
      ],
      balances: [],
      currentEpoch: null,
      cfg,
      nowSec: now,
    });
    expect(proposersLine(d.summaries[0], 1)).toBe('Submitted by Intersect (2) and 1 more');
  });

  it('merges registry addresses of one proposer', () => {
    const d = buildRecipientsPage({
      rows: [
        row('enacted', pay([A, 1]), { returnAddress: 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp' }),
        row('enacted', pay([A, 1]), { returnAddress: 'stake1uyguuqwdpexmhgjd07vax5t2ay3f7qvea49ex907g6fmvjclq6l03' }),
      ],
      balances: [],
      currentEpoch: null,
      cfg,
      nowSec: now,
    });
    expect(proposersLine(d.summaries[0])).toBe('Submitted by Intersect (2)');
  });

  it('writes one CSV row per address with lovelace amounts', () => {
    const d = buildRecipientsPage({ rows: [row('enacted', pay([A, 7_000_000]))], balances: [], currentEpoch: null, cfg, nowSec: now, labels: [] });
    const lines = recipientsCsv(d).trim().split('\n');
    expect(lines[0]).toBe('stake_address,credential_type,label,paid_lovelace,requested_not_paid_lovelace,withdrawals,first_payout,last_payout');
    expect(lines[1]).toMatch(/^stake17\w+,scriptHash,,7000000,0,1,\d{4}-\d{2}-\d{2},\d{4}-\d{2}-\d{2}$/);
  });
});

describe('findRecipient', () => {
  it('finds an address by its stake address and rejects others', async () => {
    const { findRecipient } = await import('./recipientsPage.js');
    const rows = [row('enacted', pay([A, 5]))];
    const d = buildRecipientsPage({ rows, balances: [], currentEpoch: null, cfg, nowSec: now, labels: [] });
    const addr = d.summaries[0].address as string;
    expect(findRecipient(rows, cfg, addr, [])?.summary.paid).toBe(5n);
    expect(findRecipient(rows, cfg, 'stake1nonsense', [])).toBeNull();
    expect(findRecipient(rows, resolveNetwork('preprod'), addr, [])).toBeNull();
    const other = buildRecipientsPage({ rows: [row('enacted', pay([B, 1]))], balances: [], currentEpoch: null, cfg, nowSec: now }).summaries[0].address as string;
    expect(findRecipient(rows, cfg, other, [])).toBeNull();
  });
});

describe('recipientsTeaser', () => {
  it('sums the paid ada and names the largest address', async () => {
    const { recipientsTeaser } = await import('./recipientsPage.js');
    const rows = [row('enacted', pay([A, 708_000_000], [B, 292_000_000])), row('expired', pay([B, 5]))];
    const t = recipientsTeaser(rows, cfg, [{ credType: 'scriptHash', hash: A, label: 'Big contract', sourceActionId: 'x#0', sourceQuote: A }]);
    expect(t).toEqual({ totalPaid: 1_000_000_000n, addressCount: 2, topName: 'Big contract', topLabeled: true, topPct: 70.8 });
    expect(recipientsTeaser(rows, cfg, [])?.topLabeled).toBe(false);
  });

  it('returns null when nothing is paid', async () => {
    const { recipientsTeaser } = await import('./recipientsPage.js');
    expect(recipientsTeaser([row('expired', pay([A, 5]))], cfg, [])).toBeNull();
  });
});

describe('incomplete data', () => {
  it('flags enacted payouts the runway inflow cannot account for', () => {
    const d = buildRecipientsPage({
      rows: [row('enacted', pay([A, 1]), { enactedEpoch: null })],
      balances: balances(500, 670),
      currentEpoch: 671,
      cfg,
      nowSec: now,
      enactedWithoutPayload: 2,
    });
    expect(d.runway?.incompletePayouts).toBe(3);
    const clean = buildRecipientsPage({ rows: [], balances: balances(500, 670), currentEpoch: 671, cfg, nowSec: now });
    expect(clean.runway?.incompletePayouts).toBe(0);
  });

  it('ends the treasury tile before the newest stored epoch without protocol params', () => {
    const bal = [...balances(500, 670), { epoch: 671, treasury: 1n, reserves: 1n }];
    const d = buildRecipientsPage({ rows: [], balances: bal, currentEpoch: null, cfg, nowSec: now });
    expect(d.treasuryEpoch).toBe(670);
    expect(d.runway).toBeNull();
  });
});
