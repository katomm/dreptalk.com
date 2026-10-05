// Why the submit button is disabled, in words. A grey button that explains
// nothing is the worst part of a long form: the reducer and the leaf
// validators already know every reason, so this turns them into a short list
// the sign-and-submit section renders next to the button.
//
// Pure and total: same input, same list, no fetching and no React. An empty
// array means the action can be submitted.
//
// The balance rule is deliberately the builder's own rule: the deposit plus
// FUNDING_HEADROOM_LOVELACE, read from the same module the transaction builder
// selects inputs with, so the form can never promise a submit the builder
// would refuse (or refuse one it would accept).
import type { GovActionFormType } from './prevAction.js';
import type { ContextState, WalletState } from './govActionFormState.js';
import { FUNDING_HEADROOM_LOVELACE } from './walletUtxos.js';
import { formatAdaPlain } from '../format/ada.js';

export type ReadinessKey =
  | 'context'
  | 'panel'
  | 'metadata'
  | 'author'
  | 'surveyRef'
  | 'draftConflict'
  | 'deposit'
  | 'wallet'
  | 'balanceLoading'
  | 'balanceUnknown'
  | 'balance'
  | 'rewardUnregistered';

export interface ReadinessReason {
  key: ReadinessKey;
  message: string;
}

export interface ReadinessInput {
  type: GovActionFormType;
  /** The chain context's own status. InfoAction loads none and stays idle. */
  contextStatus: ContextState['status'];
  /**
   * The current type's panel verdict, or null when the panel has no rules of
   * its own or cannot be judged yet (no context at all). The error text stays
   * on the field itself, the list only points at it.
   */
  panelValidation: { ok: boolean; error: string } | null;
  /** Title, abstract, motivation and rationale all filled. */
  metadataComplete: boolean;
  /** "Sign as author" is off, or it is on and a name is given. */
  authorOk: boolean;
  /** The survey reference field is empty or parses. */
  surveyRefOk: boolean;
  /** More than one reference points at an open Proposal Draft. */
  draftConflict: boolean;
  wallet: WalletState;
  /** The current deposit, or null while it is unknown. */
  depositLovelace: bigint | null;
}

/** How each type's panel is named in "Fix the ... changes above". */
const PANEL_LABEL: Record<GovActionFormType, string> = {
  InfoAction: 'info action',
  NoConfidence: 'no confidence',
  HardForkInitiation: 'hard fork',
  NewConstitution: 'constitution',
  UpdateCommittee: 'committee',
};

/**
 * Everything standing between the form as it is and a submittable proposal,
 * in reading order: the form's own problems first, the wallet last, which is
 * the order the page itself is in.
 */
export function readinessReasons(input: ReadinessInput): ReadinessReason[] {
  const reasons: ReadinessReason[] = [];

  // InfoAction is unchained: it fetches no context, so its idle status is not
  // something to wait for.
  if (input.type !== 'InfoAction' && input.contextStatus !== 'ready') {
    reasons.push({ key: 'context', message: 'Waiting for the chain context' });
  }

  if (input.panelValidation && !input.panelValidation.ok) {
    reasons.push({ key: 'panel', message: `Fix the ${PANEL_LABEL[input.type]} changes above` });
  }

  if (!input.metadataComplete) {
    reasons.push({ key: 'metadata', message: 'Fill in title, abstract, motivation and rationale' });
  }

  if (!input.authorOk) {
    reasons.push({ key: 'author', message: 'Name the author or turn off signing as author' });
  }

  if (!input.surveyRefOk) {
    reasons.push({ key: 'surveyRef', message: 'Fix the survey reference' });
  }

  if (input.draftConflict) {
    reasons.push({ key: 'draftConflict', message: 'Keep one Proposal Draft reference' });
  }

  if (input.depositLovelace === null) {
    reasons.push({ key: 'deposit', message: 'Waiting for the current deposit' });
  }

  if (input.wallet.status !== 'connected') {
    reasons.push({ key: 'wallet', message: 'Connect a wallet' });
    return reasons;
  }

  const balance = input.wallet.balance;
  if (balance.status === 'loading') {
    reasons.push({ key: 'balanceLoading', message: 'Reading the wallet balance' });
    return reasons;
  }
  if (balance.status === 'error') {
    reasons.push({ key: 'balanceUnknown', message: 'Could not read the wallet balance, check again' });
    return reasons;
  }

  // Outside the Conway bootstrap phase the ledger rejects a proposal whose
  // refund address is not a registered stake account, and only after the
  // wallet has signed. Saying it here saves the user that round trip.
  if (balance.rewardRegistered === false) {
    reasons.push({
      key: 'rewardUnregistered',
      message:
        "This wallet's stake key is not registered, so the ledger would refuse it as the deposit refund address. Register it in your wallet, for example by delegating, then check again",
    });
  }

  // Nothing to compare a balance against while the deposit is unknown, and
  // that is already on the list.
  if (input.depositLovelace === null) return reasons;

  const required = input.depositLovelace + FUNDING_HEADROOM_LOVELACE;
  if (balance.lovelace < required) {
    reasons.push({
      key: 'balance',
      message: `The wallet holds ${formatAdaPlain(balance.lovelace)} tADA, the deposit plus a ${formatAdaPlain(FUNDING_HEADROOM_LOVELACE)} tADA fee reserve needs ${formatAdaPlain(required)}`,
    });
  }

  return reasons;
}
