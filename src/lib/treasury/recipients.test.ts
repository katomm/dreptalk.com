import { describe, it, expect } from 'vitest';
import { EPOCH_LENGTH_SECONDS, epochStartUnix, resolveNetwork } from '../config/network.js';
import type { RecipientKey } from '../governance/onchain.js';
import {
  concentrationSegments,
  groupRecipients,
  paidByQuarter,
  paidInEpochs,
  paidInYear,
  sumPaid,
  yearRows,
  type TreasuryActionRow,
} from './recipients.js';

const cfg = resolveNetwork('mainnet');
const A = { credType: 'scriptHash', hash: 'a'.repeat(56) } as const;
const B = { credType: 'keyHash', hash: 'b'.repeat(56) } as const;
const C = { credType: 'scriptHash', hash: 'c'.repeat(56) } as const;
const D = { credType: 'scriptHash', hash: 'd'.repeat(56) } as const;
const E = { credType: 'scriptHash', hash: 'e'.repeat(56) } as const;
const ADA = 1_000_000;

const pay = (...e: [RecipientKey | null, number][]) =>
  JSON.stringify({
    tag: 'TreasuryWithdrawals',
    contents: [e.map(([k, l]) => [{ credential: k ? { [k.credType]: k.hash } : {} }, l]), null],
  });

let n = 0;
const row = (status: string, payload: string, over: Partial<TreasuryActionRow> = {}): TreasuryActionRow => ({
  id: `a${n++}#0`,
  title: 'T',
  status,
  returnAddress: null,
  submittedEpoch: 600,
  submittedAt: null,
  enactedEpoch: status === 'enacted' ? 601 : null,
  slug: null,
  payload,
  ...over,
});

// First mainnet epoch that starts in late December and ends in January.
function yearBoundaryEpoch(): number {
  for (let e = 500; e < 900; e++) {
    const start = new Date(epochStartUnix(e, cfg) * 1000);
    const end = new Date((epochStartUnix(e, cfg) + EPOCH_LENGTH_SECONDS - 1) * 1000);
    if (start.getUTCMonth() === 11 && end.getUTCMonth() === 0) return e;
  }
  throw new Error('no boundary epoch');
}

