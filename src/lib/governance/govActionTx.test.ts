// Unit tests for the mainnet guard, the funding-shortfall message, and the
// propose-op wiring in govActionTx.ts. collectWalletUtxos and makeClient are
// mocked so these run offline, a live wallet and Koios provider are needed
// for the full build/sign/submit path, which is not covered here.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScriptHash, type UTxO } from '@evolution-sdk/evolution';

vi.mock('./walletUtxos.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./walletUtxos.js')>();
  return { ...actual, collectWalletUtxos: vi.fn() };
});

vi.mock('./drepTx.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./drepTx.js')>();
  return { ...actual, makeClient: vi.fn(), signAndSubmit: vi.fn() };
});

vi.mock('./guardrailEvaluator.js', () => ({
  makeGuardrailEvaluator: vi.fn(() => ({ evaluate: vi.fn() })),
}));

// The real gate, spied so one test can simulate a mainnet switch that is on.
vi.mock('./submissionGate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./submissionGate.js')>();
  return { ...actual, govActionSubmissionAvailable: vi.fn(actual.govActionSubmissionAvailable) };
});

import { submitGovAction, queueGuardrailProposeOps, type GovActionTxBuilder } from './govActionTx.js';
import { collectWalletUtxos } from './walletUtxos.js';
import { makeClient, signAndSubmit } from './drepTx.js';
import { makeGuardrailEvaluator } from './guardrailEvaluator.js';
import { govActionSubmissionAvailable } from './submissionGate.js';
import { buildGovernanceAction } from './govActionParts.js';
import { GUARDRAIL_CHANGED_MESSAGE, GUARDRAIL_SCRIPT_HASH_HEX, type GuardrailContext } from './guardrailScript.js';

const ANCHOR_HASH_HEX = 'ab'.repeat(32);

const baseOpts = {
  // Validation and mocked collaborators mean the wallet API is never called directly.
  // biome-ignore lint/suspicious/noExplicitAny: unused past validation and mocking
  walletApi: {} as any,
  origin: 'https://x',
  rewardAddressHex: `e0${'00'.repeat(28)}`,
  anchorUrl: 'ipfs://x',
  anchorHashHex: ANCHOR_HASH_HEX,
  govActionDepositLovelace: 1_000_000n,
  action: { type: 'InfoAction' } as const,
};

describe('submitGovAction', () => {
  it('refuses mainnet regardless of the action, without touching the wallet', async () => {
    await expect(submitGovAction({ ...baseOpts, network: 'mainnet' })).rejects.toThrow(/preprod/i);
  });

  it('reports the exact funding shortfall message the island parses', async () => {
    vi.mocked(collectWalletUtxos).mockResolvedValue([]);

    await expect(submitGovAction({ ...baseOpts, network: 'preprod' })).rejects.toThrow(
      /^Insufficient tADA for the deposit: need (\d+) lovelace, wallet has (\d+)\.$/,
    );
  });

  it('passes the built governance action into propose, via makeClient', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake builder chain
    const propose = vi.fn().mockReturnThis() as any;
    const attachMetadata = vi.fn().mockReturnThis();
    const collectFrom = vi.fn().mockReturnThis();
    const build = vi.fn().mockResolvedValue('built-tx');
    const newTx = vi.fn().mockReturnValue({ propose, attachMetadata, collectFrom, build });

    vi.mocked(makeClient).mockReturnValue({ newTx } as never);
    vi.mocked(signAndSubmit).mockResolvedValue({ txHash: 'deadbeef' });

    const fundedUtxo = {
      assets: { lovelace: 1_000_000_000n },
    } as unknown as import('@evolution-sdk/evolution').UTxO.UTxO;
    vi.mocked(collectWalletUtxos).mockResolvedValue([fundedUtxo]);

    const result = await submitGovAction({ ...baseOpts, network: 'preprod' });

    expect(result).toEqual({ txHash: 'deadbeef' });
    expect(propose).toHaveBeenCalledTimes(1);
    const proposeArg = propose.mock.calls[0][0] as { governanceAction: { _tag: string } };
    expect(proposeArg.governanceAction._tag).toBe('InfoAction');
  });
});

