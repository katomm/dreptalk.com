/// <reference types="@cloudflare/workers-types" />
// The DRep groups step of a governance tick. Under the lease it opens an operator truncation, checks
// the library version and the power change queue, runs the ingest, the engine, the jobs and the profile
// and website upkeep, each within what is left of one query allowance. The allowance is the smaller of
// the groups share and what the earlier phases of the invocation left, and the release of the lease is
// reserved from it up front.
import type { Recovery } from 'drep-groups';
import { LeaseLostError, runEngine } from 'drep-groups';
import type { CardanoNetwork } from '../config/network.js';
import type { DedicatedGateway } from '../governance/metadata.js';
import type { PhaseResult } from '../sync/runRecorder.js';
import { type Allowance, allowance, type QueryMeter } from '../sync/queryBudget.js';
import {
  ADMIN_RESERVE_QUERIES,
  ENGINE_BUDGET,
  GOVERNANCE_QUERY_BUDGET,
  GROUPS_QUERY_SHARE,
  INGEST_QUERY_SHARE,
  MAX_ENGINE_RUNS_PER_TICK,
  MAX_JOB_ROWS_PER_RUN,
  PROFILE_QUERIES_PER_ITEM,
  PROFILE_SELECT_QUERIES,
  RELEASE_RESERVE_QUERIES,
  RUN_MAX_QUERIES,
  WEBSITE_QUERIES_PER_ITEM,
  WEBSITE_SELECT_QUERIES,
} from './constants.js';
import { checkLibraryVersion, type GroupsKoios, type IngestResult, ingestDrepGroups } from './ingest.js';
import { enqueuePowerScan, type JobReport, runJobs } from './jobs.js';
import { refreshGroupProfiles, verifyGroupWebsites } from './profile.js';
import { D1Store } from './store/d1Store.js';
import { acquireLease, invocationOwner, releaseLease, writeBatch } from './store/lease.js';
import { Q } from './store/queries.js';
import { pendingRecovery } from './store/reads.js';
import { openRecoveryStatements, readMeta, slotsFromMeta } from './store/recovery.js';

/** Items of one profile or website pass at most. */
const MAX_ITEMS = 10;

export interface PhaseReport {
  lease: 'held' | 'busy' | 'skipped';
  ingest: IngestResult | null;
  runs: number;
  recovery: Recovery | null;
  jobs: JobReport | null;
  profiles: { fetched: number; failed: number };
  websites: { checked: number; verified: number };
  /** Steps skipped because the allowance did not cover them. */
  starved: string[];
  queries: number;
}

export interface PhaseContext {
  db: D1Database;
  koios: GroupsKoios;
  meter: QueryMeter;
  gateway: DedicatedGateway | null;
  network: CardanoNetwork;
  now: number;
  fetchImpl?: typeof fetch;
  owner?: string;
}

/** A view of `parent` that stops at its own `cap` and at the parent's remaining budget minus `reserve`. */
export function capAllowance(parent: Allowance, cap: number, reserve: number): Allowance {
  const start = parent.spent();
  const spent = () => parent.spent() - start;
  const remaining = () => Math.min(cap - spent(), parent.remaining() - reserve);
  return { spent, remaining, covers: (cost) => remaining() >= cost };
}

const starve = (starved: string[], step: string): void => {
  if (!starved.includes(step)) starved.push(step);
};

/** Opens a truncation the operator requested in meta, and clears the request in the same batch. */
async function operatorTruncate(db: D1Database, lease: string): Promise<void> {
  const meta = await readMeta(db);
  const requested = meta.operator_truncate;
  if (requested === null || requested === undefined) return;
  const above = Number(requested);
  const valid = Number.isSafeInteger(above) && above >= 0;
  if (!valid) console.error(`[drep-groups] ignored an operator truncation request of ${String(requested)}`);
  await writeBatch(db, lease, [
    ...(valid ? openRecoveryStatements(db, slotsFromMeta(meta), { kind: 'truncate', above }, null) : []),
    db.prepare(Q.operatorTruncateClear.sql).bind(requested),
  ]);
  if (valid) console.log(`[drep-groups] operator truncation above=${above} opened`);
}

/** Up to `MAX_ITEMS` per pass, as many as the allowance covers after the selection and the release. */
function itemsWithin(phase: Allowance, select: number, perItem: number): number {
  return Math.min(MAX_ITEMS, Math.floor((phase.remaining() - select - RELEASE_RESERVE_QUERIES) / perItem));
}

