// Devnet proof for parameter changes: the real constitution guardrail script
// judges the bounds, and a proposal built by the app's own code goes through
// voting, ratification and enactment on a local Conway chain. Runs only
// through `npm run test:devnet` and needs Docker. There is no skip condition
// on purpose: without Docker the cluster start fails loudly instead of the
// suite passing with zero tests.
//
// The tests share one cluster and run in order: the bounds only build, the
// lifecycle enacts the first change, the stale previous id case and the exact
// rationals case build on that enacted change.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Anchor,
  Bytes32,
  DRep,
  GovernanceAction,
  KeyHash,
  NonnegativeInterval,
  ProtocolParamUpdate,
  RewardAccount,
  ScriptHash,
  Transaction,
  TransactionHash,
  UnitInterval,
  Url,
  VotingProcedures,
  type UTxO,
} from '@evolution-sdk/evolution';
import { startDevnet, show, type DevnetClient, type DevnetHandle } from './__devnet__/cluster.js';
import { buildGovernanceAction } from './govActionParts.js';
import { isStalePrevError } from './govActionErrors.js';
import { queueGuardrailProposeOps, type GovActionTxBuilder } from './govActionTx.js';
import { GUARDRAIL_SCRIPT_HASH_HEX, type GuardrailContext } from './guardrailScript.js';
import { buildParamUpdate } from './paramUpdate.js';
import { parseParamInput, type ParamKey, type ParamValues } from './paramDefs.js';
import type { PrevActionRef } from './prevAction.js';

const GUARDRAIL: GuardrailContext = { state: 'known', scriptHash: GUARDRAIL_SCRIPT_HASH_HEX };
const GUARDRAIL_HASH = ScriptHash.fromHex(GUARDRAIL_SCRIPT_HASH_HEX);
/** DEFAULT_CONWAY_GENESIS.govActionDeposit, refunded to the reward account on enactment. */
const GOV_ACTION_DEPOSIT = 50_000_000_000n;
const PROPOSER = 0;
const BOUNDS_ACCOUNT = 2;
const COMMITTEE = [3, 4] as const;

const anchor = (path: string) =>
  new Anchor.Anchor({
    anchorUrl: new Url.Url({ href: `https://example.com/${path}` }),
    anchorDataHash: Bytes32.fromHex('0'.repeat(64)),
  });

