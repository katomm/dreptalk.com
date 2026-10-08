// @vitest-environment happy-dom
// The parameter change panel on its own: the cards with their range and live
// impact, picking and removing parameters, the field errors that block
// Continue, the summary with who decides, the pool data failure and the open
// competing proposal.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import ParamChangePanel from './ParamChangePanel.js';
import fixture from '../../../lib/governance/__fixtures__/poolEconomics660.json';
import { economicsFromJson, type PoolEconomicsJson } from '../../../lib/governance/paramImpact.js';
import { resolveNetwork } from '../../../lib/config/network.js';

afterEach(cleanup);

const GUARDRAIL = 'fa24fb305126805cf2164c161d852a0e7330cf988f1fe558cf7d4a64';
const context = {
  epoch: 660,
  prev: { lastEnacted: null, open: [] },
  guardrail: { state: 'known', scriptHash: GUARDRAIL },
  committee: { members: [], quorum: { numerator: 2, denominator: 3 }, maxTermLength: null },
  params: { k: { n: '500', d: '1' }, a0: { n: '3', d: '10' }, minPoolCost: { n: '170000000', d: '1' }, rho: { n: '3', d: '1000' }, tau: { n: '1', d: '5' } },
} as never;

// A full config: the previous-action field dates the open proposals from the epoch anchor.
const PREPROD = resolveNetwork('preprod');

// Technical and economic thresholds differ on purpose, so the summary shows which groups count.
const PARAMS = { dvtPpTechnical: 0.67, dvtPpEconomic: 0.6, dvtPpGov: 0.75, dvtPpNetwork: 0.67 } as never;

function setup(value: { prev: null; picked: never[]; inputs: Record<string, string> } = { prev: null, picked: ['k'] as never[], inputs: { k: '600' } }, economics: unknown = { status: 'ready', data: economicsFromJson(fixture as PoolEconomicsJson) }) {
  const onChange = vi.fn();
  const onContinue = vi.fn();
  render(
    <ParamChangePanel
      value={value as never}
      onChange={onChange}
      context={context}
      economics={economics as never}
      protocolParams={PARAMS}
      onRetryEconomics={vi.fn()}
      ccQuorum={{ numerator: 2, denominator: 3 }}
      deposit={{ status: 'ready', lovelace: 100_000_000_000n }}
      govActionLifetime={6}
      networkConfig={PREPROD}
      onContinue={onContinue}
    />,
  );
  return { onChange, onContinue };
}

describe('ParamChangePanel', () => {
  it('shows the card with old value, input, range and the saturation impact', () => {
    setup();
    const card = screen.getByRole('group', { name: 'Target number of pools' });
    expect(within(card).getAllByText('500').length).toBeGreaterThan(0);
    expect((within(card).getByRole('textbox', { name: 'New Target number of pools' }) as HTMLInputElement).value).toBe('600');
    expect(within(card).getByText('250')).toBeTruthy();
    expect(within(card).getByText('2,000')).toBeTruthy();
    // The same figures show in a stat tile and in the sentence or the legend.
    expect(within(card).getAllByText(/101/).length).toBeGreaterThan(0);
    expect(within(card).getAllByText(/64\.9M ₳/).length).toBeGreaterThan(0);
  });

  it('picks a parameter from its chip and prefills nothing', () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'a0' }));
    expect(onChange).toHaveBeenCalledWith({ prev: null, picked: ['k', 'a0'], inputs: { k: '600' } });
  });

  it('marks an out-of-range value and disables Continue with the reason', () => {
    setup({ prev: null, picked: ['tau'] as never[], inputs: { tau: '35' } });
    expect(screen.getByText('The constitution allows 10% to 30%. The guardrails script would reject this action, so it cannot be submitted.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Continue to rationale' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'tau' }).getAttribute('data-state')).toBe('invalid');
  });

  it('blocks an unchanged value', () => {
    setup({ prev: null, picked: ['k'] as never[], inputs: { k: '500' } });
    expect(screen.getByText('Target number of pools has the same value as now. Change it or remove it.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Continue to rationale' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('lists the on-chain changes and who decides in the summary', () => {
    const { onContinue } = setup({ prev: null, picked: ['k', 'a0'] as never[], inputs: { k: '600', a0: '0.35' } });
    const summary = screen.getByRole('complementary', { name: 'Summary' });
    expect(within(summary).getByText('600')).toBeTruthy();
    expect(within(summary).getByText('0.35')).toBeTruthy();
    expect(within(summary).getByText('67% yes')).toBeTruthy();
    expect(within(summary).getByText('do not vote on these')).toBeTruthy();
    fireEvent.click(within(summary).getByRole('button', { name: 'Continue to rationale' }));
    expect(onContinue).toHaveBeenCalled();
  });

  it('takes the DRep threshold from the picked groups only', () => {
    setup({ prev: null, picked: ['minPoolCost'] as never[], inputs: { minPoolCost: '200' } });
    expect(within(screen.getByRole('complementary', { name: 'Summary' })).getByText('60% yes')).toBeTruthy();
  });

  it('renders without impact figures when the pool data failed, with a retry', () => {
    setup(undefined, { status: 'error' });
    expect(screen.getAllByText('Impact figures are unavailable right now.').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Try again' }).length).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: 'Continue to rationale' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('removes a parameter and keeps its typed value', () => {
    const { onChange } = setup({ prev: null, picked: ['k', 'a0'] as never[], inputs: { k: '600', a0: '0.35' } });
    fireEvent.click(within(screen.getByRole('group', { name: 'Pledge influence' })).getByRole('button', { name: 'Remove' }));
    expect(onChange).toHaveBeenCalledWith({ prev: null, picked: ['k'], inputs: { k: '600', a0: '0.35' } });
  });

  it('shows the open competing proposal', () => {
    const open = { txHash: 'ef'.repeat(32), index: 0, id: 'gov_action1x', type: 'ParameterChange', title: 'Reduce minPoolCost to 75 ada', proposedEpoch: 654 };
    render(
      <ParamChangePanel
        value={{ prev: null, picked: [], inputs: {} }}
        onChange={vi.fn()}
        context={{ ...(context as object), prev: { lastEnacted: null, open: [open] } } as never}
        economics={{ status: 'loading' }}
        protocolParams={PARAMS}
        onRetryEconomics={vi.fn()}
        ccQuorum={{ numerator: 2, denominator: 3 }}
        deposit={{ status: 'ready', lovelace: 100_000_000_000n }}
        govActionLifetime={6}
        networkConfig={PREPROD}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.getByText(/Another parameter change is open: Reduce minPoolCost to 75 ada\./)).toBeTruthy();
    expect(screen.getByText(/Both build on the same previous change, so only one of them can take effect\./)).toBeTruthy();
  });
});
