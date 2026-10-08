// @vitest-environment happy-dom
// The on-chain card in the review. Treasury: one "<amount> paid to <address>"
// row per recipient and a total only when there is more than one, the
// semantics GaOnchainChanges.astro has on the action page, with amounts
// exact to the lovelace. Parameter change: one row per changed parameter with
// its group, the value in force struck through and the new value, as on the
// action page. The card is fed from the real preview model, so the test
// covers what the user actually sees before signing.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
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

// The staking parameters in force, as the context route reports them.
const PARAM_CONTEXT = {
  epoch: 500,
  prev: { lastEnacted: null, open: [] },
  guardrail: { state: 'known', scriptHash: GUARDRAIL_SCRIPT_HASH_HEX },
  params: { k: { n: '500', d: '1' }, a0: { n: '3', d: '10' }, minPoolCost: { n: '170000000', d: '1' }, rho: { n: '3', d: '1000' }, tau: { n: '1', d: '5' } },
};

function paramPreviewOf(inputs: Record<string, string>, epochParams: Record<string, unknown> | null): OnchainChanges | null {
  const base = initialGovActionFormState('Jane DRep');
  return previewModelFromForm(
    {
      type: 'ParameterChange',
      metadata: base.metadata,
      panels: { ...base.panels, ParameterChange: { prev: null, picked: Object.keys(inputs) as never[], inputs } },
    },
    PARAM_CONTEXT as never,
    epochParams as never,
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

describe('PreviewCard parameter change', () => {
  const rowOf = (label: string) => screen.getByText(label).closest('li') as HTMLElement;

  it('lists every changed parameter with its group, the old value struck through and the new one', () => {
    card(paramPreviewOf({ k: '600', minPoolCost: '170.000001' }, { optimal_pool_count: 500, min_pool_cost: '170000000' }));
    expect(screen.getByText('On-chain changes')).toBeTruthy();
    const k = rowOf('Target Number of Pools (k)');
    expect(within(k).getByText('Technical')).toBeTruthy();
    expect(within(k).getByText('500').style.textDecoration).toBe('line-through');
    expect(within(k).getByText('600')).toBeTruthy();
    const cost = rowOf('Min Pool Cost');
    expect(within(cost).getByText('Economic')).toBeTruthy();
    expect(within(cost).getByText('170 ₳').style.textDecoration).toBe('line-through');
    expect(within(cost).getByText('170.000001 ₳')).toBeTruthy();
  });

  it('shows only the new value when the value in force is unknown', () => {
    card(paramPreviewOf({ k: '600' }, null));
    const k = rowOf('Target Number of Pools (k)');
    expect(within(k).getByText('600')).toBeTruthy();
    expect(within(k).queryByText('500')).toBeNull();
    expect(k.querySelector('.ocx__old')).toBeNull();
  });

  it('shows no card for an empty parameter list', () => {
    card({ kind: 'params', rows: [] });
    expect(screen.queryByText('On-chain changes')).toBeNull();
  });
});
