// LIVE preprod build of a guardrail-checked treasury withdrawal (gated, see
// __fixtures__/liveWallet.ts for the wallet it needs). Nothing is submitted.
// It drives queueTreasuryProposeOps against a read-only client on preprod
// Koios directly, with the SDK's own provider evaluator (Koios /ogmios, no
// token), so it proves the propose redeemer, the attached script, the
// collateral and the evaluation against the live chain before any deploy.
// The evaluate route and the browser adapter run only in the E2E.
import { describe, it, expect } from 'vitest';
import {
  Address,
  Anchor,
  Client,
  RewardAccount,
  ScriptHash,
  Transaction,
  TransactionHash,
  UTxO,
  Url,
  preprod,
} from '@evolution-sdk/evolution';
import { LIVE, PREPROD_KOIOS, loadDrepKey } from './__fixtures__/liveWallet.js';
import { buildGovernanceAction } from './govActionParts.js';
import { queueTreasuryProposeOps, type GovActionTxBuilder } from './govActionTx.js';
import { pickConstitutionScriptHash } from './guardrailPick.js';
import { GUARDRAIL_SCRIPT_HASH_HEX } from './guardrailScript.js';
import { pickLastEnacted } from './prevAction.js';
import { FUNDING_HEADROOM_LOVELACE, pickInputsToCover } from './walletUtxos.js';
import { createKoiosClient } from '../koios/client.js';
import { DREPTALK_CIP20_LABEL, dreptalkCip20Metadatum } from '../cardano/tx.js';

// Optional: a Koios token from the environment, for an /ogmios that refuses
// anonymous calls. Never logged.
const KOIOS_TOKEN = process.env.KOIOS_API_KEY || undefined;

/** The message and every cause's message, for matching an HTTP status the SDK wraps. */
function errorText(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth++) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string') parts.push(message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

