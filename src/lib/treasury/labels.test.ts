import { describe, it, expect } from 'vitest';
import { RECIPIENT_LABELS, type RecipientLabel } from '../../../config/treasury-recipients.js';
import { resolveNetwork } from '../config/network.js';
import { recipientKeyToBech32 } from '../governance/onchain.js';
import { parseStakeAddress } from '../governance/treasuryWithdrawals.js';
import { labelFor, labelForPayout } from './labels.js';
import { groupRecipients, type TreasuryActionRow } from './recipients.js';

const CF = 'stake1uyyqmz5ae7ct4f26p4t87y2xrrgu7f3e0cpap66zgcnxu0gl7gy6y';
const cfParsed = parseStakeAddress(CF, 'mainnet');
if (!cfParsed.ok) throw new Error('fixture');
const CF_KEY = { credType: 'keyHash', hash: cfParsed.value.credential.hashHex } as const;
const A = { credType: 'scriptHash', hash: 'a'.repeat(56) } as const;
const FIXTURE: RecipientLabel[] = [{ ...A, label: 'Test contract', sourceActionId: 'x#0', sourceQuote: 'a'.repeat(56) }];

const pay = (k: { credType: string; hash: string }) =>
  JSON.stringify({ tag: 'TreasuryWithdrawals', contents: [[[{ credential: { [k.credType]: k.hash } }, 1]], null] });
let n = 0;
const row = (payload: string, returnAddress: string | null): TreasuryActionRow => ({
  id: `l${n++}#0`,
  title: 'T',
  status: 'enacted',
  returnAddress,
  submittedEpoch: 600,
  submittedAt: null,
  enactedEpoch: 601,
  slug: null,
  payload,
});
const mainnet = resolveNetwork('mainnet');

describe('RECIPIENT_LABELS', () => {
  it('every config entry has a valid unique key', () => {
    const seen = new Set<string>();
    for (const l of RECIPIENT_LABELS) {
      expect(l.hash).toMatch(/^[0-9a-f]{56}$/);
      const k = `${l.credType}:${l.hash}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });

  it('every config quote names its address', () => {
    for (const l of RECIPIENT_LABELS) {
      const addr = recipientKeyToBech32({ credType: l.credType, hash: l.hash }, 'mainnet');
      expect(l.sourceQuote.includes(addr) || l.sourceQuote.includes(l.hash), l.label).toBe(true);
    }
  });

  it('every label avoids dashes and semicolons', () => {
    for (const l of RECIPIENT_LABELS) expect(l.label).not.toMatch(/[—–―;]/);
  });
});

describe('labelFor', () => {
  it('returns no label off mainnet', () => {
    const [s] = groupRecipients([row(pay(A), null)], resolveNetwork('preprod'));
    expect(labelFor(s, 'preprod', FIXTURE)).toBeNull();
  });

  it('uses the config label first', () => {
    const [s] = groupRecipients([row(pay(A), null)], mainnet);
    expect(labelFor(s, 'mainnet', FIXTURE)).toEqual({ kind: 'proposal', label: 'Test contract', sourceActionId: 'x#0' });
    const [cf] = groupRecipients([row(pay(CF_KEY), CF)], mainnet);
    const withCf: RecipientLabel[] = [{ ...CF_KEY, label: 'CF wallet', sourceActionId: 'y#0', sourceQuote: CF }];
    expect(labelFor(cf, 'mainnet', withCf)?.kind).toBe('proposal');
  });

  it('gives a proposer label only when every withdrawal comes from that address', () => {
    const [s] = groupRecipients([row(pay(CF_KEY), CF), row(pay(CF_KEY), CF)], mainnet);
    expect(labelFor(s, 'mainnet', FIXTURE)).toEqual({ kind: 'proposer', name: 'Cardano Foundation' });
    const [mixed] = groupRecipients([row(pay(CF_KEY), CF), row(pay(CF_KEY), 'stake1uother')], mainnet);
    expect(labelFor(mixed, 'mainnet', FIXTURE)).toBeNull();
  });

  it('uses the real config for the Intersect 2025 contract', () => {
    const h = RECIPIENT_LABELS[0];
    const [s] = groupRecipients([row(pay(h), null)], mainnet);
    expect(labelFor(s, 'mainnet')?.kind).toBe('proposal');
  });
});

describe('labelForPayout', () => {
  it('shows the proposer label only when every withdrawal and this action match', () => {
    expect(labelForPayout(CF_KEY, CF, CF, [CF, CF], 'mainnet', FIXTURE)).toEqual({ kind: 'proposer', name: 'Cardano Foundation' });
    expect(labelForPayout(CF_KEY, CF, CF, [CF, 'stake1uother'], 'mainnet', FIXTURE)).toBeNull();
    expect(labelForPayout(CF_KEY, CF, 'stake1uother', ['stake1uother'], 'mainnet', FIXTURE)).toBeNull();
  });

  it('shows the config label on mainnet only', () => {
    expect(labelForPayout(A, 'x', null, [null], 'mainnet', FIXTURE)?.kind).toBe('proposal');
    expect(labelForPayout(A, 'x', null, [null], 'preprod', FIXTURE)).toBeNull();
    expect(labelForPayout(null, '(unknown recipient)', null, [], 'mainnet', FIXTURE)).toBeNull();
  });
});
