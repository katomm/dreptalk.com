// Client-side builder for a Conway InfoAction governance-action proposal.
// Non-custodial: the connected wallet signs and submits; the server is never
// involved in key operations. Preprod-only by construction (InfoAction
// submission is a testing/demo flow, never offered on mainnet).

import { Anchor, GovernanceAction, RewardAccount, Url } from '@evolution-sdk/evolution';
import { makeClient, signAndSubmit } from './drepTx.js';
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

export interface SubmitInfoActionOpts {
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
}

/**
 * Pure helper: constructs the typed RewardAccount, GovernanceAction, and Anchor
 * values from the raw inputs in SubmitInfoActionOpts. No network access
 * required. Exported for unit tests that verify construction without a live
 * wallet.
 */
export function buildInfoActionProposeParts(opts: {
  rewardAddressHex: string;
  anchorUrl: string;
  anchorHashHex: string;
}): { rewardAccount: RewardAccount.RewardAccount; governanceAction: GovernanceAction.InfoAction; anchor: Anchor.Anchor } {
  return {
    rewardAccount: RewardAccount.fromHex(opts.rewardAddressHex),
    governanceAction: new GovernanceAction.InfoAction({}),
    anchor: new Anchor.Anchor({
      anchorUrl: new Url.Url({ href: opts.anchorUrl }),
      anchorDataHash: hexToBytes(opts.anchorHashHex),
    }),
  };
}

/**
 * Builds, signs, and submits a Conway InfoAction governance-action proposal.
 *
 * The wallet extension performs signing and submission; the server is never
 * involved in key operations. The CIP-20 attribution tag (label 674) is
 * attached so chain observers can identify DRepTalk-originated actions.
 *
 * Rejected outright on mainnet regardless of what the caller passes: InfoAction
 * submission is a preprod-only flow. Requires a live wallet and a reachable
 * Koios provider; not unit-testable offline beyond the mainnet guard.
 */
export async function submitInfoAction(opts: SubmitInfoActionOpts): Promise<{ txHash: string }> {
  if (opts.network !== 'preprod') {
    throw new Error('Info action submission is preprod only.');
  }

  const { rewardAccount, governanceAction, anchor } = buildInfoActionProposeParts(opts);

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

  // signAndSubmit already returns { txHash }; return it directly, do not re-wrap.
  return signAndSubmit(built, opts.walletApi);
}
