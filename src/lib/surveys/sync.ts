// CIP-179 surveys sync: mirror Tessera's answers about admitted surveys into
// D1 and open one system thread per admission. DRepTalk implements no CIP-179
// rule of its own — records are decoded with the cip-179 package's fromJsonSafe,
// lifecycle/cancellation come from its published aggregate(), and both
// participation figures are Tessera's own: the index's audited per-role count
// while a survey is held, the finalized tally artifact's DRep responders once
// it is decided. Nothing here counts a response.
//
// Admission (editorial policy, not a claim about the survey): DRep-eligible AND
// linked by a governance action DRepTalk has imported. A miss is re-evaluated
// on a later run; a closed linked survey still gets its thread.

import { Role } from 'cip-179';
import {
  aggregate,
  type CancellationRecord,
  type SurveyAggregate,
  type SurveyRecord,
} from 'cip-179/domain';
import { fromJsonSafe } from 'cip-179/tally';
import { SURVEYS_CATEGORY_SLUG } from '../../../config/categories.js';
import type { NetworkConfig } from '../config/network.js';
import { createTopic } from '../db/forum.js';
import { getKnownProposalIds, hasActionsCreatedSince } from '../db/governance.js';
import {
  buildDeleteGovLinks,
  buildInsertGovLink,
  buildInsertSurvey,
  buildRefreshSurvey,
  deleteLocalSurveyResponse,
  getHeldSurveys,
  getKnownSurveyRefs,
  getPendingSurveyResponses,
  getSurveySyncState,
  getSurveysAwaitingFinalCount,
  type HeldSurvey,
  markStaleSurveyResponsesFailed,
  markSurveysUnavailable,
  putSurveySyncState,
  setSurveyFinalCount,
  type SurveyRefresh,
} from '../db/surveys.js';
import { GOV_SYNC_AUTHOR } from '../governance/sync.js';
import { PENDING_VOTE_TTL_SEC } from '../governance/tallySync.js';
import { renderMarkdown } from '../markdown.js';
import {
  MAX_REFS_PER_CALL,
  type SurveySet,
  type TesseraClient,
  type TesseraTip,
} from '../tessera/client.js';
import { roleLabels } from './view.js';

export type SurveysTessera = Pick<
  TesseraClient,
  'surveyList' | 'surveysByRefs' | 'artifactByHash' | 'responsesByTx'
>;

export interface SurveysSyncDeps {
  db: D1Database;
  tessera: SurveysTessera;
  cfg: NetworkConfig;
  now: number;
  /** Slug-suffix source (injected for deterministic tests). */
  rand: () => string;
}

export interface SurveysSyncResult {
  /** Backend had no snapshot yet; nothing ran. */
  notReady: boolean;
  admitted: number;
  /** Held rows one of whose stored values the answer moved (an unchanged row costs no write). */
  refreshed: number;
  rolledBack: number;
  /** Finalized surveys whose artifact count was stored this run. */
  finalCounts: number;
  /** Local answer rows deleted because their exact tx is indexed upstream. */
  settled: number;
  failed: number;
}

/** Walk the whole linked list at most daily. */
const BACKSTOP_MS = 24 * 60 * 60 * 1000;
/** Hard cap on list pages one run walks (paranoia bound, 200 surveys each). */
const MAX_LIST_PAGES = 25;
/** Pending answers one run polls, oldest first: pass 4 spends one request per
 * distinct transaction, so an unpolled backlog must not be able to walk the
 * Worker's subrequest budget. What is left over waits one cron interval. */
const SETTLE_LIMIT = 50;
/** Restarts a page walk tolerates when the snapshot moves mid-walk (resync). */
const MAX_RESYNC_RESTARTS = 2;
/** How long an absent ref keeps its refresh slot. Four days outlasts
 * Tessera's rolling ~3-day settlement window, past which a rolled-back record
 * is not coming back. Only the slot is released — the thread and its card
 * stay. */
const UNAVAILABLE_TTL_MS = 4 * 24 * 60 * 60 * 1000;