/** A recording builder whose every op returns itself, wired in as makeClient's newTx. */
function fakeBuilder() {
  const builder = {
    propose: vi.fn().mockReturnThis(),
    attachScript: vi.fn().mockReturnThis(),
    attachMetadata: vi.fn().mockReturnThis(),
    collectFrom: vi.fn().mockReturnThis(),
    build: vi.fn().mockResolvedValue('built-tx'),
  };
  vi.mocked(makeClient).mockReturnValue({ newTx: () => builder } as never);
  vi.mocked(signAndSubmit).mockResolvedValue({ txHash: 'deadbeef' });
  vi.mocked(collectWalletUtxos).mockResolvedValue([{ assets: { lovelace: 1_000_000_000_000n } } as unknown as UTxO.UTxO]);
  return builder;
}

const RECIPIENT_HEX = `e0${'ab'.repeat(28)}`;
const treasury = (guardrail: GuardrailContext) => ({
  type: 'TreasuryWithdrawals' as const,
  withdrawals: [{ rewardAddressHex: RECIPIENT_HEX, lovelace: 1_000_000n }],
  guardrail,
});
const paramChange = (guardrail: GuardrailContext) => ({
  type: 'ParameterChange' as const,
  prev: null,
  values: { k: { n: 600n, d: 1n } },
  guardrail,
});
const KNOWN: GuardrailContext = { state: 'known', scriptHash: GUARDRAIL_SCRIPT_HASH_HEX };