describe('groupRecipients', () => {
  it('groups a repeated recipient within one action as one withdrawal', () => {
    const [s] = groupRecipients([row('enacted', pay([A, 1 * ADA], [A, 2 * ADA]))], cfg);
    expect(s.withdrawals).toBe(1);
    expect(s.paid).toBe(3_000_000n);
    expect(s.address?.startsWith('stake17')).toBe(true);
  });

  it('splits a multi-recipient action by address', () => {
    const list = groupRecipients([row('enacted', pay([A, 2 * ADA], [B, 1 * ADA]))], cfg);
    expect(list.map((s) => s.key?.hash[0])).toEqual(['a', 'b']);
    expect(list.every((s) => s.shares.length === 1)).toBe(true);
  });

  it('keeps entries without a valid hash in the unknown bucket', () => {
    const list = groupRecipients([row('enacted', pay([null, 5 * ADA]))], cfg);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('unknown');
    expect(list[0].key).toBeNull();
    expect(list[0].address).toBeNull();
    expect(sumPaid(list)).toBe(5_000_000n);
  });

  it('skips an unparsable payload', () => {
    expect(groupRecipients([row('enacted', 'not json')], cfg)).toEqual([]);
  });

  it('counts only enacted as paid', () => {
    const [s] = groupRecipients([row('enacted', pay([A, 1 * ADA])), row('expired', pay([A, 2 * ADA]))], cfg);
    expect(s.paid).toBe(1_000_000n);
    expect(s.notPaid).toBe(2_000_000n);
    expect(s.notPaidByStatus).toEqual([{ status: 'expired', lovelace: 2_000_000n }]);
    expect(s.withdrawals).toBe(2);
  });

  it('counts proposers by return address', () => {
    const [s] = groupRecipients(
      [
        row('enacted', pay([A, 1]), { returnAddress: 'x' }),
        row('enacted', pay([A, 1]), { returnAddress: 'y' }),
        row('expired', pay([A, 1]), { returnAddress: 'y' }),
      ],
      cfg,
    );
    expect(s.proposers).toEqual([
      { returnAddress: 'y', count: 2 },
      { returnAddress: 'x', count: 1 },
    ]);
  });

  it('dates a payout by the enactment epoch start', () => {
    const e = yearBoundaryEpoch();
    const startYear = new Date(epochStartUnix(e, cfg) * 1000).getUTCFullYear();
    const list = groupRecipients([row('enacted', pay([A, 4 * ADA]), { enactedEpoch: e })], cfg);
    expect(yearRows(list[0])).toEqual([{ year: startYear, paid: 4_000_000n, notPaid: 0n }]);
    const q = paidByQuarter(list, [list[0].id], epochStartUnix(e, cfg) + 86400 * 40);
    expect(q[0].quarter).toBe(`${startYear} Q4`);
    expect(q[0].bySegment.get(list[0].id)).toBe(4_000_000n);
    expect(paidInYear(list, startYear)).toBe(4_000_000n);
    expect(paidInYear(list, startYear + 1)).toBe(0n);
  });

  it('dates a not-paid share by submission, in seconds', () => {
    const ms = Date.UTC(2026, 9, 28);
    const viaMs = groupRecipients([row('expired', pay([A, 1]), { submittedAt: ms })], cfg);
    expect(viaMs[0].shares[0].requestedAt).toBe(ms / 1000);
    expect(yearRows(viaMs[0])).toEqual([{ year: 2026, paid: 0n, notPaid: 1n }]);
    const viaEpoch = groupRecipients([row('expired', pay([A, 1]), { submittedAt: null, submittedEpoch: 620 })], cfg);
    expect(viaEpoch[0].shares[0].requestedAt).toBe(epochStartUnix(620, cfg));
  });

  it('leaves an enacted action without enacted_epoch out of time buckets', () => {
    const list = groupRecipients([row('enacted', pay([A, 1 * ADA]), { enactedEpoch: null })], cfg);
    expect(list[0].paid).toBe(1_000_000n);
    expect(yearRows(list[0])).toEqual([]);
    expect(paidByQuarter(list, [list[0].id], Date.now() / 1000)).toEqual([]);
    expect(list[0].firstPaidAt).toBeNull();
  });

  it('sums paid within an epoch window', () => {
    const list = groupRecipients(
      [row('enacted', pay([A, 1 * ADA]), { enactedEpoch: 600 }), row('enacted', pay([B, 2 * ADA]), { enactedEpoch: 610 })],
      cfg,
    );
    expect(paidInEpochs(list, 600, 605)).toBe(1_000_000n);
    expect(paidInEpochs(list, 600, 610)).toBe(3_000_000n);
  });

  it('orders quarters from the first payout to now with empty quarters kept', () => {
    const e = 600;
    const list = groupRecipients([row('enacted', pay([A, 1]), { enactedEpoch: e })], cfg);
    const start = new Date(epochStartUnix(e, cfg) * 1000);
    const q = paidByQuarter(list, [list[0].id], epochStartUnix(e, cfg) + 86400 * 200);
    expect(q[0].quarter).toBe(`${start.getUTCFullYear()} Q${Math.floor(start.getUTCMonth() / 3) + 1}`);
    expect(q.length).toBeGreaterThanOrEqual(3);
    expect(q.slice(1).every((x) => x.bySegment.size === 0)).toBe(true);
  });
});

describe('concentrationSegments', () => {
  it('folds small addresses into one segment', () => {
    const list = groupRecipients(
      [row('enacted', pay([A, 70], [B, 20], [C, 6], [D, 2], [E, 2]))],
      cfg,
    );
    const seg = concentrationSegments(list);
    expect(seg.map((s) => s.id)).toEqual([list[0].id, list[1].id, list[2].id, 'other']);
    expect(seg[3].folded).toBe(2);
    expect(seg[3].summary).toBeNull();
    expect(Math.abs(seg.reduce((a, s) => a + s.pct, 0) - 100)).toBeLessThan(0.01);
  });

  it('returns no segments when nothing is paid', () => {
    expect(concentrationSegments(groupRecipients([row('expired', pay([A, 5]))], cfg))).toEqual([]);
    expect(concentrationSegments([])).toEqual([]);
  });
});
