// Pure rules for the treasury withdrawal panel on /ga/new: a recipient row is
// a stake address plus an amount in ada. One parser serves the panel, the
// reducer's validator, the preview and the parts builder, so the address a
// row shows, the key it is deduplicated under and the reward account that
// goes on chain all come from the same place. Leaf module: bech32 and hex
// helpers only, safe for the client bundle.
import { decodeBech32, encodeBech32 } from '../crypto/bech32.js';
import { bytesToHex } from '../crypto/hex.js';
import { lovelaceToAdaDecimal } from '../format/ada.js';
import { resolveNetwork, type CardanoNetwork, type NetworkConfig } from '../config/network.js';

/** The most recipients one action may list. */
export const TREASURY_RECIPIENTS_MAX = 20;

// The total ada supply in lovelace. No withdrawal can exceed it, and it keeps
// every amount far inside the ledger's uint64 coin range.
const MAX_LOVELACE = 45_000_000_000_000_000n;

export const STAKE_ADDRESS_MISSING = "Enter the recipient's stake address.";
export const STAKE_ADDRESS_INVALID = 'This is not a valid stake address.';
export const STAKE_ADDRESS_WRONG_NETWORK = 'This stake address belongs to a different network.';
export const STAKE_ADDRESS_DUPLICATE = 'This stake address is already listed.';
export const AMOUNT_INVALID = 'Enter an amount above 0 with at most 6 decimals.';
export const TREASURY_NO_RECIPIENTS = 'Add at least one recipient.';
export const TREASURY_TOO_MANY = 'A treasury withdrawal can list at most 20 recipients.';
export const RECIPIENT_UNREGISTERED =
  'This stake address is not registered. The ledger rejects withdrawals to unregistered addresses.';
export const RECIPIENTS_CHECKING = 'Checking whether the stake addresses are registered.';
export const RECIPIENTS_CHECK_FAILED = 'Could not check whether the stake addresses are registered.';
export const RECIPIENTS_CHECK_FAILED_AT_SUBMIT =
  'Could not check whether the stake addresses are registered. Nothing was published or signed. Try again.';

export interface StakeAddressParts {
  /** Lowercase bech32, the normalized form rows are compared and deduplicated by. */
  stakeAddress: string;
  /** The 29-byte reward address (header plus credential) as lowercase hex. */
  rewardAddressHex: string;
  credential: { kind: 'key' | 'script'; hashHex: string };
}

export type StakeAddressResult = { ok: true; value: StakeAddressParts } | { ok: false; error: string };

// Every network a stake address prefix can name, so an address for the other
// network is told apart from one that is not a stake address at all.
const STAKE_NETWORKS: readonly NetworkConfig[] = [resolveNetwork('mainnet'), resolveNetwork('preprod')];

/**
 * A reward account in bech32: checksum, a `stake` or `stake_test` prefix, 29
 * bytes, a header whose high nibble is 0xe (key credential) or 0xf (script
 * credential), and a network nibble that agrees with the prefix and with the
 * instance's network. An all-uppercase string is fine (bech32 allows it), a
 * mixed-case one is not.
 */
export function parseStakeAddress(input: string, network: CardanoNetwork): StakeAddressResult {
  let decoded: { prefix: string; data: Uint8Array };
  try {
    decoded = decodeBech32(input.trim());
  } catch {
    return { ok: false, error: STAKE_ADDRESS_INVALID };
  }
  const { prefix, data } = decoded;
  const prefixNetwork = STAKE_NETWORKS.find((cfg) => cfg.stakePrefix === prefix);
  if (!prefixNetwork || data.length !== 29) return { ok: false, error: STAKE_ADDRESS_INVALID };
  const kindNibble = data[0] >> 4;
  if (kindNibble !== 0xe && kindNibble !== 0xf) return { ok: false, error: STAKE_ADDRESS_INVALID };
  if ((data[0] & 0x0f) !== prefixNetwork.networkId) return { ok: false, error: STAKE_ADDRESS_INVALID };
  if (prefixNetwork.network !== network) return { ok: false, error: STAKE_ADDRESS_WRONG_NETWORK };
  const rewardAddressHex = bytesToHex(data);
  return {
    ok: true,
    value: {
      stakeAddress: encodeBech32(prefix, data),
      rewardAddressHex,
      credential: { kind: kindNibble === 0xe ? 'key' : 'script', hashHex: rewardAddressHex.slice(2) },
    },
  };
}

/** An ada amount above 0 with at most 6 decimals, as lovelace, or null. No separators, no exponent. */
export function parseAdaAmount(input: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(input.trim());
  if (!match) return null;
  const lovelace = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
  if (lovelace <= 0n || lovelace > MAX_LOVELACE) return null;
  return lovelace;
}

