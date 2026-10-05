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
    ...patch,
  };
}

function keys(input: ReadinessInput): string[] {
  return readinessReasons(input).map(r => r.key);
}

function messageFor(input: ReadinessInput, key: string): string | undefined {
  return readinessReasons(input).find(r => r.key === key)?.message;
}

describe('readinessReasons', () => {
  it('is empty when everything is in place', () => {
    expect(readinessReasons(ready())).toEqual([]);
  });

  it('waits for the chain context on a chained type', () => {
    for (const status of ['idle', 'loading', 'error'] as const) {
      const input = ready({ type: 'UpdateCommittee', contextStatus: status });
      expect(messageFor(input, 'context')).toBe('Waiting for the chain context');
    }
    expect(keys(ready({ type: 'UpdateCommittee', contextStatus: 'ready' }))).toEqual([]);
  });

  it('never waits for a context on an info action, which loads none', () => {
    expect(keys(ready({ type: 'InfoAction', contextStatus: 'idle' }))).toEqual([]);
  });

  it('names the panel by its type when the panel does not validate', () => {
    expect(
      messageFor(
        ready({
          type: 'UpdateCommittee',
          contextStatus: 'ready',
          panelValidation: { ok: false, error: 'quorum numerator must be a whole number' },
        }),
        'panel',
      ),
    ).toBe('Fix the committee changes above');
    expect(
      messageFor(
        ready({
          type: 'HardForkInitiation',
          contextStatus: 'ready',
          panelValidation: { ok: false, error: 'Choose the protocol version to propose.' },
        }),
        'panel',
      ),
    ).toBe('Fix the hard fork changes above');
    expect(
      messageFor(
        ready({
          type: 'NewConstitution',
          contextStatus: 'ready',
          panelValidation: { ok: false, error: 'Enter the constitution text.' },
        }),
        'panel',
      ),
    ).toBe('Fix the constitution changes above');
  });

  it('says nothing about a panel that validates', () => {
    expect(
      keys(ready({ type: 'NoConfidence', contextStatus: 'ready', panelValidation: { ok: true, error: '' } })),
    ).toEqual([]);
  });

  it('asks for the metadata fields', () => {
    expect(messageFor(ready({ metadataComplete: false }), 'metadata')).toBe(
      'Fill in title, abstract, motivation and rationale',
    );
  });

  it('asks for an author name or the toggle', () => {
    expect(messageFor(ready({ authorOk: false }), 'author')).toBe(
      'Name the author or turn off signing as author',
    );
  });

  it('asks for a survey reference it can parse', () => {
    expect(messageFor(ready({ surveyRefOk: false }), 'surveyRef')).toBe('Fix the survey reference');
  });

  it('asks for one Proposal Draft reference when several point at a draft', () => {
    expect(messageFor(ready({ draftConflict: true }), 'draftConflict')).toBe(
      'Keep one Proposal Draft reference',
    );
  });

  it('waits for the deposit while it is unknown', () => {
    expect(messageFor(ready({ depositLovelace: null }), 'deposit')).toBe('Waiting for the current deposit');
  });

  it('asks for a wallet while none is connected, including mid-connect', () => {
    expect(messageFor(ready({ wallet: { status: 'none' } }), 'wallet')).toBe('Connect a wallet');
    expect(messageFor(ready({ wallet: { status: 'connecting' } }), 'wallet')).toBe('Connect a wallet');
  });

  it('says nothing about the balance while no wallet is connected', () => {
    expect(keys(ready({ wallet: { status: 'none' } }))).toEqual(['wallet']);
  });

  it('reports the balance read and its failure', () => {
    expect(
      messageFor(
        ready({ wallet: { status: 'connected', rewardAddressHex: 'e0ff', balance: { status: 'loading' } } }),
        'balanceLoading',
      ),
    ).toBe('Reading the wallet balance');
    expect(
      messageFor(
        ready({
          wallet: {
            status: 'connected',
            rewardAddressHex: 'e0ff',
            balance: { status: 'error', message: 'Koios said no' },
          },
        }),
        'balanceUnknown',
      ),
    ).toBe('Could not read the wallet balance, check again');
  });

  it('names both figures when the wallet is short', () => {
    const input = ready({
      wallet: {
        status: 'connected',
        rewardAddressHex: 'e0ff',
        balance: { status: 'ready', lovelace: 812_000_000n },
      },
    });
    expect(messageFor(input, 'balance')).toBe(
      'The wallet holds 812 tADA, the deposit plus a 5 tADA fee reserve needs 1,005',
    );
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
