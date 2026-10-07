// Unit tests for the treasury recipient rules: stake address parsing with
// checksum, header and network checks, the normalized duplicate check, the
// ada amount parser and the row checker the panel, the reducer and the
// preview all go through.
import { describe, it, expect } from 'vitest';
import { encodeBech32 } from '../crypto/bech32.js';
import { hexToBytes } from '../crypto/hex.js';
import {
  AMOUNT_INVALID,
  RECIPIENT_UNREGISTERED,
  STAKE_ADDRESS_DUPLICATE,
  STAKE_ADDRESS_INVALID,
  STAKE_ADDRESS_MISSING,
  STAKE_ADDRESS_WRONG_NETWORK,
  TREASURY_NO_RECIPIENTS,
  TREASURY_RECIPIENTS_MAX,
  TREASURY_TOO_MANY,
  checkTreasuryRows,
  formatLovelaceExact,
  formatTreasuryAda,
  parseAdaAmount,
  parseStakeAddress,
} from './treasuryWithdrawals.js';

const KEY_HEX = `e0${'ab'.repeat(28)}`;
const SCRIPT_HEX = `f0${'cd'.repeat(28)}`;
const KEY_ADDR = encodeBech32('stake_test', hexToBytes(KEY_HEX));
const SCRIPT_ADDR = encodeBech32('stake_test', hexToBytes(SCRIPT_HEX));
const MAINNET_ADDR = encodeBech32('stake', hexToBytes(`e1${'ab'.repeat(28)}`));
// A real preprod stake address, the fixture stakeAccount.test.ts uses too.
const REAL_ADDR = 'stake_test1uqpqhw7q2jcutnwteqnvdgqkjulnaa5ym8wh70kcu3yvkugckkcgj';

function withBadChecksum(address: string): string {
  return `${address.slice(0, -1)}${address.endsWith('q') ? 'p' : 'q'}`;
}

describe('parseStakeAddress', () => {
  it('accepts a key-credential stake address', () => {
    expect(parseStakeAddress(KEY_ADDR, 'preprod')).toEqual({
      ok: true,
      value: { stakeAddress: KEY_ADDR, rewardAddressHex: KEY_HEX, credential: { kind: 'key', hashHex: 'ab'.repeat(28) } },
    });
  });

  it('accepts a script-credential stake address', () => {
    expect(parseStakeAddress(SCRIPT_ADDR, 'preprod')).toEqual({
      ok: true,
      value: { stakeAddress: SCRIPT_ADDR, rewardAddressHex: SCRIPT_HEX, credential: { kind: 'script', hashHex: 'cd'.repeat(28) } },
    });
  });

  it('accepts a real preprod address', () => {
    expect(parseStakeAddress(REAL_ADDR, 'preprod').ok).toBe(true);
  });

  it('normalizes surrounding space and an all-uppercase address to lowercase', () => {
    const result = parseStakeAddress(`  ${KEY_ADDR.toUpperCase()}\n`, 'preprod');
    expect(result.ok && result.value.stakeAddress).toBe(KEY_ADDR);
  });

  it('rejects a mixed-case address, which bech32 forbids', () => {
    const mixed = `${KEY_ADDR.slice(0, 14)}${KEY_ADDR.slice(14).toUpperCase()}`;
    expect(parseStakeAddress(mixed, 'preprod')).toEqual({ ok: false, error: STAKE_ADDRESS_INVALID });
  });

  it('rejects a bad checksum', () => {
    expect(parseStakeAddress(withBadChecksum(KEY_ADDR), 'preprod')).toEqual({ ok: false, error: STAKE_ADDRESS_INVALID });
  });

  it('rejects other prefixes, a payment address included', () => {
    const payment = encodeBech32('addr_test', hexToBytes(`00${'ab'.repeat(56)}`));
    const drep = encodeBech32('drep', hexToBytes('ab'.repeat(28)));
    expect(parseStakeAddress(payment, 'preprod')).toEqual({ ok: false, error: STAKE_ADDRESS_INVALID });
    expect(parseStakeAddress(drep, 'preprod')).toEqual({ ok: false, error: STAKE_ADDRESS_INVALID });
  });

  it('rejects a wrong length and a header that is no reward address', () => {
    expect(parseStakeAddress(encodeBech32('stake_test', hexToBytes(`e0${'ab'.repeat(27)}`)), 'preprod')).toEqual({
      ok: false,
      error: STAKE_ADDRESS_INVALID,
    });
    expect(parseStakeAddress(encodeBech32('stake_test', hexToBytes(`00${'ab'.repeat(28)}`)), 'preprod')).toEqual({
      ok: false,
      error: STAKE_ADDRESS_INVALID,
    });
  });

  it('rejects a prefix and a network nibble that disagree', () => {
    const disagreeing = encodeBech32('stake_test', hexToBytes(`e1${'ab'.repeat(28)}`));
    expect(parseStakeAddress(disagreeing, 'preprod')).toEqual({ ok: false, error: STAKE_ADDRESS_INVALID });
  });

  it('rejects an address of the other network', () => {
    expect(parseStakeAddress(MAINNET_ADDR, 'preprod')).toEqual({ ok: false, error: STAKE_ADDRESS_WRONG_NETWORK });
    expect(parseStakeAddress(KEY_ADDR, 'mainnet')).toEqual({ ok: false, error: STAKE_ADDRESS_WRONG_NETWORK });
  });

  it('rejects an empty or garbage input', () => {
    expect(parseStakeAddress('', 'preprod')).toEqual({ ok: false, error: STAKE_ADDRESS_INVALID });
    expect(parseStakeAddress('hello', 'preprod')).toEqual({ ok: false, error: STAKE_ADDRESS_INVALID });
  });
});

