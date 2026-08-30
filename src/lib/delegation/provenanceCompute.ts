// Orchestrates the three-step Koios chain for voting-power-origins and joins
// display names from our dreps table. Pure math lives in provenance.ts, this
// module owns pagination, batching and the name join. The Koios client is
// injected so workers tests can fake it (same split as track.ts/handleTrack).
// Privacy: stake addresses live only in this request scope, they are never
// written to D1, the payload, or logs.
import type { AccountUpdateHistoryRow, DrepDelegatorRow, TxCert, TxInfoCertsRow } from '../koios/client';
import { KOIOS_BATCH_CONCURRENCY, mapLimit } from '../koios/concurrency';
import { getDrepsByIds } from '../db/dreps';
import {
  aggregateSources, capCandidates, classifyCandidate, prefilterDelegators, resolveEvents,
  TX_LOOKUP_BUDGET, type ProvenancePayload, type ProvenanceWindow,
} from './provenance';

export interface ProvenanceKoios {
  drepInfoBatch(drepIds: string[]): Promise<Array<{ live_delegator_count?: number | null }>>;
  drepDelegators(drepId: string, limit?: number, offset?: number): Promise<DrepDelegatorRow[]>;
  accountUpdateHistoryBatch(stakeAddresses: string[]): Promise<AccountUpdateHistoryRow[]>;
  txInfoCertsBatch(txHashes: string[]): Promise<TxInfoCertsRow[]>;
}

const PAGE = 1000;

/**
 * Fetches the full current delegator set. One cheap headcount read sizes the
 * page fan-out (a whale's 18 sequential pages were the largest single stage
 * in the live measurement), the guided pages then fetch with bounded
 * concurrency. The headcount can drift between the two reads or be missing,
 * so a tail keeps paging sequentially while the last page comes back full.
 */
async function allDelegators(koios: ProvenanceKoios, drepId: string): Promise<DrepDelegatorRow[]> {
  const info = await koios.drepInfoBatch([drepId]);
  const headcount = info[0]?.live_delegator_count ?? 0;
  const guidedPages = Math.max(1, Math.ceil(headcount / PAGE));
  const offsets = Array.from({ length: guidedPages }, (_, i) => i * PAGE);
  const pages = await mapLimit(offsets, KOIOS_BATCH_CONCURRENCY, (offset) =>
    koios.drepDelegators(drepId, PAGE, offset),
  );
  const out = pages.flat();
  let lastLength = pages[pages.length - 1]?.length ?? 0;
  for (let offset = guidedPages * PAGE; lastLength === PAGE; offset += PAGE) {
    const page = await koios.drepDelegators(drepId, PAGE, offset);
    out.push(...page);
    lastLength = page.length;
  }
  return out;
}

