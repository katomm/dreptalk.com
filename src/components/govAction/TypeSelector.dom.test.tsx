// @vitest-environment happy-dom
// The treasury withdrawal card: offered where the type is available, with
// the deciders line from thresholds.ts and the guardrails sentence, and
// absent where the type is not.
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
    render(<TypeSelector {...props} network="preprod" submissionAvailable />);
    const radio = screen.getByRole('radio', { name: /Treasury withdrawal/ });
    const card = radio.closest('label');
    expect(card?.textContent).toContain("The constitution's guardrails script checks the action");
    expect(card?.textContent).toContain('Decided by DReps and the committee');
  });

  // Submission is switched ON for mainnet here, so the info action card is
  // there and only the treasury rule can remove the treasury card: deleting
  // the TreasuryWithdrawals line in govActionTypeAvailable fails this test.
  it('leaves only the treasury card out on mainnet with submission switched on', () => {
    render(<TypeSelector {...props} network="mainnet" submissionAvailable />);
    expect(screen.getByRole('radio', { name: /Info action/ })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /Treasury withdrawal/ })).toBeNull();
  });
});