interface DecodedSet {
  aggregates: SurveyAggregate[];
  tip: TesseraTip;
  countedByRole: SurveySet['countedByRole'];
  finalState: SurveySet['finalState'];
  incomplete: boolean;
  fetchedAt: number;
  /** Wire-form record JSON per survey key, stored verbatim in D1. */
  wireByKey: Map<string, string>;
}

/** Decode one /api/surveys answer (page or refs) into Tessera-computed aggregates. */
function decodeSet(set: SurveySet): DecodedSet {
  const records = set.surveys.map(w => fromJsonSafe(w) as SurveyRecord);
  const cancellations = set.cancellations.map(w => fromJsonSafe(w) as CancellationRecord);
  // aggregate() still takes the finalized-cancelled key set; the wire moved to
  // the richer finalState map, so the caller derives the set it wants.
  const finalizedCancelled = new Set(
    Object.entries(set.finalState)
      .filter(([, v]) => v.state === 'cancelled')
      .map(([k]) => k),
  );
  const aggregates = aggregate(
    records,
    cancellations,
    set.responseCounts,
    set.tip,
    set.govLinks,
    finalizedCancelled,
  );
  const wireByKey = new Map<string, string>();
  set.surveys.forEach((w, i) => {
    const key = aggregates[i]?.key;
    if (key) wireByKey.set(key, JSON.stringify(w));
  });
  return {
    aggregates,
    tip: set.tip,
    countedByRole: set.countedByRole,
    finalState: set.finalState,
    incomplete: set.incomplete === true,
    fetchedAt: set.fetchedAt,
    wireByKey,
  };
}

/** The in-window DRep figure for one survey, or null while the backend serves
 * no audited counts. A survey the field names with no counted response has an
 * empty entry — a count of zero, not an unknown. */
function countedDreps(set: DecodedSet, key: string): number | null {
  const byRole = set.countedByRole?.[key];
  return byRole ? (byRole[String(Role.DRep)] ?? 0) : null;
}

/** The row values one answer gives a survey — the same shape at admission and
 * on every refresh, so the two cannot store the same answer differently. */
function rowValues(set: DecodedSet, a: SurveyAggregate, now: number): SurveyRefresh {
  const decided = set.finalState[a.key];
  return {
    ref: a.key,
    countedDreps: countedDreps(set, a.key),
    cancelled: a.cancelled,
    finalState: decided?.state ?? null,
    artifactHash: decided?.artifactHash ?? null,
    now,
  };
}

/** Whether Tessera's answer moves anything the held row stores. An
 * unavailable row is always written: presence in the answer is what clears
 * it. Any non-null final state is new, since only undecided rows are held. */
function refreshChanged(h: HeldSurvey, next: SurveyRefresh, links: Map<string, string | null>) {
  if (h.unavailable || next.finalState !== null) return true;
  if (h.countedDreps !== next.countedDreps || h.cancelled !== next.cancelled) return true;
  if (h.links.size !== links.size) return true;
  for (const [actionId, title] of links) {
    if (!h.links.has(actionId) || h.links.get(actionId) !== title) return true;
  }
  return false;
}

/** Title for the thread: the on-chain title, or a ref-derived fallback (empty
 * titles are legal in external-content mode). */
function surveyTitle(a: SurveyAggregate): string {
  return a.record.definition.title || `Survey (${a.key.slice(0, 8)}:${a.record.ref.index})`;
}

/** Opening post, rendered through the same sanitizing markdown path as
 * governance threads (the description is untrusted on-chain data). */
function composeFirstPostMd(a: SurveyAggregate): string {
  const def = a.record.definition;
  const roles = roleLabels(def.eligibleRoles);
  const lines: string[] = ['**On-chain CIP-179 survey.**', ''];
  if (a.external) {
    lines.push('The survey text lives in an external document that is not loaded here.', '');
  } else if (def.description) {
    lines.push(def.description, '');
  }
  lines.push(`- Eligible to respond: ${roles}`);
  lines.push(`- Responses accepted through epoch ${def.endEpoch} (inclusive)`);
  if (def.submissionMode.type === 'sealed') {
    lines.push('- Sealed survey: answers stay encrypted until the reveal time');
  }
  return lines.join('\n');
}

