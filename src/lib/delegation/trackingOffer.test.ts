import { describe, it, expect } from 'vitest';
import { trackingOffer } from './trackingOffer.js';

const anon = { signedIn: false, hasStakeAddr: false };
const writerNoWallet = { signedIn: true, hasStakeAddr: false };
const delegator = { signedIn: true, hasStakeAddr: true };

describe('trackingOffer', () => {
  it('offers sign-in to a visitor who is not signed in', () => {
    expect(trackingOffer(anon, 'idle')).toEqual({ kind: 'sign-in' });
  });

  it('points a signed-in account without any linked wallet at the settings', () => {
    expect(trackingOffer(writerNoWallet, 'idle')).toEqual({ kind: 'link-wallet' });
  });

  it('reports tracking while the request is in flight', () => {
    expect(trackingOffer(delegator, 'idle')).toEqual({ kind: 'tracking' });
  });

  it('confirms tracking once the expectation was recorded', () => {
    expect(trackingOffer(delegator, 'recorded')).toEqual({ kind: 'tracked' });
  });

  it('names the account switch when the wallet belongs to another account', () => {
    // Same action as a plain sign-in, but the person is already signed in
    // somewhere else, and signing in with this wallet replaces that session.
    // A DRep who delegates with a second wallet must be told before they click.
    expect(trackingOffer(delegator, 'wallet_mismatch')).toEqual({ kind: 'switch-account' });
  });

  it('offers a retry when the request failed', () => {
    expect(trackingOffer(delegator, 'error')).toEqual({ kind: 'retry' });
  });

  it('never points an account with a linked wallet at the settings', () => {
    for (const state of ['idle', 'recorded', 'wallet_mismatch', 'error'] as const) {
      expect(trackingOffer(delegator, state).kind).not.toBe('link-wallet');
    }
  });
});
