// Client-side builder for a Conway governance-action proposal, covering every
// type the submit form offers: the five unwitnessed types plus
// TreasuryWithdrawals and ParameterChange, whose policy hash makes the ledger
// run the constitution's guardrails script through a propose redeemer.
// Non-custodial: the connected wallet signs and submits, the server holds no
// key and only evaluates the guardrail (see guardrailEvaluator.ts). Behind the
// submission switch, and for treasury withdrawals and parameter changes
// preprod only.

import { Anchor, Data, RewardAccount, Url, type GovernanceAction } from '@evolution-sdk/evolution';
import { makeClient, signAndSubmit } from './drepTx.js';
import { buildGovernanceAction, isGuardrailSpec, type GovActionSpec } from './govActionParts.js';
import { guardrailDecision, type GuardrailContext } from './guardrailScript.js';
import { guardrailPlutusScript } from './guardrailPlutusScript.js';
import { makeGuardrailEvaluator } from './guardrailEvaluator.js';
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
import { govActionSubmissionAvailable, govActionTypeAvailable } from './submissionGate.js';

export interface SubmitGovActionOpts {
  /** CIP-30 wallet API obtained from cardano[walletId].enable(). */
  walletApi: WalletApi;
  network: CardanoNetwork;
  /** window.location.origin, used as the base for the /api/koios proxy and the evaluate route. */
  origin: string;
  /**
   * Reward address (hex) that receives the deposit refund when the action expires or is enacted.
   */
  rewardAddressHex: string;
  /** Hosted metadata URL returned by POST /api/info-action/metadata. */
  anchorUrl: string;
  /** 64-char blake2b-256 hex paired with anchorUrl. */
  anchorHashHex: string;
  /** Current govActionDeposit protocol parameter, in lovelace. Sizes input selection only. */
  govActionDepositLovelace: bigint;
  /**
   * The governance action to propose. A treasury withdrawal or parameter change carries its checked
   * guardrail.
   */
  action: GovActionSpec;
}

/**
 * The tx builder submitGovAction chains onto, derived from makeClient so the SDK's param shapes are
 * never re-declared.
 */
export type GovActionTxBuilder = ReturnType<ReturnType<typeof makeClient>['newTx']>;

/**
 * Queues a proposal checked by the constitution's guardrails script, a
 * treasury withdrawal or a parameter change. With a known guardrail the proposal
 * carries the propose redeemer and the script rides in the witness set, so
 * the ledger can run it. The redeemer is the unit constructor: the guardrail
 * does not inspect it (preview dry runs with three different redeemers gave
 * identical ExUnits). A proven absence proposes without either. Any other
 * guardrail is refused here as a second line behind the island's check. Pure
 * apart from the builder it is given, so a live test can drive it against a
 * read-only client.
 */
export function queueGuardrailProposeOps(
  txb: GovActionTxBuilder,
  opts: {
    action: GovernanceAction.GovernanceAction;
    rewardAccount: RewardAccount.RewardAccount;
    anchor: Anchor.Anchor;
    guardrail: GuardrailContext;
  },
): GovActionTxBuilder {
  const { action, rewardAccount, anchor } = opts;
  const decision = guardrailDecision(opts.guardrail);
  if (!decision.ok) throw new Error(decision.message);
  if (decision.guardrail.state === 'absent') return txb.propose({ governanceAction: action, rewardAccount, anchor });
  return txb
    .propose({ governanceAction: action, rewardAccount, anchor, redeemer: Data.constr(0n, []), label: 'guardrail' })
    .attachScript({ script: guardrailPlutusScript() });
}

/**
 * Builds, signs, and submits a Conway governance-action proposal.
 *
 * The wallet extension performs signing and submission, the server is never
 * involved in key operations. The CIP-20 attribution tag (label 674) is
 * attached so chain observers can identify DRepTalk-originated actions. A
 * treasury withdrawal or parameter change with a known guardrail is evaluated
 * through the evaluate route, which the SDK calls once for the unevaluated
 * redeemer.
 *
 * Rejected outright where submission is off, and a treasury withdrawal or
 * parameter change wherever the type is unavailable. Requires a live wallet
 * and a reachable Koios provider, not unit-testable offline beyond the guards
 * and the propose wiring (see govActionTx.test.ts).
 */
export async function submitGovAction(opts: SubmitGovActionOpts): Promise<{ txHash: string }> {
  const submissionAvailable = govActionSubmissionAvailable(opts.network);
  if (!submissionAvailable) {
    throw new Error('Governance action submission is preprod only.');
  }
  if (isGuardrailSpec(opts.action) && !govActionTypeAvailable(opts.action.type, { submissionAvailable, network: opts.network })) {
    throw new Error(
      opts.action.type === 'ParameterChange' ? 'Parameter changes are preprod only.' : 'Treasury withdrawals are preprod only.',
    );
  }

  // Check the guardrail before anything is built, and use its canonical form from here on.
  let action = opts.action;
  if (isGuardrailSpec(action)) {
    const decision = guardrailDecision(action.guardrail);
    if (!decision.ok) throw new Error(decision.message);
    action = { ...action, guardrail: decision.guardrail };
  }

  const rewardAccount = RewardAccount.fromHex(opts.rewardAddressHex);
  const governanceAction = buildGovernanceAction(action);
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

  const txb = makeClient(opts.network, opts.origin, opts.walletApi).newTx();
  const guardrail = isGuardrailSpec(action) ? action.guardrail : null;
  const proposed = guardrail
    ? queueGuardrailProposeOps(txb, { action: governanceAction, rewardAccount, anchor, guardrail })
    : txb.propose({ governanceAction, rewardAccount, anchor });
  // Only a known guardrail adds a redeemer, and only a redeemer needs evaluating.
  const evaluator = guardrail?.state === 'known' ? makeGuardrailEvaluator(opts.origin) : undefined;

  const built = await proposed
    .attachMetadata({ label: DREPTALK_CIP20_LABEL, metadata: dreptalkCip20Metadatum() })
    .collectFrom({ inputs })
    .build({ availableUtxos, ...(evaluator ? { evaluator } : {}) });

  // signAndSubmit already returns { txHash }, return it directly, do not re-wrap.
  return signAndSubmit(built, opts.walletApi);
}
