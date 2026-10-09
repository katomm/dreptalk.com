// @vitest-environment happy-dom
// The parameter change panel on its own: the cards with their range and live
// impact, picking and removing parameters, the field errors that block
// Continue, the summary with who decides, the pool data failure and the open
// competing proposal.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup, act } from '@testing-library/react';
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

/** The rewards chart caption inside a card or section. */
const caption = (root: HTMLElement) => root.querySelector('.pcp-caption')?.textContent;

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

  it('shows stake over saturation with its before value and the delegator sentence for a higher k', () => {
    setup();
    const card = screen.getByRole('group', { name: 'Target number of pools' });
    const tile = within(card).getByText('Stake over saturation').closest('.pcp-stat') as HTMLElement;
    expect(tile.textContent).toBe('Stake over saturation875M ₳ from 103.7M ₳');
    expect(
      within(card).getByText(
        "These pools' maximum rewards are capped lower, so their delegators would earn less unless they move to a smaller pool. A higher k also changes the pledge bonus of pools below it.",
      ),
    ).toBeTruthy();
    expect(within(card).getByRole('img', { name: /2 largest pools are clipped/ })).toBeTruthy();
  });

  it('keeps the rewards chart on the k card when k is the only reward parameter', () => {
    setup();
    const card = screen.getByRole('group', { name: 'Target number of pools' });
    expect(screen.queryByText('Combined impact of this proposal')).toBeNull();
    expect(caption(card)).toBe('Calculated with k 500 → 600');
    expect(within(card).getByText('Maximum rewards at full block production, before fees.')).toBeTruthy();
    expect(within(card).getByText('Preprod pool data, epoch 660')).toBeTruthy();
  });

  it('keeps the rewards chart on the a0 card when a0 is the only reward parameter', () => {
    setup({ prev: null, picked: ['a0', 'minPoolCost'] as never[], inputs: { a0: '0.35', minPoolCost: '200' } });
    expect(screen.queryByText('Combined impact of this proposal')).toBeNull();
    expect(caption(screen.getByRole('group', { name: 'Pledge influence' }))).toBe('Calculated with a0 0.3 → 0.35');
    // Every impact section names its data source.
    expect(screen.getAllByText('Preprod pool data, epoch 660')).toHaveLength(2);
  });

  it('moves the rewards chart into a combined section with two reward parameters', () => {
    setup({ prev: null, picked: ['k', 'a0'] as never[], inputs: { k: '600', a0: '0.35' } });
    const section = screen.getByRole('region', { name: 'Combined impact of this proposal' });
    expect(caption(section)).toBe('Calculated with k 500 → 600 and a0 0.3 → 0.35');
    expect(within(section).getByText('Maximum rewards at full block production, before fees.')).toBeTruthy();
    expect(within(section).getByText('Preprod pool data, epoch 660')).toBeTruthy();
    // The reference pools sit relative to the new saturation point of 64.9M ada.
    expect([...section.querySelectorAll('.pcp-stat')].map((tile) => tile.textContent)).toEqual([
      '32.4M ₳ pool, 1M ₳ pledge-3.6%',
      '32.4M ₳ pool, 9.7M ₳ pledge-2.4%',
      '58.4M ₳ pool, 17.5M ₳ pledge-1.1%',
    ]);
    const a0 = screen.getByRole('group', { name: 'Pledge influence' });
    expect(within(a0).getByText('Its effect on pool rewards is shown under Combined impact below.')).toBeTruthy();
    expect(within(a0).queryByText('Maximum rewards at full block production, before fees.')).toBeNull();
    const k = screen.getByRole('group', { name: 'Target number of pools' });
    expect(within(k).queryByText('Maximum rewards at full block production, before fees.')).toBeNull();
    expect(within(k).getByText('Stake over saturation')).toBeTruthy();
  });

  it('keeps the rewards chart on the k card while a second reward chip has no value yet', () => {
    setup({ prev: null, picked: ['k', 'a0'] as never[], inputs: { k: '600' } });
    expect(screen.queryByText('Combined impact of this proposal')).toBeNull();
    const card = screen.getByRole('group', { name: 'Target number of pools' });
    expect(caption(card)).toBe('Calculated with k 500 → 600');
    const a0 = screen.getByRole('group', { name: 'Pledge influence' });
    expect(within(a0).queryByText('Its effect on pool rewards is shown under Combined impact below.')).toBeNull();
  });

  it('names the epoch totals as the source of the reserve budget', () => {
    setup({ prev: null, picked: ['minPoolCost', 'rho'] as never[], inputs: { minPoolCost: '200', rho: '0.25' } });
    const rho = screen.getByRole('group', { name: 'Monetary expansion' });
    expect(within(rho).getByText('Preprod epoch totals, epoch 660')).toBeTruthy();
    const cost = screen.getByRole('group', { name: 'Minimum pool cost' });
    expect(within(cost).getByText('Preprod pool data, epoch 660')).toBeTruthy();
  });

  it('shows no change count before a parameter is picked', () => {
    setup({ prev: null, picked: [], inputs: {} });
    const summary = screen.getByRole('complementary', { name: 'Summary' });
    expect(within(summary).getByText('Pick a parameter to start.')).toBeTruthy();
    expect(summary.querySelector('.pcp-action__count')).toBeNull();
    expect(within(summary).queryByText(/0 changes/)).toBeNull();
  });

  it('leaves a reward change with a field error out of the combined caption', () => {
    setup({ prev: null, picked: ['k', 'rho', 'tau'] as never[], inputs: { k: '600', rho: '0.35', tau: '35' } });
    const section = screen.getByRole('region', { name: 'Combined impact of this proposal' });
    expect(caption(section)).toBe('Calculated with k 500 → 600 and rho 0.3% → 0.35%');
    // rho keeps its budget panel in its own card.
    expect(within(screen.getByRole('group', { name: 'Monetary expansion' })).getByText('From the reserve per epoch')).toBeTruthy();
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
    const chip = screen.getByRole('button', { name: 'tau, value not valid' });
    expect(chip.getAttribute('data-state')).toBe('invalid');
    expect(chip.textContent).toBe('tau!');
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
    expect(within(summary).getByText('2 changes')).toBeTruthy();
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

  const OPEN_CHANGE = {
    txHash: 'ef'.repeat(32),
    index: 0,
    id: 'gov_action1x',
    type: 'ParameterChange',
    title: 'Reduce minPoolCost to 75 ada',
    proposedEpoch: 654,
  };
  const renderWithOpen = (prev: { txHashHex: string; index: number } | null) =>
    render(
      <ParamChangePanel
        value={{ prev, picked: [], inputs: {} }}
        onChange={vi.fn()}
        context={{ ...(context as object), prev: { lastEnacted: null, open: [OPEN_CHANGE] } } as never}
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

  it('shows the open competing proposal', () => {
    renderWithOpen(null);
    expect(screen.getByText(/Another parameter change is open: Reduce minPoolCost to 75 ada\./)).toBeTruthy();
    expect(
      screen.getByText(
        /Only one parameter change can take effect from the same previous action\. If that one is enacted first, this one can no longer pass\./,
      ),
    ).toBeTruthy();
  });

  it('does not call the open proposal competing when the action builds on it', () => {
    renderWithOpen({ txHashHex: OPEN_CHANGE.txHash, index: OPEN_CHANGE.index });
    expect(screen.queryByText(/Another parameter change is open/)).toBeNull();
  });

  it('docks the action block only while its place in the summary is below the screen', async () => {
    setup();
    const panel = document.querySelector('.pcp-panel') as HTMLElement;
    const slot = panel.querySelector('.pcp-action-slot') as HTMLElement;
    expect(screen.getByRole('complementary', { name: 'Summary' }).contains(slot)).toBe(true);
    let top = 0;
    slot.getBoundingClientRect = () => ({ top }) as DOMRect;
    const scrollTo = async (slotTop: number) => {
      top = slotTop;
      await act(async () => {
        window.dispatchEvent(new Event('scroll'));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      return panel.getAttribute('data-docked');
    };
    // Below the screen: pinned to the bottom edge.
    expect(await scrollTo(window.innerHeight + 600)).toBe('true');
    // Its place has room on screen: back in the summary.
    expect(await scrollTo(window.innerHeight - 200)).toBe('false');
    // Scrolled past, on to the fields below the panel: stays in the summary.
    expect(await scrollTo(-300)).toBe('false');
    // A jump from below the panel straight back to its top docks it again.
    expect(await scrollTo(window.innerHeight + 2000)).toBe('true');
    // A panel wide enough for the summary column never docks, the summary is sticky there.
    panel.getBoundingClientRect = () => ({ left: 0, right: 960, width: 960 }) as DOMRect;
    expect(await scrollTo(window.innerHeight + 2000)).toBe('false');
  });
});
