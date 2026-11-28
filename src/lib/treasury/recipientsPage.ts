// Page model of the treasury recipients overview and the address pages. The
// pure builder turns stored rows into everything the pages render, so tiles,
// bar, chart, table, CSV and share card all read one result. The loader only
// does the three reads.
import type { RecipientLabel } from '../../../config/treasury-recipients.js';
import type { CardanoNetwork, NetworkConfig } from '../config/network.js';
import { listEpochBalances } from '../db/governanceEpochStats.js';
import { getProtocolParams } from '../db/protocolParams.js';
import { listAllTreasuryRows } from '../db/treasury.js';
import { csvField } from '../format/csv.js';
import { recipientKeyId } from '../governance/onchain.js';
import { parseStakeAddress } from '../governance/treasuryWithdrawals.js';
import { labelFor, type AddressLabel } from './labels.js';
import { proposerShortLabel } from './recipientHistory.js';
import {
  concentrationSegments,
  groupRecipients,
  paidByQuarter,
  paidInEpochs,
  sumPaid,
  UNKNOWN_RECIPIENT_ID,
  type BarSegment,
  type RecipientSummary,
  type TreasuryActionRow,
} from './recipients.js';
import {
  EPOCHS_PER_YEAR,
  paidByEnactedEpoch,
  projectRunway,
  runwayInputs,
  runwayPresets,
  type EpochBalance,
  type RunwayInputs,
  type RunwayPreset,
  type RunwayProjection,
} from './runway.js';

export { runwayResultText } from './runwayText.js';

export interface RunwaySection {
  inputs: RunwayInputs;
  presets: RunwayPreset[];
  /** Stored treasury balances up to the last closed epoch. */
  history: { epoch: number; treasury: bigint }[];
  initial: RunwayProjection;
  initialSpend: bigint;
}

export interface RecipientsPageData {
  network: CardanoNetwork;
  summaries: RecipientSummary[];
  labels: Map<string, AddressLabel | null>;
  totalPaid: bigint;
  addressCount: number;
  treasury: bigint | null;
  treasuryEpoch: number | null;
  paidLast12: bigint;
  segments: BarSegment[];
  quarters: { quarter: string; bySegment: Map<string, bigint> }[];
  runway: RunwaySection | null;
  /** Enacted payouts without an enactment epoch, left out of time buckets. */
  undatedPayouts: number;
}

export interface BuildInput {
  rows: TreasuryActionRow[];
  balances: EpochBalance[];
  currentEpoch: number | null;
  cfg: NetworkConfig;
  nowSec: number;
  labels?: readonly RecipientLabel[];
}

export function buildRecipientsPage(inp: BuildInput): RecipientsPageData {
  const summaries = groupRecipients(inp.rows, inp.cfg);
  const labels = new Map(summaries.map((s) => [s.id, labelFor(s, inp.cfg.network, inp.labels)]));
  const segments = concentrationSegments(summaries);
  const L = inp.currentEpoch != null ? inp.currentEpoch - 1 : null;

  const closed = inp.balances.filter((b) => L == null || b.epoch <= L);
  const lastTreasury = [...closed].reverse().find((b) => b.treasury != null);

  let runway: RunwaySection | null = null;
  if (L != null && inp.currentEpoch != null) {
    const inputs = runwayInputs(inp.balances, paidByEnactedEpoch(inp.rows), L, inp.cfg);
    if (inputs) {
      const presets = runwayPresets(summaries, L, inp.currentEpoch, inp.cfg);
      const initialSpend = presets[0].lovelacePerYear;
      runway = {
        inputs,
        presets,
        history: closed.filter((b) => b.treasury != null).map((b) => ({ epoch: b.epoch, treasury: b.treasury as bigint })),
        initial: projectRunway(inputs, initialSpend),
        initialSpend,
      };
    }
  }

  let undatedPayouts = 0;
  for (const r of inp.rows) if (r.status === 'enacted' && r.enactedEpoch == null) undatedPayouts++;

  return {
    network: inp.cfg.network,
    summaries,
    labels,
    totalPaid: sumPaid(summaries),
    addressCount: summaries.filter((s) => s.id !== UNKNOWN_RECIPIENT_ID).length,
    treasury: lastTreasury?.treasury ?? null,
    treasuryEpoch: lastTreasury?.epoch ?? null,
    paidLast12: L != null ? paidInEpochs(summaries, L - (EPOCHS_PER_YEAR - 1), L) : 0n,
    segments,
    quarters: paidByQuarter(summaries, segments.map((s) => s.id), inp.nowSec),
    runway,
    undatedPayouts,
  };
}

