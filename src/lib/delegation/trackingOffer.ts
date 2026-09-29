// Which follow-up the delegation dialog offers once the wallet has submitted a
// delegation. The dialog never learns whether the connected wallet is the
// account's own: a delegator account id IS its stake address, so it must not
// reach a page. The server compares the two inside the track call and answers
// with the TrackState below, which is what turns a signed-in account with some
// other wallet into the same sign-in offer an anonymous visitor gets.

/** What the viewer's session says, as the mounting page knows it. */
export interface TrackingViewer {
  signedIn: boolean;
  /** Whether the account has ANY stake wallet linked, not whether it is this one. */
  hasStakeAddr: boolean;
}

/** Where the track request stands. 'idle' also covers "in flight". */
export type TrackState = 'idle' | 'recorded' | 'wallet_mismatch' | 'error';

export type TrackingOffer =
  /** Sign in with the wallet that just delegated. */
  | { kind: 'sign-in' }
  /** Same action, but this wallet belongs to a different account than the one
   *  currently signed in, so the offer has to say that signing in switches. */
  | { kind: 'switch-account' }
  /** The request is on its way. */
  | { kind: 'tracking' }
  /** The delegation is being tracked for this account. */
  | { kind: 'tracked' }
  /** A writer with no stake wallet linked at all: the settings can fix that. */
  | { kind: 'link-wallet' }
  /** The request failed for a reason that is worth retrying. */
  | { kind: 'retry' };

export function trackingOffer(viewer: TrackingViewer, state: TrackState): TrackingOffer {
  if (!viewer.signedIn) return { kind: 'sign-in' };
  if (!viewer.hasStakeAddr) return { kind: 'link-wallet' };
  switch (state) {
    case 'recorded':
      return { kind: 'tracked' };
    // Signing in with the delegating wallet moves the session to the account
    // this delegation belongs to, which is exactly what a mismatch needs. It
    // also replaces the current session, so this is its own offer and its own
    // copy: a DRep who delegated with a second wallet would otherwise be
    // signed out of their DRep account by a button that says nothing about it.
    case 'wallet_mismatch':
      return { kind: 'switch-account' };
    case 'error':
      return { kind: 'retry' };
    default:
      return { kind: 'tracking' };
  }
}
