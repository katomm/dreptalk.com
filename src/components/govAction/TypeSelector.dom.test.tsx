// @vitest-environment happy-dom
// The treasury withdrawal and parameter change cards, with the deciders line
// and threshold sentence from thresholds.ts, on both networks.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import TypeSelector from './TypeSelector.js';

afterEach(cleanup);

const props = {
  value: 'InfoAction' as const,
  onChange: () => {},
  params: null,
  deposit: { status: 'loading' } as const,
};

describe('TypeSelector', () => {
  it('offers a treasury withdrawal on preprod, decided by DReps and the committee and checked by the guardrails script', () => {
    render(<TypeSelector {...props} network="preprod" />);
    const radio = screen.getByRole('radio', { name: /Treasury withdrawal/ });
    const card = radio.closest('label');
    expect(card?.textContent).toContain("The constitution's guardrails script checks the action");
    expect(card?.textContent).toContain('Decided by DReps and the committee');
  });

  it('offers every type on mainnet, with the deposit in ada', () => {
    render(<TypeSelector {...props} deposit={{ status: 'ready', lovelace: 100_000_000_000n } as never} network="mainnet" />);
    for (const name of [/Info action/, /No confidence/, /Hard fork/, /New constitution/, /Update committee/, /Treasury withdrawal/, /Protocol parameter change/]) {
      expect(screen.getByRole('radio', { name })).toBeTruthy();
    }
    expect(screen.getAllByText('Deposit 100,000 ada, refunded when the action is finalized').length).toBeGreaterThan(0);
  });

  it('offers a parameter change on preprod, with the threshold of the groups DRepTalk can change', () => {
    const params = { dvtPpTechnical: 0.67, dvtPpEconomic: 0.6, dvtPpGov: 0.75, dvtPpNetwork: 0.67 } as never;
    render(<TypeSelector {...props} params={params} network="preprod" />);
    const card = screen.getByRole('radio', { name: /Protocol parameter change/ }).closest('label');
    expect(card?.textContent).toContain('DReps 67%, stake pools');
    expect(card?.textContent).not.toContain('do not vote');
    expect(card?.textContent).toContain('UTxO cost per byte');
  });

  it('makes no contradicting stake pool claim while thresholds load', () => {
    render(<TypeSelector {...props} network="preprod" />);
    const card = screen.getByRole('radio', { name: /Protocol parameter change/ }).closest('label');
    expect(card?.textContent).not.toContain('do not vote');
    expect(card?.textContent).toContain('Loading the current voting thresholds');
  });
});
