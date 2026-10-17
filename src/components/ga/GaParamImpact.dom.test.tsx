// @vitest-environment happy-dom
// The impact section on the proposal page: closed by default with no request,
// the charts and the pool data loaded once on the first open, no request for
// the minimum ada chart alone, the retry after a failure and the combined
// rewards section.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import GaParamImpact from './GaParamImpact.js';
import fixture from '../../lib/governance/__fixtures__/poolEconomics660.json';
import type { ParamKey, ParamValuesJson } from '../../lib/governance/paramDefs.js';

const CURRENT: ParamValuesJson = {
  k: { n: '500', d: '1' },
  a0: { n: '3', d: '10' },
  minPoolCost: { n: '170000000', d: '1' },
  rho: { n: '3', d: '1000' },
  tau: { n: '1', d: '5' },
  utxoCostPerByte: { n: '4310', d: '1' },
};
const PROPOSED: ParamValuesJson = {
  k: { n: '600', d: '1' },
  a0: { n: '1', d: '5' },
  minPoolCost: { n: '200000000', d: '1' },
  utxoCostPerByte: { n: '3500', d: '1' },
};
const ESTIMATE = 'What the proposed values would do, computed from the current pool distribution and parameters, so read them as an estimate.';

const ok = () => new Response(JSON.stringify(fixture), { status: 200, headers: { 'content-type': 'application/json' } });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ok());
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(keys: ParamKey[], current: ParamValuesJson = CURRENT) {
  render(<GaParamImpact network="preprod" keys={keys} current={current} proposed={PROPOSED} />);
  return screen.getByRole('button', { name: 'Impact of these changes' });
}

const requests = () => fetchMock.mock.calls.map(([url]) => String(url));

describe('GaParamImpact', () => {
  it('starts closed and sends no request', () => {
    const button = setup(['k', 'utxoCostPerByte']);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('Target number of pools, UTxO cost per byte')).toBeTruthy();
    expect(screen.queryByText(ESTIMATE)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads the charts and the pool data once on open', async () => {
    const button = setup(['k', 'utxoCostPerByte']);
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByText(ESTIMATE)).toBeTruthy();
    expect(await screen.findByText('Preprod pool data, epoch 660')).toBeTruthy();
    expect(requests()).toHaveLength(1);
    expect(requests()[0]).toMatch(/\/api\/pool-economics$/);

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    // Closing hides the charts and keeps them mounted.
    expect(screen.getByText(ESTIMATE).closest('[hidden]')).toBeTruthy();
    fireEvent.click(button);
    expect(screen.getByText(ESTIMATE).closest('[hidden]')).toBeNull();
    expect(screen.getByText('Preprod pool data, epoch 660')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('needs no request for utxoCostPerByte alone', async () => {
    fireEvent.click(setup(['utxoCostPerByte']));
    expect(await screen.findByRole('group', { name: /Plain ada output/ })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('offers Try again after a failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(setup(['k']));
    expect(await screen.findByText('Impact figures are unavailable right now.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Preprod pool data, epoch 660')).toBeTruthy();
    expect(screen.queryByText('Impact figures are unavailable right now.')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shows the combined rewards section for two reward parameters', async () => {
    fireEvent.click(setup(['k', 'a0']));
    const combined = await screen.findByRole('region', { name: 'Combined impact of this proposal' });
    expect(await within(combined).findByText('Preprod pool data, epoch 660')).toBeTruthy();
    const a0 = screen.getByRole('region', { name: 'Pledge influence' });
    expect(within(a0).getByText('Its effect on pool rewards is shown under Combined impact below.')).toBeTruthy();
  });

  it('shows each block with its title, the old and new value and the chart in pcp-impact', async () => {
    fireEvent.click(setup(['k', 'utxoCostPerByte']));
    const k = await screen.findByRole('region', { name: 'Target number of pools' });
    expect(within(k).getByText('500')).toBeTruthy();
    expect(within(k).getByText('600')).toBeTruthy();
    const [sat] = await within(k).findAllByRole('img');
    expect(sat.closest('.pcp-impact')).toBeTruthy();
    const utxo = screen.getByRole('region', { name: 'UTxO cost per byte' });
    expect(within(utxo).getByText('4,310 lovelace/byte')).toBeTruthy();
    expect(within(utxo).getByText('3,500 lovelace/byte')).toBeTruthy();
    expect(within(utxo).getByRole('group', { name: /Plain ada output/ }).closest('.pcp-impact')).toBeTruthy();
  });

  it('shows the minPoolCost histogram when a model key is missing', async () => {
    const current = { ...CURRENT };
    delete current.a0;
    fireEvent.click(setup(['minPoolCost'], current));
    const block = await screen.findByRole('region', { name: 'Minimum pool cost' });
    expect(await within(block).findByRole('img', { name: /^Fixed cost of \d+ pools/ })).toBeTruthy();
  });
});
