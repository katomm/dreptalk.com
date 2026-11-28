import { describe, it, expect } from 'vitest';
import { recipientKeyId, type RecipientKey } from '../governance/onchain.js';
import {
  buildRecipientHistories,
  payoutNotes,
  payoutVerb,
  proposerCountLine,
  proposerShortLabel,
  recipientHistorySentence,
  recipientHistoryToggle,
  type HistorySourceRow,
} from './recipientHistory.js';

const A = { credType: 'scriptHash', hash: 'a'.repeat(56) } as const;
const B = { credType: 'keyHash', hash: 'b'.repeat(56) } as const;
const pay = (...e: [RecipientKey, number][]) =>
  JSON.stringify({
    tag: 'TreasuryWithdrawals',
    contents: [e.map(([k, l]) => [{ credential: { [k.credType]: k.hash } }, l]), null],
  });
const row = (id: string, status: string, payload: string, slug: string | null = id): HistorySourceRow => ({
  id,
  title: `T ${id}`,
  status,
  returnAddress: null,
  submittedEpoch: 1,
  submittedAt: null,
  slug,
  payload,
});

describe('buildRecipientHistories', () => {
  it('groups by recipient, sums only enacted as paid, keeps a multi-recipient share', () => {
    const h = buildRecipientHistories(
      [
        row('e1', 'enacted', pay([A, 3_000_000], [B, 9_000_000])),
        row('e2', 'enacted', pay([A, 1_000_000], [A, 1_000_000])),
        row('x1', 'expired', pay([A, 5_000_000])),
        row('a1', 'active', pay([A, 7_000_000]), null),
      ],
      [A],
    ).get(recipientKeyId(A))!;
    expect(h.items.map((i) => [i.id, i.lovelace, i.href])).toEqual([
      ['e1', 3_000_000n, '/t/e1/'],
      ['e2', 2_000_000n, '/t/e2/'],
      ['x1', 5_000_000n, '/t/x1/'],
      ['a1', 7_000_000n, null],
    ]);
    expect(h.enactedCount).toBe(2);
    expect(h.enactedLovelace).toBe(5_000_000n);
    expect(recipientHistorySentence(h)).toBe('This address is the recipient in 4 other treasury withdrawals: 2 enacted (5 ₳ paid), 1 active, 1 expired.');
  });

  it('builds a separate history per key, also an empty one', () => {
    const m = buildRecipientHistories([row('e1', 'enacted', pay([A, 1]))], [A, B]);
    expect(m.get(recipientKeyId(A))!.items).toHaveLength(1);
    expect(m.get(recipientKeyId(B))!.items).toHaveLength(0);
  });

  it('skips unparsable payloads and has a zero-history sentence', () => {
    const h = buildRecipientHistories([row('bad', 'enacted', '{nope')], [A]).get(recipientKeyId(A))!;
    expect(recipientHistorySentence(h)).toBe('No other treasury withdrawal goes to this address.');
  });

  it('uses the singular and badge words', () => {
    const h = buildRecipientHistories([row('p', 'pending', pay([A, 1]))], [A]).get(recipientKeyId(A))!;
    expect(recipientHistorySentence(h)).toBe('This address is the recipient in 1 other treasury withdrawal: 1 syncing.');
  });

  it('ignores null keys', () => {
    expect(buildRecipientHistories([row('e', 'enacted', pay([A, 1]))], [null]).size).toBe(0);
  });

  it('orders other statuses ratified, active, pending, expired, dropped, closed', () => {
    const h = buildRecipientHistories(
      [
        row('d', 'dropped', pay([A, 1])),
        row('x', 'expired', pay([A, 1])),
        row('a', 'active', pay([A, 1])),
        row('r', 'ratified', pay([A, 1])),
      ],
      [A],
    ).get(recipientKeyId(A))!;
    expect(recipientHistorySentence(h)).toBe('This address is the recipient in 4 other treasury withdrawals: 1 ratified, 1 active, 1 expired, 1 dropped.');
  });

  it('falls back to a generated title when the row has none', () => {
    const r = { ...row('e', 'enacted', pay([A, 1])), title: null };
    const h = buildRecipientHistories([r], [A]).get(recipientKeyId(A))!;
    expect(h.items[0].title.length).toBeGreaterThan(0);
  });
});

describe('recipient copy', () => {
  it('short proposer label never throws on null', () => {
    expect(proposerShortLabel(null)).toBeNull();
    expect(proposerShortLabel('stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp')).toBe('Intersect');
    expect(proposerShortLabel('stake1u8unknownunknownunknownunknownunknownunknown')).toBe('stake1u8unknownunk...');
  });

  it('payout verb and notes', () => {
    expect(payoutVerb('enacted')).toBe('paid to');
    expect(payoutVerb('active')).toBe('requested for');
    expect(payoutNotes({ key: A, address: 'stake1x' }, 'stake1x')).toEqual(['Script address', 'Same stake address as the proposer.']);
    expect(payoutNotes({ key: B, address: 'stake1x' }, null)).toEqual([]);
    expect(payoutNotes({ key: B, address: 'stake1x' }, 'stake1y')).toEqual([]);
    expect(payoutNotes({ key: null, address: '(unknown recipient)' }, '(unknown recipient)')).toEqual([]);
  });

  it('toggle label', () => {
    expect(recipientHistoryToggle(1)).toBe('Show the withdrawal');
    expect(recipientHistoryToggle(60)).toBe('Show the 60 withdrawals');
  });

  it('proposer count copy', () => {
    expect(proposerCountLine(1)).toBe('First governance action from this stake address.');
    expect(proposerCountLine(12)).toBe('12 governance actions from this stake address.');
  });
});

describe('address page history', () => {
  const mk = (id: string, status: string, l: number, submittedAt: number | null) => ({
    id,
    title: `T ${id}`,
    status,
    returnAddress: null,
    submittedEpoch: 1,
    submittedAt,
    enactedEpoch: status === 'enacted' ? 2 : null,
    slug: id,
    payload: pay([A, l]),
  });

  it('builds the list from a summary in its order, without "other" in the sentence', async () => {
    const { groupRecipients } = await import('./recipients.js');
    const { resolveNetwork } = await import('../config/network.js');
    const { addressHistorySentence, historyFromSummary } = await import('./recipientHistory.js');
    const [s] = groupRecipients([mk('x', 'enacted', 5_000_000, 200), mk('y', 'active', 1, 300), mk('z', 'enacted', 2_000_000, 100)], resolveNetwork('mainnet'));
    const h = historyFromSummary(s);
    expect(h.items.map((i) => i.id)).toEqual(['y', 'x', 'z']);
    expect(h.items[1]).toMatchObject({ href: '/t/x/', lovelace: 5_000_000n });
    expect(addressHistorySentence(h)).toBe('This address is the recipient in 3 treasury withdrawals: 2 enacted (7 ₳ paid), 1 active.');
    const [one] = groupRecipients([mk('q', 'expired', 1, 1)], resolveNetwork('mainnet'));
    expect(addressHistorySentence(historyFromSummary(one))).toBe('This address is the recipient in 1 treasury withdrawal: 1 expired.');
  });
});

describe('payoutNotes with a proposer badge', () => {
  it('drops the same-as-proposer note when the badge names the proposer', () => {
    const r = { key: B, address: 'stake1uxx' };
    expect(payoutNotes(r, 'stake1uxx')).toEqual(['Same stake address as the proposer.']);
    expect(payoutNotes(r, 'stake1uxx', true)).toEqual([]);
  });
});