describe.skipIf(!LIVE)('LIVE preprod treasury withdrawal build', () => {
  it('builds with the guardrail redeemer, the script, evaluated ExUnits and 5 ada collateral', async (ctx) => {
    // The guardrail the context route would report, from the same rows.
    const koios = createKoiosClient({ baseUrl: PREPROD_KOIOS, token: KOIOS_TOKEN });
    const [constitutionRows, policyRows] = await Promise.all([
      koios.lastRatifiedProposal(['NewConstitution']),
      koios.lastRatifiedProposal(['ParameterChange', 'TreasuryWithdrawals']),
    ]);
    const guardrail = pickConstitutionScriptHash(pickLastEnacted(constitutionRows), pickLastEnacted(policyRows));
    expect(guardrail).toEqual({ state: 'known', scriptHash: GUARDRAIL_SCRIPT_HASH_HEX });
    if (guardrail.state !== 'known') throw new Error('expected a known guardrail on preprod');

    const { paymentAddress } = loadDrepKey();
    const address = Address.fromBech32(paymentAddress);
    if (!address.stakingCredential) throw new Error('the test wallet address carries no stake credential');
    const rewardAccount = new RewardAccount.RewardAccount({ networkId: 0, stakeCredential: address.stakingCredential });
    const rewardAddressHex = RewardAccount.toHex(rewardAccount);

    const params = (await (await fetch(`${PREPROD_KOIOS}/epoch_params?limit=1`)).json()) as Array<{
      gov_action_deposit: number | string;
    }>;
    const deposit = BigInt(params[0].gov_action_deposit);

    const reader = Client.make(preprod).withKoios({ baseUrl: PREPROD_KOIOS, token: KOIOS_TOKEN });
    const utxos = await reader.getUtxos(address);
    const client = Client.make(preprod).withKoios({ baseUrl: PREPROD_KOIOS, token: KOIOS_TOKEN }).withAddress(paymentAddress);

    const action = buildGovernanceAction({
      type: 'TreasuryWithdrawals',
      withdrawals: [{ rewardAddressHex, lovelace: 1_000_000n }],
      guardrail,
    });
    const anchor = new Anchor.Anchor({
      anchorUrl: new Url.Url({ href: 'https://preprod.dreptalk.com/live-test.jsonld' }),
      anchorDataHash: new Uint8Array(32),
    });

    let built: Awaited<ReturnType<GovActionTxBuilder['build']>>;
    try {
      built = await queueTreasuryProposeOps(client.newTx() as unknown as GovActionTxBuilder, {
        action,
        rewardAccount,
        anchor,
        guardrail,
      })
        .attachMetadata({ label: DREPTALK_CIP20_LABEL, metadata: dreptalkCip20Metadatum() })
        .collectFrom({ inputs: pickInputsToCover(utxos, deposit + FUNDING_HEADROOM_LOVELACE) })
        .build({ availableUtxos: utxos });
    } catch (err) {
      // Without a token, an /ogmios that wants one is a setup gap, not a failure of the code under test.
      if (!KOIOS_TOKEN && /\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(errorText(err))) {
        console.warn('Koios /ogmios needs a token: set KOIOS_API_KEY to run this test. Skipping.');
        ctx.skip();
      }
      throw err;
    }
    const tx = await built.toTransaction();

    // One proposal: the treasury withdrawal, the context's policy hash, the
    // wallet's reward account, the live deposit.
    const proposals = tx.body.proposalProcedures?.procedures ?? [];
    expect(proposals).toHaveLength(1);
    const [proposal] = proposals;
    expect(proposal.deposit).toBe(deposit);
    expect(RewardAccount.toHex(proposal.rewardAccount)).toBe(rewardAddressHex);
    const proposed = proposal.governanceAction;
    if (proposed._tag !== 'TreasuryWithdrawalsAction') throw new Error(`unexpected action ${proposed._tag}`);
    expect(proposed.policyHash ? ScriptHash.toHex(proposed.policyHash) : null).toBe(guardrail.scriptHash);

    // One propose redeemer at index 0, evaluated.
    const redeemers = tx.witnessSet.redeemers?.toArray() ?? [];
    expect(redeemers.map((r) => [r.tag, r.index])).toEqual([['propose', 0n]]);
    expect(redeemers[0].exUnits.mem).toBeGreaterThan(0n);
    expect(redeemers[0].exUnits.steps).toBeGreaterThan(0n);

    // The guardrail script in the witness set, and script_data_hash set.
    const scripts = tx.witnessSet.plutusV3Scripts ?? [];
    expect(scripts.map((s) => ScriptHash.toHex(ScriptHash.fromScript(s)))).toEqual([GUARDRAIL_SCRIPT_HASH_HEX]);
    expect(tx.body.scriptDataHash).toBeTruthy();

    // Collateral: one to three inputs, a fixed 5 ada total, and a return
    // output exactly when the inputs leave something over.
    const collateral = tx.body.collateralInputs ?? [];
    expect(collateral.length).toBeGreaterThanOrEqual(1);
    expect(collateral.length).toBeLessThanOrEqual(3);
    expect(tx.body.totalCollateral).toBe(5_000_000n);
    const byRef = new Map(utxos.map((u) => [UTxO.toOutRefString(u), u]));
    const used = collateral.map((input) => byRef.get(`${TransactionHash.toHex(input.transactionId)}#${input.index}`));
    expect(used.every((u) => u !== undefined)).toBe(true);
    const collateralLovelace = used.reduce((sum, u) => sum + (u?.assets.lovelace ?? 0n), 0n);
    const collateralTokens = used.some((u) => u?.assets.multiAsset !== undefined);
    expect(tx.body.collateralReturn !== undefined).toBe(collateralLovelace > 5_000_000n || collateralTokens);

    // Serializes the way signAndSubmit does before the wallet signs, and
    // decodes back with the proposal and the propose redeemer intact.
    const decoded = Transaction.fromCBORHex(Transaction.toCBORHex(tx));
    expect(decoded.body.proposalProcedures?.procedures ?? []).toHaveLength(1);
    const decodedRedeemers = decoded.witnessSet.redeemers?.toArray() ?? [];
    expect(decodedRedeemers).toHaveLength(1);
    expect(decodedRedeemers[0].tag).toBe('propose');
  }, 120_000);
});
