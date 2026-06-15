// Pure decoder for a governance action's on-chain payload (Koios proposal_description).
// Turns the raw JSON + current epoch params into a display-ready view model.
// No I/O, no DOM; the Astro component renders the result.

import { formatAda } from './view.js';
import { rewardAddressToStakeBech32 } from './stakeAccount.js';
import type { CardanoNetwork } from '../config/network.js';

export type Fmt = 'lovelace' | 'ratio' | 'int' | 'bytes' | 'exUnits' | 'costModels';

export interface ParamMeta {
  snake: string;
  group: string;
  label: string;
  format: Fmt;
}

// camelCase ledger param name → display metadata + the snake_case epoch_params key
// used for old→new. snake '' means "no comparable scalar in epoch_params" (new only).
// All keys here were observed in real preprod/mainnet payloads or are standard
// Conway-updatable parameters; unknown keys fall back to a humanized label.
export const PARAM_REGISTRY: Record<string, ParamMeta> = {
  govActionDeposit: { snake: 'gov_action_deposit', group: 'Governance', label: 'Governance Action Deposit', format: 'lovelace' },
  dRepDeposit: { snake: 'drep_deposit', group: 'Governance', label: 'DRep Deposit', format: 'lovelace' },
  committeeMinSize: { snake: 'committee_min_size', group: 'Governance', label: 'Committee Min Size', format: 'int' },
  committeeMaxTermLength: { snake: 'committee_max_term_length', group: 'Governance', label: 'Committee Max Term Length', format: 'int' },
  govActionLifetime: { snake: 'gov_action_lifetime', group: 'Governance', label: 'Governance Action Lifetime', format: 'int' },
  dRepActivity: { snake: 'drep_activity', group: 'Governance', label: 'DRep Activity', format: 'int' },
  treasuryCut: { snake: 'treasury_growth_rate', group: 'Economic', label: 'Treasury Cut', format: 'ratio' },
  monetaryExpansion: { snake: 'monetary_expand_rate', group: 'Economic', label: 'Monetary Expansion', format: 'ratio' },
  minFeeA: { snake: 'min_fee_a', group: 'Economic', label: 'Min Fee Coefficient (a)', format: 'int' },
  minFeeB: { snake: 'min_fee_b', group: 'Economic', label: 'Min Fee Constant (b)', format: 'lovelace' },
  minFeeRefScriptCostPerByte: { snake: 'min_fee_ref_script_cost_per_byte', group: 'Economic', label: 'Ref Script Cost per Byte', format: 'lovelace' },
  minPoolCost: { snake: 'min_pool_cost', group: 'Economic', label: 'Min Pool Cost', format: 'lovelace' },
  keyDeposit: { snake: 'key_deposit', group: 'Economic', label: 'Key Deposit', format: 'lovelace' },
  poolDeposit: { snake: 'pool_deposit', group: 'Economic', label: 'Pool Deposit', format: 'lovelace' },
  coinsPerUTxOByte: { snake: 'coins_per_utxo_size', group: 'Economic', label: 'Coins per UTxO Byte', format: 'lovelace' },
  maxBlockBodySize: { snake: 'max_block_size', group: 'Network', label: 'Max Block Body Size', format: 'bytes' },
  maxTxSize: { snake: 'max_tx_size', group: 'Network', label: 'Max Tx Size', format: 'bytes' },
  maxBlockHeaderSize: { snake: 'max_bh_size', group: 'Network', label: 'Max Block Header Size', format: 'bytes' },
  maxValueSize: { snake: 'max_val_size', group: 'Network', label: 'Max Value Size', format: 'bytes' },
  maxTxExecutionUnits: { snake: '', group: 'Technical', label: 'Max Tx Execution Units', format: 'exUnits' },
  maxBlockExecutionUnits: { snake: '', group: 'Technical', label: 'Max Block Execution Units', format: 'exUnits' },
  collateralPercentage: { snake: 'collateral_percent', group: 'Technical', label: 'Collateral Percentage', format: 'int' },
  maxCollateralInputs: { snake: 'max_collateral_inputs', group: 'Technical', label: 'Max Collateral Inputs', format: 'int' },
  costModels: { snake: 'cost_models', group: 'Technical', label: 'Cost Models', format: 'costModels' },
};

const groupNum = (v: number): string => v.toLocaleString('en-US');

