// Unit tests for the mainnet guard, the funding-shortfall message, and the
// propose-op wiring in govActionTx.ts. collectWalletUtxos and makeClient are
// mocked so these run offline; a live wallet and Koios provider are needed
// for the full build/sign/submit path, which is not covered here.

import { describe, it, expect, vi } from 'vitest';

vi.mock('./walletUtxos.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./walletUtxos.js')>();
  return { ...actual, collectWalletUtxos: vi.fn() };
});

vi.mock('./drepTx.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./drepTx.js')>();
  return { ...actual, makeClient: vi.fn(), signAndSubmit: vi.fn() };
});

import { submitGovAction } from './govActionTx.js';
import { collectWalletUtxos } from './walletUtxos.js';
import { makeClient, signAndSubmit } from './drepTx.js';

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