/** The message of an error and every cause below it, so a wrapped Ogmios failure stays readable. */
function errorText(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth++) {
    if (typeof current !== 'object') {
      parts.push(String(current));
      break;
    }
    const message = (current as { message?: unknown }).message;
    parts.push(typeof message === 'string' ? message : show(current));
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

/** Parses the typed form value into the canonical one, as the panel does. */
function typed(entries: Partial<Record<ParamKey, string>>): ParamValues {
  const values: ParamValues = {};
  for (const [key, raw] of Object.entries(entries) as [ParamKey, string][]) {
    const parsed = parseParamInput(key, raw);
    if (!parsed.ok) throw new Error(`${key} ${raw}: ${parsed.error}`);
    values[key] = parsed.value;
  }
  return values;
}

const nni = (numerator: bigint, denominator: bigint) =>
  new NonnegativeInterval.NonnegativeInterval({ numerator, denominator });
const ui = (numerator: bigint, denominator: bigint) => new UnitInterval.UnitInterval({ numerator, denominator });

interface Wallet {
  client: DevnetClient;
  address: Awaited<ReturnType<DevnetClient['address']>>;
  keyHash: KeyHash.KeyHash;
}

// Ogmios v6 shapes, only the fields the tests read.
type Lovelace = { ada: { lovelace: number | string } };
interface OgmiosParams {
  desiredNumberOfStakePools: number;
  stakePoolPledgeInfluence: string;
  monetaryExpansion: string;
  treasuryExpansion: string;
  minStakePoolCost: Lovelace;
}

describe('parameter change on a devnet', () => {
  let devnet: DevnetHandle | undefined;
  const wallets = new Map<number, Wallet>();
  let rewardAccount: RewardAccount.RewardAccount;
  let stakeKeyHashHex: string;
  let enacted: PrevActionRef | null = null;
  let printedParams = false;

  const dev = () => {
    if (!devnet) throw new Error('Devnet not started.');
    return devnet;
  };
  const wallet = (i: number) => {
    const w = wallets.get(i);
    if (!w) throw new Error(`No wallet ${i}.`);
    return w;
  };

  /** Waits until the transaction is on chain and Kupo shows its change output, so the next build sees it. */
  async function settle(label: string, w: Wallet, txHash: TransactionHash.TransactionHash): Promise<void> {
    const hex = TransactionHash.toHex(txHash);
    expect(await w.client.awaitTx(txHash, 500)).toBe(true);
    await dev().waitFor(`${label} (${hex}) change in Kupo`, async () => {
      const utxos = await w.client.getUtxos(w.address);
      return utxos.some((u: UTxO.UTxO) => TransactionHash.toHex(u.transactionId) === hex) ? true : null;
    });
  }

  async function protocolParams(): Promise<OgmiosParams> {
    const params = await dev().ogmios<OgmiosParams & Record<string, unknown>>('queryLedgerState/protocolParameters');
    if (!printedParams) {
      printedParams = true;
      console.log('[devnet] queryLedgerState/protocolParameters keys:', Object.keys(params).join(', '));
      console.log(
        '[devnet] staking params at start:',
        show({
          desiredNumberOfStakePools: params.desiredNumberOfStakePools,
          stakePoolPledgeInfluence: params.stakePoolPledgeInfluence,
          monetaryExpansion: params.monetaryExpansion,
          treasuryExpansion: params.treasuryExpansion,
          minStakePoolCost: params.minStakePoolCost,
        }),
      );
    }
    return params;
  }

  const proposals = () => dev().ogmios<unknown[]>('queryLedgerState/governanceProposals');

  /** Proposes a parameter change from the proposer with the app's builder and queue helper, unsigned. */
  function buildProposal(values: ParamValues, prev: PrevActionRef | null) {
    const governanceAction = buildGovernanceAction({ type: 'ParameterChange', prev, values, guardrail: GUARDRAIL });
    const txb = wallet(PROPOSER).client.newTx() as unknown as GovActionTxBuilder;
    return queueGuardrailProposeOps(txb, {
      action: governanceAction,
      rewardAccount,
      anchor: anchor('params.json'),
      guardrail: GUARDRAIL,
    })
      .build()
      .catch((err: unknown) => {
        throw new Error(`proposal build failed: ${errorText(err)}`);
      });
  }

  async function voteYes(label: string, w: Wallet, voter: VotingProcedures.Voter, id: GovernanceAction.GovActionId) {
    const procedure = new VotingProcedures.VotingProcedure({ vote: VotingProcedures.yes(), anchor: null });
    const txHash = await w.client
      .newTx()
      .vote({ votingProcedures: VotingProcedures.singleVote(voter, id, procedure) })
      .build()
      .then((b) => b.sign())
      .then((b) => b.submit());
    await settle(label, w, txHash);
    return TransactionHash.toHex(txHash);
  }

  /**
   * DRep yes from the proposer, committee yes from accounts 3 and 4. One
   * after the other: every Ogmios HTTP call opens its own node socket
   * connection, and parallel builds made the node refuse some of them
   * (Ogmios log "resource exhausted", HTTP 500 "Something went wrong").
   */
  async function voteAll(txHash: TransactionHash.TransactionHash): Promise<string[]> {
    const id = new GovernanceAction.GovActionId({ transactionId: txHash, govActionIndex: 0n });
    const drep = new VotingProcedures.DRepVoter({ drep: DRep.fromKeyHash(wallet(PROPOSER).keyHash) });
    const hashes = [await voteYes('DRep vote', wallet(PROPOSER), drep, id)];
    for (const i of COMMITTEE) {
      const voter = new VotingProcedures.ConstitutionalCommitteeVoter({ credential: wallet(i).keyHash });
      hashes.push(await voteYes(`CC vote ${i}`, wallet(i), voter, id));
    }
    return hashes;
  }

  async function waitForParams(label: string, done: (p: OgmiosParams) => boolean): Promise<OgmiosParams> {
    try {
      return await dev().waitFor(label, async () => {
        const p = await protocolParams();
        return done(p) ? p : null;
      }, 120_000);
    } catch (err) {
      throw new Error(`${errorText(err)}\nProposals: ${show(await proposals().catch((e) => errorText(e)))}`);
    }
  }

  beforeAll(async () => {
    const started = Date.now();
    devnet = await startDevnet('dreptalk-param-change');
    console.log(`[devnet] cluster up in ${Date.now() - started} ms`);
    for (const i of [PROPOSER, BOUNDS_ACCOUNT, ...COMMITTEE]) {
      const client = devnet.client(i);
      const address = await client.address();
      const credential = address.paymentCredential;
      if (!(credential instanceof KeyHash.KeyHash)) throw new Error(`Account ${i} has no key hash payment credential.`);
      wallets.set(i, { client, address, keyHash: credential });
    }
    const stake = wallet(PROPOSER).address.stakingCredential;
    if (!stake || !(stake instanceof KeyHash.KeyHash)) throw new Error('The proposer needs a key hash stake credential.');
    rewardAccount = new RewardAccount.RewardAccount({ networkId: 0, stakeCredential: stake });
    stakeKeyHashHex = KeyHash.toHex(stake);
    await protocolParams();
  });

  afterAll(async () => {
    await devnet?.stop();
  }, 120_000);

  it('the guardrail script accepts the bounds and rejects one step past them', async () => {
    const started = Date.now();
    const w = wallet(BOUNDS_ACCOUNT);
    const stake = w.address.stakingCredential;
    if (!stake) throw new Error('Account 2 needs a stake credential.');
    const boundsReward = new RewardAccount.RewardAccount({ networkId: 0, stakeCredential: stake });
    const genesisUtxo = dev().genesisUtxo(BOUNDS_ACCOUNT);

    const build = (label: string, update: ProtocolParamUpdate.ProtocolParamUpdate) => {
      const action = new GovernanceAction.ParameterChangeAction({
        govActionId: null,
        protocolParamUpdate: update,
        policyHash: GUARDRAIL_HASH,
      });
      const txb = w.client.newTx() as unknown as GovActionTxBuilder;
      return queueGuardrailProposeOps(txb, {
        action,
        rewardAccount: boundsReward,
        anchor: anchor(`${label}.json`),
        guardrail: GUARDRAIL,
      }).build({ availableUtxos: [genesisUtxo] });
    };

    const valid: [string, ParamValues][] = [
      ['k 250', typed({ k: '250' })],
      ['k 2000', typed({ k: '2000' })],
      ['a0 1/10', typed({ a0: '0.1' })],
      ['a0 1/1', typed({ a0: '1' })],
      ['minPoolCost 0', typed({ minPoolCost: '0' })],
      ['minPoolCost 500 ada', typed({ minPoolCost: '500' })],
      ['rho 1/1000', typed({ rho: '0.1' })],
      ['rho 5/1000', typed({ rho: '0.5' })],
      ['tau 1/10', typed({ tau: '10' })],
      ['tau 3/10', typed({ tau: '30' })],
    ];
    const invalid: [string, ProtocolParamUpdate.ProtocolParamUpdate][] = [
      ['k 249', new ProtocolParamUpdate.ProtocolParamUpdate({ nOpt: 249n })],
      ['k 2001', new ProtocolParamUpdate.ProtocolParamUpdate({ nOpt: 2001n })],
      ['a0 99/1000', new ProtocolParamUpdate.ProtocolParamUpdate({ poolPledgeInfluence: nni(99n, 1000n) })],
      ['a0 1001/1000', new ProtocolParamUpdate.ProtocolParamUpdate({ poolPledgeInfluence: nni(1001n, 1000n) })],
      ['minPoolCost 500000001', new ProtocolParamUpdate.ProtocolParamUpdate({ minPoolCost: 500_000_001n })],
      ['rho 999/1000000', new ProtocolParamUpdate.ProtocolParamUpdate({ expansionRate: ui(999n, 1_000_000n) })],
      ['rho 5001/1000000', new ProtocolParamUpdate.ProtocolParamUpdate({ expansionRate: ui(5001n, 1_000_000n) })],
      ['tau 999/10000', new ProtocolParamUpdate.ProtocolParamUpdate({ treasuryGrowthRate: ui(999n, 10_000n) })],
      ['tau 3001/10000', new ProtocolParamUpdate.ProtocolParamUpdate({ treasuryGrowthRate: ui(3001n, 10_000n) })],
    ];

    for (const [label, values] of valid) {
      const built = await build(label, buildParamUpdate(values)).catch((err) => {
        throw new Error(`valid case ${label} failed: ${errorText(err)}`);
      });
      const redeemers = (await built.toTransaction()).witnessSet.redeemers?.toArray() ?? [];
      expect(redeemers.map((r) => r.tag), label).toEqual(['propose']);
      expect(redeemers[0]!.exUnits.steps, label).toBeGreaterThan(0n);
    }

    let printedRejection = false;
    for (const [label, update] of invalid) {
      const outcome = await build(label, update).then(
        () => null,
        (err: unknown) => errorText(err),
      );
      expect(outcome, `invalid case ${label} built`).not.toBeNull();
      if (!printedRejection) {
        printedRejection = true;
        console.log(`[devnet] guardrail rejection (${label}):`, outcome);
      }
      // Ogmios' script failure code, never a decoding or parse error. The
      // SDK wraps every evaluator failure as "Script evaluation failed", so
      // only the code proves the guardrail itself said no.
      expect(outcome, label).toMatch(/"code":3010/);
      expect(outcome, label).not.toMatch(/deserialis|decod|parse error/i);
    }
    console.log(`[devnet] bounds: ${valid.length} valid, ${invalid.length} invalid in ${Date.now() - started} ms`);
  });

  it('a change of k and a0 is voted, ratified and enacted, and the deposit comes back', async () => {
    const started = Date.now();
    const proposer = wallet(PROPOSER);
    const stake = proposer.address.stakingCredential!;

    // Stake registration (refund target), DRep registration and vote delegation to itself in one transaction.
    const setupTx = await proposer.client
      .newTx()
      .registerStake({ stakeCredential: stake })
      .registerDRep({ drepCredential: proposer.address.paymentCredential, anchor: anchor('drep.json') })
      .delegateToDRep({ stakeCredential: stake, drep: DRep.fromKeyHash(proposer.keyHash) })
      .build({ availableUtxos: [dev().genesisUtxo(PROPOSER)] })
      .then((b) => b.sign())
      .then((b) => b.submit());
    await settle('DRep setup', proposer, setupTx);
    const authTxs: string[] = [];
    for (const i of COMMITTEE) {
      const w = wallet(i);
      const txHash = await w.client
        .newTx()
        .authCommitteeHot({ coldCredential: w.address.paymentCredential, hotCredential: w.address.paymentCredential })
        .build({ availableUtxos: [dev().genesisUtxo(i)] })
        .then((b) => b.sign())
        .then((b) => b.submit());
      await settle(`CC hot auth ${i}`, w, txHash);
      authTxs.push(TransactionHash.toHex(txHash));
    }
    console.log(`[devnet] setup tx ${TransactionHash.toHex(setupTx)}, CC auth txs ${authTxs.join(', ')}`);

    const drepIdHex = KeyHash.toHex(proposer.keyHash);
    let printedDreps = false;
    const powerStarted = Date.now();
    await dev().waitFor('the DRep to have voting power', async () => {
      const dreps = await dev().ogmios<{ id?: string; stake?: Lovelace }[]>('queryLedgerState/delegateRepresentatives');
      if (!printedDreps && dreps.length > 0) {
        printedDreps = true;
        console.log('[devnet] queryLedgerState/delegateRepresentatives entry:', show(dreps[0]));
      }
      const ours = dreps.find((d) => d.id === drepIdHex);
      if (ours?.stake && BigInt(ours.stake.ada.lovelace) > 0n) return ours;
      const epoch = await dev().ogmios<number>('queryLedgerState/epoch');
      throw new Error(`epoch ${epoch}, our DRep ${show(ours ?? null)}`);
    });
    console.log(`[devnet] DRep power after ${Date.now() - powerStarted} ms`);

    // The change the panel would submit for k 600 and a0 0.35.
    const proposeStarted = Date.now();
    const signed = await buildProposal(typed({ k: '600', a0: '0.35' }), null);
    const proposeTx = await signed.sign().then((b) => b.submit());
    await settle('proposal', proposer, proposeTx);
    const proposeHex = TransactionHash.toHex(proposeTx);
    const voteTxs = await voteAll(proposeTx);
    const votedAt = Date.now();
    console.log(
      `[devnet] proposal ${proposeHex}, votes ${voteTxs.join(', ')}, propose to last vote ${votedAt - proposeStarted} ms`,
    );

    const after = await waitForParams('k 600 enacted', (p) => p.desiredNumberOfStakePools === 600);
    console.log(`[devnet] vote to enactment ${Date.now() - votedAt} ms`);
    expect(after.desiredNumberOfStakePools).toBe(600);
    expect(after.stakePoolPledgeInfluence).toBe('7/20');
    enacted = { txHashHex: proposeHex, index: 0 };

    // The refund is read through cardano-cli: Ogmios 6.14 against node 10.5
    // reports 0 rewards for this account (rewardAccountSummaries, and the
    // SDK's Kupmios delegation read built on it) while the ledger holds it.
    const stakeAddress = RewardAccount.toBech32(rewardAccount);
    const rewards = await dev().waitFor('the deposit refund in the reward account', async () => {
      const [info] = await dev().cli<{ rewardAccountBalance: number }[]>([
        'query', 'stake-address-info', '--address', stakeAddress,
      ]);
      const lovelace = BigInt(info?.rewardAccountBalance ?? 0);
      if (lovelace > 0n) return lovelace;
      throw new Error(`stake-address-info ${show(info ?? null)}, proposals ${show(await proposals())}`);
    }, 30_000);
    const ogmiosView = await dev().ogmios<unknown>('queryLedgerState/rewardAccountSummaries', { keys: [stakeKeyHashHex] });
    console.log(`[devnet] refund ${rewards} lovelace per cardano-cli, Ogmios rewardAccountSummaries says ${show(ogmiosView)}`);
    expect(rewards).toBe(GOV_ACTION_DEPOSIT);
    console.log(`[devnet] lifecycle in ${Date.now() - started} ms`);
  });

  it('the ledger rejects a parameter change that names a stale previous action', async () => {
    expect(enacted).not.toBeNull();
    const signed = await buildProposal(typed({ tau: '25' }), null);
    const rejection = await signed
      .sign()
      .then((b) => b.submit())
      .then(
        (hash) => `submitted ${TransactionHash.toHex(hash)}`,
        (err: unknown) => errorText(err),
      );
    console.log('[devnet] stale previous id rejection:', rejection);
    expect(rejection).not.toMatch(/^submitted /);
    expect(isStalePrevError(rejection, null)).toBe(true);
  });

  it('rho and tau travel as exact rationals and enact as such', async () => {
    if (!enacted) throw new Error('needs the enacted change from the lifecycle test');
    const values = typed({ rho: '0.35', tau: '25' });
    const signed = await buildProposal(values, enacted);

    const cborHex = Transaction.toCBORHex(await signed.toTransaction());
    const decoded = Transaction.fromCBORHex(cborHex);
    const procedure = decoded.body.proposalProcedures?.procedures[0];
    const action = procedure?.governanceAction;
    if (!(action instanceof GovernanceAction.ParameterChangeAction)) throw new Error('expected a parameter change');
    const update = action.protocolParamUpdate;
    expect([update.expansionRate?.numerator, update.expansionRate?.denominator]).toEqual([7n, 2000n]);
    expect([update.treasuryGrowthRate?.numerator, update.treasuryGrowthRate?.denominator]).toEqual([1n, 4n]);
    expect(TransactionHash.toHex(action.govActionId!.transactionId)).toBe(enacted.txHashHex);
    expect(cborHex).toContain('d81e82071907d0');
    expect(cborHex).toContain('d81e820104');

    const proposer = wallet(PROPOSER);
    const proposeTx = await signed.sign().then((b) => b.submit());
    await settle('second proposal', proposer, proposeTx);
    const voteTxs = await voteAll(proposeTx);
    const votedAt = Date.now();
    console.log(`[devnet] second proposal ${TransactionHash.toHex(proposeTx)}, votes ${voteTxs.join(', ')}`);

    const after = await waitForParams('rho 7/2000 enacted', (p) => p.monetaryExpansion === '7/2000');
    console.log(`[devnet] second vote to enactment ${Date.now() - votedAt} ms`);
    expect(after.monetaryExpansion).toBe('7/2000');
    expect(after.treasuryExpansion).toBe('1/4');
    expect(after.desiredNumberOfStakePools).toBe(600);
  });
});
