// @vitest-environment happy-dom
// The treasury on-chain card in the review: one "<amount> paid to <address>"
// row per recipient and a total only when there is more than one, the
// semantics GaOnchainChanges.astro has on the action page, with amounts
// exact to the lovelace. The card is fed from the real preview model, so the
// test covers what the user actually sees before signing.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import PreviewCard from './PreviewCard.js';
import { previewModelFromForm } from '@/lib/governance/previewModel.js';
import { initialGovActionFormState } from '@/lib/governance/govActionFormState.js';
import { GUARDRAIL_SCRIPT_HASH_HEX } from '@/lib/governance/guardrailScript.js';
import { encodeBech32 } from '@/lib/crypto/bech32.js';
import { hexToBytes } from '@/lib/crypto/hex.js';
import type { OnchainChanges } from '@/lib/governance/onchain.js';

afterEach(cleanup);

const A = encodeBech32('stake_test', hexToBytes(`e0${'ab'.repeat(28)}`));
const B = encodeBech32('stake_test', hexToBytes(`f0${'cd'.repeat(28)}`));
const C = encodeBech32('stake_test', hexToBytes(`e0${'ef'.repeat(28)}`));

function previewOf(rows: { address: string; amountAda: string }[]): OnchainChanges | null {
  const base = initialGovActionFormState('Jane DRep');
  return previewModelFromForm(
    { type: 'TreasuryWithdrawals', metadata: base.metadata, panels: { ...base.panels, TreasuryWithdrawals: { rows } } },
    { epoch: 500, guardrail: { state: 'known', scriptHash: GUARDRAIL_SCRIPT_HASH_HEX } },
    null,
    'preprod',
  ).onchain;
}

function card(onchain: OnchainChanges | null) {
  render(
    <PreviewCard
      typeLabel="Treasury withdrawal"
      title="Pay the builders"
      html={{}}
      authorLine="No author named"
      missing={[]}
      references={[]}
      onchain={onchain}
    />,
  );
}

describe('PreviewCard treasury', () => {
  it('lists every recipient with its exact amount and the exact total', () => {
    card(
      previewOf([
        { address: A, amountAda: '0.000001' },
        { address: B, amountAda: '2.5' },
        { address: C, amountAda: '9007199254.740993' },
      ]),
    );
    expect(screen.getByText('On-chain changes')).toBeTruthy();
    expect(screen.getAllByText('paid to')).toHaveLength(3);
    expect(screen.getByText('0.000001 tADA')).toBeTruthy();
    expect(screen.getByText('2.5 tADA')).toBeTruthy();
    expect(screen.getByText('9,007,199,254.740993 tADA')).toBeTruthy();
    expect(screen.getByText('9,007,199,257.240994 tADA')).toBeTruthy();
    expect(screen.getByTitle(A)).toBeTruthy();
  });

  it('shows no total for a single recipient, the row already says it', () => {
    card(previewOf([{ address: A, amountAda: '2.5' }]));
    expect(screen.getByText('2.5 tADA')).toBeTruthy();
    expect(screen.queryByText(/^Total/)).toBeNull();
  });

  it('shows no card for an empty list', () => {
    card(previewOf([{ address: '', amountAda: '' }]));
    expect(screen.queryByText('On-chain changes')).toBeNull();
  });
});