describe('submitGovAction for a treasury withdrawal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('proposes with the guardrail redeemer, attaches the script and builds with the evaluator', async () => {
    const builder = fakeBuilder();
    await submitGovAction({ ...baseOpts, network: 'preprod', action: treasury(KNOWN) });

    const arg = builder.propose.mock.calls[0][0];
    expect(arg.governanceAction._tag).toBe('TreasuryWithdrawalsAction');
    expect(ScriptHash.toHex(arg.governanceAction.policyHash)).toBe(GUARDRAIL_SCRIPT_HASH_HEX);
    expect(arg.redeemer.index).toBe(0n);
    expect(arg.redeemer.fields).toEqual([]);
    expect(arg.label).toBe('guardrail');

    expect(builder.attachScript).toHaveBeenCalledTimes(1);
    const { script } = builder.attachScript.mock.calls[0][0];
    expect(ScriptHash.toHex(ScriptHash.fromScript(script))).toBe(GUARDRAIL_SCRIPT_HASH_HEX);

    expect(makeGuardrailEvaluator).toHaveBeenCalledWith('https://x');
    const evaluator = vi.mocked(makeGuardrailEvaluator).mock.results[0].value;
    expect(builder.build.mock.calls[0][0]).toEqual({ availableUtxos: expect.any(Array), evaluator });
  });

  it('proposes without redeemer, script or evaluator when the chain proves there is no guardrail', async () => {
    const builder = fakeBuilder();
    await submitGovAction({ ...baseOpts, network: 'preprod', action: treasury({ state: 'absent' }) });

    const arg = builder.propose.mock.calls[0][0];
    expect('redeemer' in arg).toBe(false);
    expect(arg.governanceAction.policyHash).toBeNull();
    expect(builder.attachScript).not.toHaveBeenCalled();
    expect(makeGuardrailEvaluator).not.toHaveBeenCalled();
    expect(builder.build.mock.calls[0][0]).not.toHaveProperty('evaluator');
  });

  it('refuses a guardrail hash it does not ship, before building or signing', async () => {
    const builder = fakeBuilder();
    await expect(
      submitGovAction({
        ...baseOpts,
        network: 'preprod',
        action: treasury({ state: 'known', scriptHash: 'ab'.repeat(28) }),
      }),
    ).rejects.toThrow(GUARDRAIL_CHANGED_MESSAGE);
    expect(builder.build).not.toHaveBeenCalled();
    expect(signAndSubmit).not.toHaveBeenCalled();
  });

  // The switch is ON for mainnet in both tests below, so the control proves
  // an info action gets through and only the treasury rule can refuse the
  // other: deleting the TreasuryWithdrawals line in govActionTypeAvailable
  // makes the first test fail.
  it('refuses a treasury withdrawal on mainnet even with submission switched on there', async () => {
    const actual = await vi.importActual<typeof import('./submissionGate.js')>('./submissionGate.js');
    const gate = vi.mocked(govActionSubmissionAvailable);
    gate.mockReturnValue(true);
    try {
      fakeBuilder();
      await expect(submitGovAction({ ...baseOpts, network: 'mainnet', action: treasury(KNOWN) })).rejects.toThrow(
        /^Treasury withdrawals are preprod only\.$/,
      );
      expect(makeClient).not.toHaveBeenCalled();
    } finally {
      gate.mockImplementation(actual.govActionSubmissionAvailable);
    }
  });

  it('refuses a parameter change on mainnet even with submission switched on there', async () => {
    const actual = await vi.importActual<typeof import('./submissionGate.js')>('./submissionGate.js');
    const gate = vi.mocked(govActionSubmissionAvailable);
    gate.mockReturnValue(true);
    try {
      fakeBuilder();
      await expect(submitGovAction({ ...baseOpts, network: 'mainnet', action: paramChange(KNOWN) })).rejects.toThrow(
        /^Parameter changes are preprod only\.$/,
      );
      expect(makeClient).not.toHaveBeenCalled();
    } finally {
      gate.mockImplementation(actual.govActionSubmissionAvailable);
    }
  });

  it('proposes a parameter change with the guardrail redeemer, script and evaluator', async () => {
    const builder = fakeBuilder();
    await submitGovAction({ ...baseOpts, network: 'preprod', action: paramChange(KNOWN) });

    const arg = builder.propose.mock.calls[0][0];
    expect(arg.governanceAction._tag).toBe('ParameterChangeAction');
    expect(ScriptHash.toHex(arg.governanceAction.policyHash)).toBe(GUARDRAIL_SCRIPT_HASH_HEX);
    expect(arg.label).toBe('guardrail');
    expect(builder.attachScript).toHaveBeenCalledTimes(1);
    expect(makeGuardrailEvaluator).toHaveBeenCalledWith('https://x');
  });

  it('lets an info action through on mainnet with submission switched on there', async () => {
    const actual = await vi.importActual<typeof import('./submissionGate.js')>('./submissionGate.js');
    const gate = vi.mocked(govActionSubmissionAvailable);
    gate.mockReturnValue(true);
    try {
      const builder = fakeBuilder();
      await submitGovAction({ ...baseOpts, network: 'mainnet' });
      expect(makeClient).toHaveBeenCalledWith('mainnet', 'https://x', baseOpts.walletApi);
      expect(builder.build).toHaveBeenCalledTimes(1);
    } finally {
      gate.mockImplementation(actual.govActionSubmissionAvailable);
    }
  });

  it('builds every other type without an evaluator', async () => {
    const builder = fakeBuilder();
    await submitGovAction({ ...baseOpts, network: 'preprod' });
    expect(builder.attachScript).not.toHaveBeenCalled();
    expect(builder.build.mock.calls[0][0]).not.toHaveProperty('evaluator');
  });
});

describe('queueGuardrailProposeOps', () => {
  it('chains propose and attachScript and returns the builder', () => {
    const builder = fakeBuilder();
    const action = buildGovernanceAction(treasury(KNOWN));
    const out = queueGuardrailProposeOps(builder as unknown as GovActionTxBuilder, {
      action,
      rewardAccount: {} as never,
      anchor: {} as never,
      guardrail: KNOWN,
    });
    expect(out).toBe(builder);
    expect(builder.propose).toHaveBeenCalledTimes(1);
    expect(builder.attachScript).toHaveBeenCalledTimes(1);
  });
});