/** Due profiles, then due websites, each only when the allowance covers its selection, one item and the release. */
export async function maintainProfiles(
  deps: { db: D1Database; lease: string; fetchImpl: typeof fetch; gateway: DedicatedGateway | null; network: CardanoNetwork; now: number },
  phase: Allowance,
  report: Pick<PhaseReport, 'profiles' | 'websites' | 'starved'>,
): Promise<void> {
  if (phase.covers(PROFILE_SELECT_QUERIES + PROFILE_QUERIES_PER_ITEM + RELEASE_RESERVE_QUERIES)) {
    report.profiles = await refreshGroupProfiles({ ...deps, limit: itemsWithin(phase, PROFILE_SELECT_QUERIES, PROFILE_QUERIES_PER_ITEM) });
  } else {
    starve(report.starved, 'profiles');
  }
  if (phase.covers(WEBSITE_SELECT_QUERIES + WEBSITE_QUERIES_PER_ITEM + RELEASE_RESERVE_QUERIES)) {
    report.websites = await verifyGroupWebsites({ ...deps, limit: itemsWithin(phase, WEBSITE_SELECT_QUERIES, WEBSITE_QUERIES_PER_ITEM) });
  } else {
    starve(report.starved, 'websites');
  }
}

async function work(ctx: PhaseContext, lease: string, phase: Allowance, report: PhaseReport): Promise<void> {
  const { db, now } = ctx;
  await operatorTruncate(db, lease);
  await checkLibraryVersion(db, lease);
  await enqueuePowerScan(db, lease);

  // While a recovery slot is open the ingest returns at once and the engine steps the recovery.
  const ingest = await ingestDrepGroups({ db, koios: ctx.koios, lease, budget: capAllowance(phase, INGEST_QUERY_SHARE, RELEASE_RESERVE_QUERIES), now });
  report.ingest = ingest;
  for (const s of ingest.starved) starve(report.starved, s);

  const store = new D1Store(db);
  let more = true;
  while (more && report.runs < MAX_ENGINE_RUNS_PER_TICK) {
    if (!phase.covers(RUN_MAX_QUERIES + RELEASE_RESERVE_QUERIES)) {
      starve(report.starved, 'engine');
      break;
    }
    const r = await runEngine(store, ENGINE_BUDGET, lease);
    report.runs++;
    more = r.more;
  }

  report.jobs = await runJobs(db, lease, {
    maxRows: MAX_JOB_ROWS_PER_RUN,
    budget: capAllowance(phase, phase.remaining(), RELEASE_RESERVE_QUERIES),
    now,
  });
  if (report.jobs.skipped === 'budget') starve(report.starved, 'jobs');

  await maintainProfiles({ db, lease, fetchImpl: ctx.fetchImpl ?? fetch, gateway: ctx.gateway, network: ctx.network, now }, phase, report);

  report.recovery = phase.covers(1 + RELEASE_RESERVE_QUERIES) ? await pendingRecovery(db) : ingest.recovery;
}

function log(r: PhaseReport): void {
  const i = r.ingest;
  const recovery = r.recovery === null ? 'none' : r.recovery.kind === 'truncate' ? `truncate:${r.recovery.above}` : r.recovery.kind;
  console.log(
    `[drep-groups] lease=${r.lease} txs=${i?.newTxs ?? 0} markers=${i?.markers ?? 0} ledger=${i?.newLedgerRows ?? 0}` +
      ` tracked=${i?.tracked ?? 0} gate=${i?.gateChecked ?? 0} witness=${i?.witnessChecks ?? 0} probing=${i?.probing ?? false}` +
      ` runs=${r.runs} recovery=${recovery} jobs=${r.jobs?.pages ?? 0} profiles=${r.profiles.fetched}/${r.profiles.failed}` +
      ` websites=${r.websites.checked}/${r.websites.verified} starved=${r.starved.join(',') || 'none'} queries=${r.queries}`,
  );
}

/** One DRep groups step. A lost lease ends it quietly, the next holder continues from the stored state. */
export async function runDrepGroupsPhase(ctx: PhaseContext): Promise<PhaseReport> {
  const left = Math.max(0, Math.min(GROUPS_QUERY_SHARE, GOVERNANCE_QUERY_BUDGET - ctx.meter.used()));
  const phase = allowance(ctx.meter, left);
  const report: PhaseReport = {
    lease: 'skipped',
    ingest: null,
    runs: 0,
    recovery: null,
    jobs: null,
    profiles: { fetched: 0, failed: 0 },
    websites: { checked: 0, verified: 0 },
    starved: [],
    queries: 0,
  };
  const finish = (): PhaseReport => {
    report.queries = phase.spent();
    log(report);
    return report;
  };
  if (!phase.covers(ADMIN_RESERVE_QUERIES + RELEASE_RESERVE_QUERIES)) {
    starve(report.starved, 'admin');
    return finish();
  }
  const lease = await acquireLease(ctx.db, ctx.owner ?? invocationOwner());
  if (lease === null) {
    report.lease = 'busy';
    return finish();
  }
  report.lease = 'held';
  try {
    await work(ctx, lease, phase, report);
  } catch (err) {
    if (err instanceof LeaseLostError) return finish();
    // Any other failure frees the lease for the next tick before it surfaces.
    await releaseLease(ctx.db, lease).catch((e) => console.error('[drep-groups] lease release failed', e));
    throw err;
  }
  await releaseLease(ctx.db, lease);
  return finish();
}

export function toPhaseResult(r: PhaseReport): PhaseResult {
  return { items: (r.ingest?.newTxs ?? 0) + (r.ingest?.newLedgerRows ?? 0) + r.profiles.fetched, failed: r.profiles.failed };
}