export async function computeProvenance(deps: {
  koios: ProvenanceKoios;
  db: D1Database;
  drepId: string;
  windowEpochs: ProvenanceWindow;
  currentEpoch: number;
  now: number;
  /** Test injection point, defaults to TX_LOOKUP_BUDGET. */
  txLookupBudget?: number;
}): Promise<ProvenancePayload> {
  const { koios, db, drepId, windowEpochs, currentEpoch, now } = deps;
  const txLookupBudget = deps.txLookupBudget ?? TX_LOOKUP_BUDGET;
  const cutoff = currentEpoch - windowEpochs;

  const delegators = await allDelegators(koios, drepId);
  const { candidates, base } = prefilterDelegators(delegators, currentEpoch, windowEpochs);
  const { analyzed: capped, notAnalyzed: cappedOut } = capCandidates(candidates);
  // Amount-descending order drives the tx-budget degrade below.
  const ordered = [...capped].sort((a, b) => {
    const av = BigInt(a.amount);
    const bv = BigInt(b.amount);
    return bv > av ? 1 : bv < av ? -1 : 0;
  });

  let baseCount = base.count;
  let baseAmount = BigInt(base.amount);
  let reclassifiedBaseCount = 0;
  const arrivals: Parameters<typeof aggregateSources>[0] = [];
  const unresolvedRows: DrepDelegatorRow[] = [];
  const degraded: DrepDelegatorRow[] = [];
  const analyzedRows: DrepDelegatorRow[] = [];

  if (ordered.length > 0) {
    // History first: it is the cheap stage, and the tx budget can only be
    // decided once the per-candidate tx counts are known.
    const historyRows = await koios.accountUpdateHistoryBatch(ordered.map((r) => r.stake_address));
    const historyByAddr = new Map<string, AccountUpdateHistoryRow[]>();
    for (const row of historyRows) {
      if (row.action_type !== 'delegation_drep') continue;
      const list = historyByAddr.get(row.stake_address);
      if (list) list.push(row);
      else historyByAddr.set(row.stake_address, [row]);
    }

    // Tx budget gates the EXPENSIVE tx_info stage: walk candidates largest
    // first, accumulate deduped hashes, and once the union would exceed the
    // budget this and every smaller candidate degrade to the unclassified
    // bucket (their fetched history is discarded, no targets are resolved).
    const txHashes = new Set<string>();
    let overBudget = false;
    for (const row of ordered) {
      if (overBudget) {
        degraded.push(row);
        continue;
      }
      // Deduped up front: two certs in one tx produce two history rows, and
      // without this an account's own repeated tx hash would count twice
      // against the budget below.
      const own = new Set((historyByAddr.get(row.stake_address) ?? []).map((r) => r.tx_hash));
      const add = [...own].filter((h) => !txHashes.has(h));
      if (txHashes.size + add.length > txLookupBudget) {
        overBudget = true;
        degraded.push(row);
        continue;
      }
      for (const h of add) txHashes.add(h);
      analyzedRows.push(row);
    }

    const certRows = txHashes.size > 0 ? await koios.txInfoCertsBatch([...txHashes]) : [];
    const certsByTx = new Map<string, TxCert[]>(certRows.map((r) => [r.tx_hash, r.certificates ?? []]));

    for (const row of analyzedRows) {
      const events = resolveEvents(historyByAddr.get(row.stake_address) ?? [], row.stake_address, certsByTx);
      const cls = classifyCandidate(events, drepId, cutoff);
      if (cls.kind === 'base') {
        // The re-cert case: an old stint with recent cert activity.
        baseCount += 1;
        baseAmount += BigInt(row.amount);
        reclassifiedBaseCount += 1;
      } else if (cls.kind === 'unresolved') {
        unresolvedRows.push(row);
      } else {
        arrivals.push({ row, source: cls.source, returning: cls.returning });
      }
    }
  }

  const sources = aggregateSources(arrivals);
  const drepIds = sources.filter((s) => s.type === 'drep' && s.drepId).map((s) => s.drepId as string);
  if (drepIds.length > 0) {
    const known = await getDrepsByIds(db, drepIds);
    for (const s of sources) {
      if (s.type === 'drep' && s.drepId) {
        const drep = known.get(s.drepId);
        s.name = drep?.name ?? null;
        s.hex = drep?.hex ?? null;
        s.slug = drep?.slug ?? null;
      }
    }
  }

  const sumBig = (rows: { amount: string }[]) => rows.reduce((acc, r) => acc + BigInt(r.amount), 0n);
  const notAnalyzedCount = (cappedOut?.count ?? 0) + degraded.length;
  const notAnalyzedAmount = BigInt(cappedOut?.amount ?? '0') + sumBig(degraded);

  return {
    version: 1,
    computedAt: now,
    currentEpoch,
    windowEpochs,
    base: { count: baseCount, amount: baseAmount.toString() },
    sources,
    coverage: {
      analyzedCandidateCount: analyzedRows.length,
      totalCandidateCount: candidates.length,
      analyzedCandidateAmount: sumBig(analyzedRows).toString(),
      totalCandidateAmount: sumBig(candidates).toString(),
    },
    notAnalyzed: notAnalyzedCount > 0 ? { count: notAnalyzedCount, amount: notAnalyzedAmount.toString() } : null,
    unresolved: unresolvedRows.length > 0
      ? { count: unresolvedRows.length, amount: sumBig(unresolvedRows).toString() }
      : null,
    reclassifiedBaseCount,
    returningTotal: sources.reduce((acc, s) => acc + s.returningCount, 0),
  };
}