/** Lovelace as ada with every significant decimal kept and the whole part grouped. */
export function formatLovelaceExact(lovelace: bigint): string {
  const [whole, fraction] = lovelaceToAdaDecimal(lovelace).split('.');
  const grouped = BigInt(whole).toLocaleString('en-US');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

/**
 * An amount for the submission preview: exact to the lovelace, from bigint,
 * with the " tADA" suffix, since treasury withdrawals are preprod only. The
 * action page itself formats through formatAda, which rounds to whole ada.
 * That stays as it is here (out of scope, a follow-up), but the preview the
 * user signs from must show what the transaction carries.
 */
export function formatTreasuryAda(lovelace: bigint): string {
  return `${formatLovelaceExact(lovelace)} tADA`;
}

/** One recipient row as typed. */
export interface TreasuryRowInput {
  address: string;
  amountAda: string;
}

/** The blank row a fresh panel shows, and what the last removed row leaves behind. */
export const EMPTY_TREASURY_ROW: TreasuryRowInput = { address: '', amountAda: '' };

/**
 * Puts an address into the first empty row, else appends a row. Returns the
 * rows unchanged when the address is already listed (any case) or there is no
 * room, so callers can compare references to see whether anything happened.
 */
export function withAddressAdded(rows: TreasuryRowInput[], address: string): TreasuryRowInput[] {
  const wanted = address.trim().toLowerCase();
  if (wanted === '' || rows.some((row) => row.address.trim().toLowerCase() === wanted)) return rows;
  const empty = rows.findIndex((row) => row.address.trim() === '');
  if (empty !== -1) return rows.map((row, i) => (i === empty ? { ...row, address } : row));
  if (rows.length >= TREASURY_RECIPIENTS_MAX) return rows;
  return [...rows, { address, amountAda: '' }];
}

/** True for a panel that holds nothing but one blank row, which is how a fresh form starts. */
export function isEmptyTreasuryPanel(panel: { rows: readonly TreasuryRowInput[] }): boolean {
  return panel.rows.length === 1 && panel.rows[0].address === '' && panel.rows[0].amountAda === '';
}

/** One row after parsing: the usable parts, and a message for each field that is not usable. */
export interface TreasuryRowCheck {
  address: StakeAddressParts | null;
  lovelace: bigint | null;
  addressError: string | null;
  amountError: string | null;
}

export interface TreasuryWithdrawalRow {
  recipient: StakeAddressParts;
  lovelace: bigint;
}

export type TreasuryRowsResult = { rows: TreasuryRowCheck[]; totalLovelace: bigint } & (
  | { ok: true; withdrawals: TreasuryWithdrawalRow[] }
  | { ok: false; error: string }
);

/**
 * Every row parsed, the second and later rows for one normalized address
 * flagged as duplicates (the ledger type is a map, one entry per address),
 * the total over every amount that parsed, and either the withdrawals or the
 * first message to show.
 */
export function checkTreasuryRows(rows: readonly TreasuryRowInput[], network: CardanoNetwork): TreasuryRowsResult {
  const seen = new Set<string>();
  let totalLovelace = 0n;
  const withdrawals: TreasuryWithdrawalRow[] = [];
  const checked: TreasuryRowCheck[] = rows.map((row) => {
    let address: StakeAddressParts | null = null;
    let addressError: string | null = null;
    if (!row.address.trim()) {
      addressError = STAKE_ADDRESS_MISSING;
    } else {
      const parsed = parseStakeAddress(row.address, network);
      if (!parsed.ok) addressError = parsed.error;
      else if (seen.has(parsed.value.stakeAddress)) addressError = STAKE_ADDRESS_DUPLICATE;
      else {
        seen.add(parsed.value.stakeAddress);
        address = parsed.value;
      }
    }
    const lovelace = parseAdaAmount(row.amountAda);
    if (lovelace !== null) totalLovelace += lovelace;
    const amountError = lovelace === null ? AMOUNT_INVALID : null;
    if (address && lovelace !== null) withdrawals.push({ recipient: address, lovelace });
    return { address, lovelace, addressError, amountError };
  });

  if (rows.length === 0) return { rows: checked, totalLovelace, ok: false, error: TREASURY_NO_RECIPIENTS };
  if (rows.length > TREASURY_RECIPIENTS_MAX) return { rows: checked, totalLovelace, ok: false, error: TREASURY_TOO_MANY };
  const firstError = checked.map((row) => row.addressError ?? row.amountError).find((error) => error !== null);
  if (firstError) return { rows: checked, totalLovelace, ok: false, error: firstError };
  return { rows: checked, totalLovelace, ok: true, withdrawals };
}