/** Publication time of the record, projected from the snapshot tip (1s slots
 * post-Shelley), in unix ms — the thread's post date. */
function recordUnixMs(slot: number, tip: TesseraTip): number {
  return (tip.time - (tip.slot - slot)) * 1000;
}

/** Admit every new DRep-eligible survey on the page whose (epoch-aligned) links
 * include an imported action. */
async function admitFromSet(
  deps: SurveysSyncDeps,
  set: DecodedSet,
  known: Set<string>,
  counters: { admitted: number; failed: number },
): Promise<void> {
  const { db, now, rand } = deps;
  const actionIds = [...new Set(set.aggregates.flatMap(a => a.govLinks.map(l => l.actionId)))];
  const imported = await getKnownProposalIds(db, actionIds);
  for (const a of set.aggregates) {
    if (known.has(a.key)) continue;
    if (!a.record.definition.eligibleRoles.includes(Role.DRep)) continue;
    if (!a.govLinks.some(l => imported.has(l.actionId))) continue;
    const wire = set.wireByKey.get(a.key);
    if (!wire) continue;
    try {
      const bodyMd = composeFirstPostMd(a);
      // The survey row and its links commit in the same atomic batch as the
      // topic and first post, so a partial write can never leave an orphan
      // thread for the next run to duplicate.
      await createTopic(db, {
        categorySlug: SURVEYS_CATEGORY_SLUG,
        authorId: GOV_SYNC_AUTHOR,
        title: surveyTitle(a),
        bodyMd,
        bodyHtml: renderMarkdown(bodyMd),
        source: 'survey',
        now,
        postedAt: recordUnixMs(a.record.slot, set.tip),
        rand: rand(),
        batchWith: topicId => [
          buildInsertSurvey(db, {
            ...rowValues(set, a, now),
            topicId,
            title: surveyTitle(a),
            endEpoch: a.record.definition.endEpoch,
            eligibleRoles: a.record.definition.eligibleRoles,
            sealed: a.sealed,
            externalContent: a.external,
            definitionJson: wire,
            submittedAt: recordUnixMs(a.record.slot, set.tip),
          }),
          ...a.govLinks.map(l => buildInsertGovLink(db, a.key, l.actionId, l.title)),
        ],
      });
      known.add(a.key);
      counters.admitted++;
    } catch (err) {
      console.error(`[surveys] admission failed for ${a.key}`, err);
      counters.failed++;
    }
  }
}

