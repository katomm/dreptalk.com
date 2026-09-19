// Client-side builder for a Conway governance-action proposal, covering all
// five unwitnessed action types (InfoAction, NoConfidence, HardForkInitiation,
// NewConstitution, UpdateCommittee). Non-custodial: the connected wallet signs
// and submits, the server is never involved in key operations. Preprod-only
// by construction: governance action submission is a testing/demo flow, never
// offered on mainnet.

import { Anchor, RewardAccount, Url } from '@evolution-sdk/evolution';
import { makeClient, signAndSubmit } from './drepTx.js';
import { buildGovernanceAction, type GovActionSpec } from './govActionParts.js';
import {
  FUNDING_HEADROOM_LOVELACE,
  collectWalletUtxos,
  pickInputsToCover,
  totalLovelace,
  type WalletApi,
} from './walletUtxos.js';
import { dreptalkCip20Metadatum, DREPTALK_CIP20_LABEL } from '../cardano/tx.js';
import { hexToBytes } from '../crypto/hex.js';
import type { CardanoNetwork } from '../config/network.js';
import { govActionSubmissionAvailable } from './submissionGate.js';

export interface SubmitGovActionOpts {
  /** CIP-30 wallet API obtained from cardano[walletId].enable(). */
  walletApi: WalletApi;
  network: CardanoNetwork;
  /** window.location.origin, used as the base for the /api/koios proxy. */
  origin: string;
  /** Reward address (hex) that receives the deposit refund when the action expires or is enacted. */
  rewardAddressHex: string;
  /** Hosted metadata URL returned by POST /api/info-action/metadata. */
  anchorUrl: string;
  /** 64-char blake2b-256 hex paired with anchorUrl. */
  anchorHashHex: string;
  /** Current govActionDeposit protocol parameter, in lovelace. Sizes input selection only. */
  govActionDepositLovelace: bigint;
  /** The governance action to propose. */
  action: GovActionSpec;
}

/**
 * Builds, signs, and submits a Conway governance-action proposal for any of
 * the five unwitnessed action types.
 *
 * The wallet extension performs signing and submission, the server is never
 * involved in key operations. The CIP-20 attribution tag (label 674) is
 * attached so chain observers can identify DRepTalk-originated actions.
 *
 * Rejected outright on mainnet regardless of what the caller passes:
 * governance action submission is a preprod-only flow. Requires a live
 * wallet and a reachable Koios provider, not unit-testable offline beyond the
 * mainnet guard and the propose-op wiring (see govActionTx.test.ts).
 */
export async function submitGovAction(opts: SubmitGovActionOpts): Promise<{ txHash: string }> {
  if (!govActionSubmissionAvailable(opts.network)) {
    throw new Error('Governance action submission is preprod only.');
  }

  const rewardAccount = RewardAccount.fromHex(opts.rewardAddressHex);
  const governanceAction = buildGovernanceAction(opts.action);
  const anchor = new Anchor.Anchor({
    anchorUrl: new Url.Url({ href: opts.anchorUrl }),
    anchorDataHash: hexToBytes(opts.anchorHashHex),
  });

  const availableUtxos = await collectWalletUtxos(opts.network, opts.origin, opts.walletApi);
  // The proposal locks the gov action deposit, so the inputs must cover deposit + fee.
  const requiredLovelace = opts.govActionDepositLovelace + FUNDING_HEADROOM_LOVELACE;
  // Fail on the shortfall here rather than letting the builder's balance error
  // carry it: the submit form turns these two numbers into a readable message,
  // and tells a Preview wallet (zero preprod UTxOs) apart from an empty one.
  const availableLovelace = totalLovelace(availableUtxos);
  if (availableLovelace < requiredLovelace) {
    throw new Error(
      `Insufficient tADA for the deposit: need ${requiredLovelace} lovelace, wallet has ${availableLovelace}.`,
    );
  }
  const inputs = pickInputsToCover(availableUtxos, requiredLovelace);

  const built = await makeClient(opts.network, opts.origin, opts.walletApi)
    .newTx()
    .propose({ governanceAction, rewardAccount, anchor })
    .attachMetadata({ label: DREPTALK_CIP20_LABEL, metadata: dreptalkCip20Metadatum() })
    .collectFrom({ inputs })
    .build({ availableUtxos });

  // signAndSubmit already returns { txHash }, return it directly, do not re-wrap.
  return signAndSubmit(built, opts.walletApi);
}