describe('parseAdaAmount', () => {
  it('converts whole and fractional ada to lovelace', () => {
    expect(parseAdaAmount('1')).toBe(1_000_000n);
    expect(parseAdaAmount('0.000001')).toBe(1n);
    expect(parseAdaAmount('12.5')).toBe(12_500_000n);
    expect(parseAdaAmount(' 3 ')).toBe(3_000_000n);
  });

  it('rejects zero, negatives, more than 6 decimals, separators and junk', () => {
    for (const bad of ['0', '0.0', '-1', '1.1234567', '1,000', '1e6', '', '.5', '1.', 'abc', '1 000']) {
      expect(parseAdaAmount(bad)).toBeNull();
    }
  });

  it('caps at the total ada supply', () => {
    expect(parseAdaAmount('45000000000')).toBe(45_000_000_000_000_000n);
    expect(parseAdaAmount('45000000000.000001')).toBeNull();
  });
});

describe('formatLovelaceExact and formatTreasuryAda', () => {
  it('keeps every significant decimal and groups the whole part', () => {
    expect(formatLovelaceExact(0n)).toBe('0');
    expect(formatLovelaceExact(1n)).toBe('0.000001');
    expect(formatLovelaceExact(1_500_000n)).toBe('1.5');
    expect(formatLovelaceExact(1_234_000_000_001n)).toBe('1,234,000.000001');
  });

  it('stays exact above the 2^53 range a Number would round', () => {
    expect(formatLovelaceExact(9_007_199_254_740_993n)).toBe('9,007,199,254.740993');
  });

  it('adds the tADA suffix', () => {
    expect(formatTreasuryAda(2_500_000n)).toBe('2.5 tADA');
    expect(formatTreasuryAda(1n)).toBe('0.000001 tADA');
    expect(formatTreasuryAda(9_007_199_254_740_993n)).toBe('9,007,199,254.740993 tADA');
  });
});

describe('checkTreasuryRows', () => {
  it('returns one withdrawal per row and the exact total', () => {
    const result = checkTreasuryRows(
      [
        { address: KEY_ADDR, amountAda: '1' },
        { address: SCRIPT_ADDR, amountAda: '2.5' },
      ],
      'preprod',
    );
    expect(result.ok).toBe(true);
    expect(result.totalLovelace).toBe(3_500_000n);
    if (!result.ok) throw new Error('unreachable');
    expect(result.withdrawals.map((w) => [w.recipient.stakeAddress, w.lovelace])).toEqual([
      [KEY_ADDR, 1_000_000n],
      [SCRIPT_ADDR, 2_500_000n],
    ]);
  });

  it('flags a second row for the same address, also when typed in uppercase', () => {
    const result = checkTreasuryRows(
      [
        { address: KEY_ADDR, amountAda: '1' },
        { address: ` ${KEY_ADDR.toUpperCase()}`, amountAda: '2' },
      ],
      'preprod',
    );
    expect(result.rows[1].addressError).toBe(STAKE_ADDRESS_DUPLICATE);
    expect(result).toMatchObject({ ok: false, error: STAKE_ADDRESS_DUPLICATE });
  });

  it('reports a missing address and an invalid amount per row, first error first', () => {
    const result = checkTreasuryRows(
      [
        { address: KEY_ADDR, amountAda: 'x' },
        { address: '  ', amountAda: '1' },
      ],
      'preprod',
    );
    expect(result.rows[0]).toMatchObject({ addressError: null, amountError: AMOUNT_INVALID, lovelace: null });
    expect(result.rows[1]).toMatchObject({ addressError: STAKE_ADDRESS_MISSING, address: null, lovelace: 1_000_000n });
    expect(result).toMatchObject({ ok: false, error: AMOUNT_INVALID });
  });

  it('needs at least one row and at most twenty', () => {
    expect(checkTreasuryRows([], 'preprod')).toMatchObject({ ok: false, error: TREASURY_NO_RECIPIENTS });
    const tooMany = Array.from({ length: TREASURY_RECIPIENTS_MAX + 1 }, (_, i) => ({
      address: encodeBech32('stake_test', hexToBytes(`e0${i.toString(16).padStart(2, '0').repeat(28)}`)),
      amountAda: '1',
    }));
    expect(checkTreasuryRows(tooMany, 'preprod')).toMatchObject({ ok: false, error: TREASURY_TOO_MANY });
  });

  it('uses the spec sentence for an unregistered recipient', () => {
    expect(RECIPIENT_UNREGISTERED).toBe(
      'This stake address is not registered. The ledger rejects withdrawals to unregistered addresses.',
    );
  });
});