export async function syncSurveys(deps: SurveysSyncDeps): Promise<SurveysSyncResult> {
  const { db, tessera, now } = deps;
  const counters = { admitted: 0, failed: 0 };
  let refreshed = 0;
  let rolledBack = 0;
  let finalCounts = 0;
  let settled = 0;

  const state = await getSurveySyncState(db);
  const known = await getKnownSurveyRefs(db);

  // --- Pass 1: discover. Page one of ?filter=linked re-evaluates the whole
  // linked set while it fits (counts.linked sizes the universe); paging past it
  // costs requests, so it waits for a reason: the count moved, an action was
  // imported since the last complete walk (the DRepTalk half of an admission
  // turning true late), or the daily backstop is due.
  const page1 = await tessera.surveyList({ filter: 'linked', limit: MAX_REFS_PER_CALL });
  if (!page1.ready) {
    return {
      notReady: true,
      admitted: 0,
      refreshed: 0,
      rolledBack: 0,
      finalCounts: 0,
      settled: 0,
      failed: 0,
    };
  }
  const walkTriggered =
    page1.value.nextCursor !== null &&
    (page1.value.counts.linked !== state.linkedCount ||
      (await hasActionsCreatedSince(db, state.lastFullWalkAt ?? 0)) ||
      now - (state.lastFullWalkAt ?? 0) > BACKSTOP_MS);

  /** The oldest snapshot any row was written from this run: what the "as of"
   * line may claim once every held row has been refreshed. */
  let asOf = page1.value.fetchedAt;
  let completeWalk = false;
  /** The linked-set size the completed walk saw. A restart re-reads page one,
   * and what this pass persists has to describe the generation it actually
   * walked, not the one it abandoned. */
  let walkedCount = page1.value.counts.linked;
  for (let restart = 0; restart <= MAX_RESYNC_RESTARTS && !completeWalk; restart++) {
    let page =
      restart === 0
        ? page1
        : await tessera.surveyList({ filter: 'linked', limit: MAX_REFS_PER_CALL });
    for (let n = 0; n < MAX_LIST_PAGES; n++) {
      if (!page.ready) {
        return { notReady: true, ...counters, refreshed, rolledBack, finalCounts, settled };
      }
      // Read before the page is used for anything: `resync` says the snapshot
      // moved under the cursor, so these rows belong to a generation this walk
      // is abandoning — and a stale answer is served best-effort, so its
      // terminal cursor is not this generation's end either. Taking it would
      // stamp last_full_walk_at over a walk that skipped whatever crossed a
      // keyset boundary. Restart from a fresh page one instead.
      if (page.value.resync) break;
      if (n === 0) walkedCount = page.value.counts.linked;
      asOf = Math.min(asOf, page.value.fetchedAt);
      await admitFromSet(deps, decodeSet(page.value), known, counters);
      if (page.value.nextCursor === null) {
        completeWalk = true;
        break;
      }
      if (!walkTriggered) break;
      page = await tessera.surveyList({
        filter: 'linked',
        limit: MAX_REFS_PER_CALL,
        cursor: page.value.nextCursor,
      });
    }
    if (!walkTriggered) break;
  }

  // --- Pass 2: refresh every held (not-yet-final) survey by explicit refs,
  // rolled-back detection included. The answer names every held survey on
  // every run, so only a row one of whose stored values moved is written:
  // rewriting the rest would be a write per held row per five minutes that
  // changes nothing.
  let refreshComplete = false;
  try {
    const held = await getHeldSurveys(db, now - UNAVAILABLE_TTL_MS);
    let answered = true;
    for (let i = 0; i < held.length; i += MAX_REFS_PER_CALL) {
      const chunk = held.slice(i, i + MAX_REFS_PER_CALL);
      const byRef = new Map(chunk.map(h => [h.ref, h]));
      const result = await tessera.surveysByRefs(chunk.map(h => h.ref));
      if (!result.ready) {
        answered = false;
        break;
      }
      const set = decodeSet(result.value);
      asOf = Math.min(asOf, set.fetchedAt);
      const present = new Set(set.aggregates.map(a => a.key));
      // D1's 100-bind cap is per statement, not summed across a batch, and the
      // widest statement here binds 6 — so one chunk's refreshes commit as a
      // single batch, keeping the whole page's rewrite atomic. An answer that
      // moved nothing yields no statements: D1 rejects an empty batch, so it
      // must not be issued.
      const statements: D1PreparedStatement[] = [];
      for (const a of set.aggregates) {
        const h = byRef.get(a.key);
        if (!h) continue;
        const next = rowValues(set, a, now);
        const links = new Map(a.govLinks.map(l => [l.actionId, l.title]));
        if (!refreshChanged(h, next, links)) continue;
        statements.push(
          buildRefreshSurvey(db, next),
          buildDeleteGovLinks(db, a.key),
          ...a.govLinks.map(l => buildInsertGovLink(db, a.key, l.actionId, l.title)),
        );
        refreshed++;
      }
      if (statements.length > 0) await db.batch(statements);
      // A ref absent from a COMPLETE answer names a rolled-back record; from an
      // incomplete one, absence proves nothing — touch no row.
      if (!set.incomplete) {
        const absent = chunk.map(h => h.ref).filter(ref => !present.has(ref));
        if (absent.length > 0) {
          await markSurveysUnavailable(db, absent, now);
          rolledBack += absent.length;
        }
      }
    }
    refreshComplete = answered;
  } catch (err) {
    console.error('[surveys] refresh pass failed', err);
    counters.failed++;
  }

  // The mirror's bookkeeping, one row: the walk that completed (if one did)
  // and the snapshot the held rows now reflect. The "as of" advances only when
  // every held row was answered for — a refresh that broke off leaves rows
  // describing an older snapshot, and the line must not promise fresher.
  await putSurveySyncState(db, {
    linkedCount: completeWalk ? walkedCount : state.linkedCount,
    lastFullWalkAt: completeWalk ? now : state.lastFullWalkAt,
    tesseraFetchedAt: refreshComplete ? asOf : state.tesseraFetchedAt,
  });

  // --- Pass 3: the final count of every finalized survey whose artifact has
  // not been read — normally the one whose decision pass 2 just wrote, plus
  // any whose artifact request failed on an earlier run. The artifact's DRep
  // responders are the responses counted at close, after the end-epoch role
  // membership the in-window count cannot apply; a role with no counted
  // responder is absent from it, so absence reads as zero. Each survey is its
  // own request and its own failure: one that fails is simply still awaiting
  // on the next run.
  try {
    for (const { ref, artifactHash } of await getSurveysAwaitingFinalCount(db)) {
      try {
        const artifact = await tessera.artifactByHash(artifactHash);
        const dreps = artifact.tally.perRole.find(r => r.role === Role.DRep);
        await setSurveyFinalCount(db, ref, dreps ? dreps.responders.length : 0, now);
        finalCounts++;
      } catch (err) {
        console.error(`[surveys] final count for ${ref} failed`, err);
        counters.failed++;
      }
    }
  } catch (err) {
    console.error('[surveys] final count pass failed', err);
    counters.failed++;
  }

  // --- Pass 4: settle optimistic local answers by exact transaction. Matching
  // the transaction, not just the survey, is what makes a replacement visible
  // where /api/responded would hide it. An unindexed hash answers 200 with an
  // empty list — "submitted, not indexed yet" is the state this pass polls —
  // so an empty answer leaves the row pending for reconcileSurveyResponses to
  // age once the cutoff passes. The overlay never claims validity: "counted"
  // is only knowable at finalization.
  try {
    const pending = await getPendingSurveyResponses(db, SETTLE_LIMIT);
    const byTx = new Map<string, typeof pending>();
    for (const row of pending) {
      const rows = byTx.get(row.txHash);
      if (rows) rows.push(row);
      else byTx.set(row.txHash, [row]);
    }
    for (const [txHash, rows] of byTx) {
      try {
        const result = await tessera.responsesByTx(txHash);
        if (!result.ready) break;
        // The row is this account's own claim, so settling it needs the
        // response to be the one it claims: same survey, answered as a DRep,
        // by the credential the session derived at record time. One
        // transaction can carry responses to several surveys and in several
        // roles, and a wallet holding more than one DRep credential can answer
        // for another of them — matching the survey alone would clear a row
        // nothing on chain answers.
        const asDrep = result.value.filter(r => r.role === Role.DRep);
        for (const row of rows) {
          const onChain = asDrep.some(
            r => r.surveyKey === row.surveyRef && r.credential === row.credential,
          );
          if (onChain) {
            await deleteLocalSurveyResponse(db, row.surveyRef, row.userId);
            settled++;
          }
        }
      } catch (err) {
        // Each transaction is a separate claim: one that errors must not hold
        // back the rows queued behind it, which would otherwise reach their
        // cutoff having never been polled at all.
        console.error(`[surveys] settling ${txHash} failed`, err);
        counters.failed++;
      }
    }
  } catch (err) {
    console.error('[surveys] settle pass failed', err);
    counters.failed++;
  }

  return { notReady: false, ...counters, refreshed, rolledBack, finalCounts, settled };
}

/**
 * Ages optimistic answers past the confirmation cutoff (the GA-vote one — one
 * cutoff for both lifecycles) to 'failed'. Deliberately outside syncSurveys
 * and outside the mirror's switch: it is a statement about the clock, not
 * about Tessera, and a row it stops ageing sits on the survey card promising
 * to be checked against the chain every few minutes while nothing checks it.
 * Runs after the settle pass, so an answer that did land is already gone.
 */
export async function reconcileSurveyResponses(db: D1Database, now: number): Promise<number> {
  return markStaleSurveyResponsesFailed(db, now - PENDING_VOTE_TTL_SEC * 1000);
}
