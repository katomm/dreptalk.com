import { describe, it, expect } from 'vitest';
import { readinessReasons, type ReadinessInput } from './readiness.js';
import { FUNDING_HEADROOM_LOVELACE } from './walletUtxos.js';

const DEPOSIT = 1_000_000_000n;
const ENOUGH = DEPOSIT + FUNDING_HEADROOM_LOVELACE;

/** A ready InfoAction with a funded wallet: every other case is this one, spoiled. */
function ready(patch: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    type: 'InfoAction',
    contextStatus: 'idle',
    panelValidation: null,
    metadataComplete: true,
    authorOk: true,
    surveyRefOk: true,
    draftConflict: false,
    wallet: { status: 'connected', rewardAddressHex: 'e0ff', balance: { status: 'ready', lovelace: ENOUGH } },
    depositLovelace: DEPOSIT,
    network: 'preprod',
    ...patch,
  };
}

function keys(input: ReadinessInput): string[] {
  return readinessReasons(input).map(r => r.key);
}

describe('readinessReasons', () => {
  it('is empty when everything is in place', () => {
    expect(readinessReasons(ready())).toEqual([]);
  });

  it('waits for the chain context on a chained type, a treasury withdrawal included', () => {
    for (const status of ['idle', 'loading', 'error'] as const) {
      expect(keys(ready({ type: 'UpdateCommittee', contextStatus: status }))).toEqual(['context']);
    }
    expect(keys(ready({ type: 'TreasuryWithdrawals', contextStatus: 'loading' }))).toEqual(['context']);
    expect(keys(ready({ type: 'UpdateCommittee', contextStatus: 'ready' }))).toEqual([]);
  });

  it('never waits for a context on an info action, which loads none', () => {
    expect(keys(ready({ type: 'InfoAction', contextStatus: 'idle' }))).toEqual([]);
  });

  it('flags a panel that does not validate, and only that one', () => {
    const invalid = ready({ type: 'UpdateCommittee', contextStatus: 'ready', panelValidation: { ok: false, error: 'x' } });
    expect(keys(invalid)).toEqual(['panel']);
    expect(
      keys(ready({ type: 'NoConfidence', contextStatus: 'ready', panelValidation: { ok: true, error: '' } })),
    ).toEqual([]);
  });

  // One failing input per case, so a swapped predicate shows up as the wrong key.
  it.each([
    [{ metadataComplete: false }, 'metadata'],
    [{ authorOk: false }, 'author'],
    [{ surveyRefOk: false }, 'surveyRef'],
    [{ draftConflict: true }, 'draftConflict'],
    [{ wallet: { status: 'none' } }, 'wallet'],
    [{ wallet: { status: 'connecting' } }, 'wallet'],
    [{ wallet: { status: 'connected', rewardAddressHex: 'e0ff', balance: { status: 'loading' } } }, 'balanceLoading'],
    [{ wallet: { status: 'connected', rewardAddressHex: 'e0ff', balance: { status: 'error', message: 'Koios said no' } } }, 'balanceUnknown'],
  ] as [Partial<ReadinessInput>, string][])('raises only %j as %s', (patch, key) => {
    expect(keys(ready(patch))).toEqual([key]);
  });

  it('names both figures when the wallet is short', () => {
    const input = ready({
      wallet: {
        status: 'connected',
        rewardAddressHex: 'e0ff',
        balance: { status: 'ready', lovelace: 812_000_000n },
      },
    });
    const message = readinessReasons(input).find(r => r.key === 'balance')?.message;
    expect(message).toContain('812 tADA');
    expect(message).toContain('1,005');
  });

  it('is ready at exactly the deposit plus the reserve, and not one lovelace less', () => {
    const at = ready({
      wallet: { status: 'connected', rewardAddressHex: 'e0ff', balance: { status: 'ready', lovelace: ENOUGH } },
    });
    expect(keys(at)).toEqual([]);
    const short = ready({
      wallet: {
        status: 'connected',
        rewardAddressHex: 'e0ff',
        balance: { status: 'ready', lovelace: ENOUGH - 1n },
      },
    });
    expect(keys(short)).toEqual(['balance']);
  });

  it('stops on a refund address the ledger would refuse, and only on a confirmed one', () => {
    const wallet = (rewardRegistered?: boolean) =>
      ready({
        wallet: {
          status: 'connected',
          rewardAddressHex: 'e0ff',
          balance: { status: 'ready', lovelace: ENOUGH, rewardRegistered },
        },
      });
    expect(keys(wallet(false))).toEqual(['rewardUnregistered']);
    expect(keys(wallet(true))).toEqual([]);
    // A failed lookup leaves the question to the ledger.
    expect(keys(wallet(undefined))).toEqual([]);
  });

  it('does not compare a balance against a deposit it does not know yet', () => {
    const input = ready({ depositLovelace: null });
    expect(keys(input)).toEqual(['deposit']);
  });

  it('lists every reason at once, form first and wallet last', () => {
    const input = ready({
      type: 'UpdateCommittee',
      contextStatus: 'loading',
      panelValidation: { ok: false, error: 'nope' },
      metadataComplete: false,
      authorOk: false,
      surveyRefOk: false,
      draftConflict: true,
      depositLovelace: null,
      wallet: { status: 'none' },
    });
    expect(keys(input)).toEqual([
      'context',
      'panel',
      'metadata',
      'author',
      'surveyRef',
      'draftConflict',
      'deposit',
      'wallet',
    ]);
  });
});