function fmtRatio(v: unknown): string {
  let n: number | null = null;
  if (v && typeof v === 'object' && 'numerator' in v && 'denominator' in v) {
    const o = v as { numerator: number; denominator: number };
    n = o.denominator ? o.numerator / o.denominator : null;
  } else if (typeof v === 'number') {
    n = v;
  }
  if (n === null || Number.isNaN(n)) return String(v);
  return `${(n * 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

function fmtExUnits(v: unknown): string {
  if (v && typeof v === 'object') {
    const o = v as { memory?: number; steps?: number };
    if (o.memory != null || o.steps != null) {
      return `${groupNum(o.memory ?? 0)} mem / ${groupNum(o.steps ?? 0)} steps`;
    }
  }
  return String(v);
}

export function formatValue(fmt: Fmt, v: unknown): string {
  switch (fmt) {
    case 'lovelace':
      return formatAda(String(v)) ?? String(v);
    case 'ratio':
      return fmtRatio(v);
    case 'bytes':
      return typeof v === 'number' ? `${groupNum(v)} bytes` : String(v);
    case 'exUnits':
      return fmtExUnits(v);
    case 'costModels':
      return 'Updated';
    default:
      return typeof v === 'number' ? groupNum(v) : String(v);
  }
}

export function humanizeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

interface RewardAccount {
  credential?: { keyHash?: string; scriptHash?: string };
}

// Encodes a treasury-withdrawal recipient as a bech32 stake address. The network
// comes from app config, not the payload's "network" string (untrusted). Builds
// the 29-byte reward address (header + 28-byte hash) and reuses the stake encoder.
export function rewardAccountToBech32(acct: RewardAccount, network: CardanoNetwork): string {
  const cred = acct?.credential ?? {};
  const isScript = typeof cred.scriptHash === 'string';
  const hashHex = isScript ? cred.scriptHash : cred.keyHash;
  if (typeof hashHex !== 'string' || hashHex.length !== 56) return '(unknown recipient)';
  const header = (isScript ? 0xf0 : 0xe0) | (network === 'mainnet' ? 1 : 0);
  const headerHex = header.toString(16).padStart(2, '0');
  return rewardAddressToStakeBech32(headerHex + hashHex, network);
}

export interface ParamRow {
  group: string;
  label: string;
  oldValue: string | null;
  newValue: string;
}
export interface TreasuryRow {
  address: string;
  ada: string;
}
export interface CommitteeMember {
  who: string;
  termEpoch: number | null;
}

export type OnchainChanges =
  | { kind: 'params'; rows: ParamRow[] }
  | { kind: 'hardfork'; fromVersion: string | null; toVersion: string }
  | { kind: 'treasury'; rows: TreasuryRow[]; totalAda: string }
  | { kind: 'committee'; added: CommitteeMember[]; removed: string[]; threshold: string | null }
  | { kind: 'constitution'; anchorUrl: string | null; scriptHash: string | null }
  | { kind: 'note'; text: string };

function shortenHash(h: string): string {
  return h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

function labelMemberKey(raw: string): string {
  const dash = raw.indexOf('-');
  if (dash === -1) return shortenHash(raw);
  return `${raw.slice(0, dash)} ${shortenHash(raw.slice(dash + 1))}`;
}

function labelMemberObj(o: unknown): string {
  if (o && typeof o === 'object') {
    const c = o as { scriptHash?: string; keyHash?: string };
    if (typeof c.scriptHash === 'string') return `scriptHash ${shortenHash(c.scriptHash)}`;
    if (typeof c.keyHash === 'string') return `keyHash ${shortenHash(c.keyHash)}`;
  }
  return '(member)';
}

// Finds the first array element that is an object carrying `key`. Used to pull a
// payload field by shape rather than position, tolerant of an optional leading
// prev-action pointer.
function findObjByKey<T>(arr: unknown[], key: string): T | undefined {
  return arr.find((c) => c !== null && typeof c === 'object' && key in c) as T | undefined;
}

function decodeParams(contents: unknown[], ep: Record<string, unknown>): OnchainChanges {
  const map = contents[1];
  const rows: ParamRow[] = [];
  if (map && typeof map === 'object') {
    for (const [key, val] of Object.entries(map)) {
      const meta = PARAM_REGISTRY[key];
      if (meta) {
        const old = meta.snake ? ep[meta.snake] : undefined;
        rows.push({
          group: meta.group,
          label: meta.label,
          oldValue: old === undefined || old === null ? null : formatValue(meta.format, old),
          newValue: formatValue(meta.format, val),
        });
      } else {
        rows.push({
          group: 'Other',
          label: humanizeKey(key),
          oldValue: null,
          newValue: val !== null && typeof val === 'object' ? 'Updated' : String(val),
        });
      }
    }
  }
  return { kind: 'params', rows };
}

function decodeHardFork(contents: unknown[], ep: Record<string, unknown>): OnchainChanges {
  const ver = findObjByKey<{ major: number; minor?: number }>(contents, 'major');
  const toVersion = ver ? `${ver.major}.${ver.minor ?? 0}` : '';
  const maj = ep.protocol_major;
  const fromVersion =
    typeof maj === 'number' ? `${maj}.${typeof ep.protocol_minor === 'number' ? ep.protocol_minor : 0}` : null;
  return { kind: 'hardfork', fromVersion, toVersion };
}

function decodeTreasury(contents: unknown[], network: CardanoNetwork): OnchainChanges {
  const list = contents[0];
  const rows: TreasuryRow[] = [];
  let total = 0n;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (!Array.isArray(entry)) continue;
      const [acct, lovelace] = entry as [RewardAccount, number | string];
      const amt = typeof lovelace === 'number' ? BigInt(Math.trunc(lovelace)) : BigInt(Number(lovelace) || 0);
      total += amt;
      rows.push({ address: rewardAccountToBech32(acct, network), ada: formatAda(String(amt)) ?? `${amt}` });
    }
  }
  return { kind: 'treasury', rows, totalAda: formatAda(String(total)) ?? `${total}` };
}

function decodeCommittee(contents: unknown[]): OnchainChanges {
  const removedRaw = Array.isArray(contents[1]) ? (contents[1] as unknown[]) : [];
  const addedRaw = contents[2] && typeof contents[2] === 'object' ? (contents[2] as Record<string, unknown>) : {};
  const thrRaw =
    contents[3] && typeof contents[3] === 'object' && 'numerator' in (contents[3] as object) ? contents[3] : null;
  const added: CommitteeMember[] = Object.entries(addedRaw).map(([who, epoch]) => ({
    who: labelMemberKey(who),
    termEpoch: typeof epoch === 'number' ? epoch : null,
  }));
  const removed = removedRaw.map(labelMemberObj);
  return { kind: 'committee', added, removed, threshold: thrRaw ? fmtRatio(thrRaw) : null };
}

function decodeConstitution(contents: unknown[]): OnchainChanges {
  const body = findObjByKey<{ anchor?: { url?: string }; script?: string }>(contents, 'anchor');
  return {
    kind: 'constitution',
    anchorUrl: body?.anchor?.url ?? null,
    scriptHash: typeof body?.script === 'string' ? body.script : null,
  };
}

// Total: never throws on an unexpected shape; returns null instead.
export function decodeOnchainChanges(
  payloadJson: string | null,
  epochParamsJson: string | null,
  network: CardanoNetwork,
): OnchainChanges | null {
  if (!payloadJson) return null;
  let payload: { tag?: string; contents?: unknown[] };
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  let ep: Record<string, unknown> = {};
  if (epochParamsJson) {
    try {
      ep = (JSON.parse(epochParamsJson) as Record<string, unknown>) ?? {};
    } catch {
      ep = {};
    }
  }
  const contents = Array.isArray(payload.contents) ? payload.contents : [];
  switch (payload.tag) {
    case 'ParameterChange':
      return decodeParams(contents, ep);
    case 'HardForkInitiation':
      return decodeHardFork(contents, ep);
    case 'TreasuryWithdrawals':
      return decodeTreasury(contents, network);
    case 'UpdateCommittee':
    case 'NewCommittee':
      return decodeCommittee(contents);
    case 'NewConstitution':
    case 'UpdateConstitution':
      return decodeConstitution(contents);
    case 'NoConfidence':
      return { kind: 'note', text: 'Motion of no-confidence in the constitutional committee.' };
    case 'InfoAction':
      return { kind: 'note', text: 'Informational action. No on-chain effect; the vote signals opinion only.' };
    default:
      return null;
  }
}