export async function loadRecipientsPage(db: D1Database, cfg: NetworkConfig, nowSec: number): Promise<RecipientsPageData> {
  const [rows, balances, params] = await Promise.all([listAllTreasuryRows(db), listEpochBalances(db, 0), getProtocolParams(db)]);
  return buildRecipientsPage({ rows, balances, currentEpoch: params?.epoch ?? null, cfg, nowSec });
}

export interface RecipientPageData {
  summary: RecipientSummary;
  label: AddressLabel | null;
  /** Live topic slug by action id, for the label source link. */
  slugs: Map<string, string | null>;
}

/** The summary of one stake address on this network, null when it is malformed or never a recipient. */
export function findRecipient(
  rows: TreasuryActionRow[],
  cfg: NetworkConfig,
  address: string,
  labels?: readonly RecipientLabel[],
): RecipientPageData | null {
  const parsed = parseStakeAddress(address, cfg.network);
  if (!parsed.ok) return null;
  const { kind, hashHex } = parsed.value.credential;
  const id = recipientKeyId({ credType: kind === 'script' ? 'scriptHash' : 'keyHash', hash: hashHex.toLowerCase() });
  const summary = groupRecipients(rows, cfg).find((s) => s.id === id);
  if (!summary) return null;
  const slugs = new Map(rows.map((r) => [r.id, r.slug]));
  return { summary, label: labelFor(summary, cfg.network, labels), slugs };
}

export async function loadRecipientPage(db: D1Database, cfg: NetworkConfig, address: string): Promise<RecipientPageData | null> {
  return findRecipient(await listAllTreasuryRows(db), cfg, address);
}

/** Short display name of an address: its label, else the shortened stake address. */
export function addressName(s: RecipientSummary, label: AddressLabel | null): string {
  if (label?.kind === 'proposal') return label.label;
  if (!s.address) return 'Unknown recipient';
  return `${s.address.slice(0, 12)}…${s.address.slice(-6)}`;
}

/** "Submitted by Intersect (46), Input Output (11) and 3 more". */
export function proposersLine(s: RecipientSummary, max = 3): string | null {
  // One registry proposer can own several return addresses, so merge by name.
  const byName = new Map<string, number>();
  for (const p of s.proposers) {
    const who = proposerShortLabel(p.returnAddress);
    if (who != null) byName.set(who, (byName.get(who) ?? 0) + p.count);
  }
  const named = [...byName].map(([who, count]) => ({ who, count })).sort((a, b) => b.count - a.count);
  if (named.length === 0) return null;
  const shown = named.slice(0, max).map((p) => `${p.who} (${p.count})`);
  const rest = named.length - shown.length;
  return `Submitted by ${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`;
}

/** Segment share as text, one decimal: "70.8 %". */
export function pctText(pct: number): string {
  return `${pct.toFixed(1)} %`;
}

function isoDay(sec: number | null): string {
  return sec == null ? '' : new Date(sec * 1000).toISOString().slice(0, 10);
}

/** One row per address, amounts in lovelace. */
export function recipientsCsv(data: RecipientsPageData): string {
  const lines = ['stake_address,credential_type,label,paid_lovelace,requested_not_paid_lovelace,withdrawals,first_payout,last_payout'];
  for (const s of data.summaries) {
    const label = data.labels.get(s.id);
    lines.push(
      [
        s.address ?? 'unknown',
        s.key?.credType ?? '',
        csvField(label?.kind === 'proposal' ? label.label : label?.kind === 'proposer' ? label.name : ''),
        s.paid.toString(),
        s.notPaid.toString(),
        String(s.withdrawals),
        isoDay(s.firstPaidAt),
        isoDay(s.lastPaidAt),
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}
