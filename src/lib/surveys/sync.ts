// CIP-179 surveys sync: mirror Tessera's answers about admitted surveys into
// D1 and open one system thread per admission. DRepTalk implements no CIP-179
// rule of its own — records are decoded with the cip-179 package's fromJsonSafe,
// lifecycle/cancellation come from its published aggregate(), and the displayed
// DRep count from its published auditResponses(): the same ruleset-pinned code
// Tessera itself runs, so no second implementation exists to drift.
//
// Admission (editorial policy, not a claim about the survey): DRep-eligible AND
// linked by a governance action DRepTalk has imported. A miss is re-evaluated
// on a later run; a closed linked survey still gets its thread.

import { Role } from 'cip-179';
import {
  aggregate,
  auditResponses,
  type CancellationRecord,
  type ProofVerdicts,
  type ResponseRecord,
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
  getAuditDueSurveys,
  getHeldSurveys,
  getKnownSurveyRefs,
  getPendingSurveyResponses,
  concedeSurveyAudit,
  getSurveySyncState,
  markStaleSurveyResponsesFailed,
  markSurveyAudited,
  markSurveyAuditFailed,
  markSurveysUnavailable,
  putSurveySyncState,
} from '../db/surveys.js';
import { GOV_SYNC_AUTHOR } from '../governance/sync.js';
import { PENDING_VOTE_TTL_SEC } from '../governance/tallySync.js';
import { renderMarkdown } from '../markdown.js';
import {
  MAX_REFS_PER_CALL,
  type SurveySet,
  type TesseraClient,
  TesseraHttpError,
  type TesseraTip,
} from '../tessera/client.js';
import { roleLabels } from './view.js';

export type SurveysTessera = Pick<
  TesseraClient,
  'surveyList' | 'surveysByRefs' | 'surveyBundle' | 'responsesByTx'
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
  refreshed: number;
  rolledBack: number;
  audited: number;
  /** Local answer rows deleted because their exact tx is indexed upstream. */
  settled: number;
  failed: number;
}

/** Walk the whole linked list at most daily. */
const BACKSTOP_MS = 24 * 60 * 60 * 1000;
/** Hard cap on list pages one run walks (paranoia bound, 200 surveys each). */
const MAX_LIST_PAGES = 25;
/** Bundle audits per run: a large due set spreads over several cron
 * invocations, which due-order makes safe — the next run resumes where this
 * one stopped. */
const AUDIT_LIMIT = 20;
/** Re-audit cadence for a held survey: a proof verdict can flip without the
 * raw count moving, so no trigger would ever fire. */
const AUDIT_RECHECK_MS = 24 * 60 * 60 * 1000;
/** Failure backoff, from one cron interval to the recheck cadence. */
const AUDIT_RETRY_BASE_MS = 5 * 60 * 1000;
const AUDIT_RETRY_MAX_MS = 24 * 60 * 60 * 1000;
/** Failures (~21 h) after which a decided survey concedes. Only a decided one:
 * a held survey is still changing, so giving up on it would re-create the
 * frozen-count bug this scheduling exists to kill. */
const MAX_AUDIT_ATTEMPTS = 8;
/** Pending answers one run polls, oldest first: pass 4 spends one request per
 * distinct transaction, so an unpolled backlog must not be able to walk the
 * Worker's subrequest budget. What is left over waits one cron interval. */
const SETTLE_LIMIT = 50;
/** Response pages one bundle collection reads (200 responses each). */
const MAX_BUNDLE_PAGES = 50;
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
  responseCounts: Record<string, number>;
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
    responseCounts: set.responseCounts,
    finalState: set.finalState,
    incomplete: set.incomplete === true,
    fetchedAt: set.fetchedAt,
    wireByKey,
  };
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
            ref: a.key,
            topicId,
            title: surveyTitle(a),
            endEpoch: a.record.definition.endEpoch,
            eligibleRoles: a.record.definition.eligibleRoles,
            sealed: a.sealed,
            cancelled: a.cancelled,
            externalContent: a.external,
            definitionJson: wire,
            claimedCount: set.responseCounts[a.key] ?? 0,
            finalState: set.finalState[a.key]?.state ?? null,
            tipEpoch: set.tip.epoch,
            tesseraFetchedAt: set.fetchedAt,
            submittedAt: recordUnixMs(a.record.slot, set.tip),
            now,
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

/**
 * Collect one survey's full bundle: every response page plus the merged proof
 * verdicts. A bundle is a tally input, so a `resync` (the snapshot moved
 * between pages) restarts the collection rather than stitching two snapshots.
 * Returns null when the backend lost its snapshot mid-run.
 */
async function collectBundle(
  tessera: SurveysTessera,
  key: string,
): Promise<{ record: SurveyRecord; responses: ResponseRecord[]; verdicts: ProofVerdicts } | null> {
  for (let attempt = 0; ; attempt++) {
    let cursor: string | undefined;
    let record: SurveyRecord | null = null;
    const responses: ResponseRecord[] = [];
    const verdicts: Record<string, boolean> = {};
    let resync = false;
    for (let page = 0; page < MAX_BUNDLE_PAGES; page++) {
      const result = await tessera.surveyBundle(key, cursor);
      if (!result.ready) return null;
      if (result.value.resync) {
        resync = true;
        break;
      }
      record ??= fromJsonSafe(result.value.survey) as SurveyRecord;
      responses.push(...result.value.responses.map(w => fromJsonSafe(w) as ResponseRecord));
      Object.assign(verdicts, result.value.verdicts);
      if (result.value.nextCursor === null) return record ? { record, responses, verdicts } : null;
      cursor = result.value.nextCursor;
    }
    if (!resync || attempt >= MAX_RESYNC_RESTARTS) {
      throw new Error(`bundle collection for ${key} did not converge`);
    }
  }
}

export async function syncSurveys(deps: SurveysSyncDeps): Promise<SurveysSyncResult> {
  const { db, tessera, now } = deps;
  const counters = { admitted: 0, failed: 0 };
  let refreshed = 0;
  let rolledBack = 0;
  let audited = 0;
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
      audited: 0,
      settled: 0,
      failed: 0,
    };
  }
  const walkTriggered =
    page1.value.nextCursor !== null &&
    (page1.value.counts.linked !== state.linkedCount ||
      (await hasActionsCreatedSince(db, state.lastFullWalkAt ?? 0)) ||
      now - (state.lastFullWalkAt ?? 0) > BACKSTOP_MS);

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
        return { notReady: true, ...counters, refreshed, rolledBack, audited, settled };
      }
      // Read before the page is used for anything: `resync` says the snapshot
      // moved under the cursor, so these rows belong to a generation this walk
      // is abandoning — and a stale answer is served best-effort, so its
      // terminal cursor is not this generation's end either. Taking it would
      // stamp last_full_walk_at over a walk that skipped whatever crossed a
      // keyset boundary. Restart from a fresh page one instead.
      if (page.value.resync) break;
      if (n === 0) walkedCount = page.value.counts.linked;
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
  if (completeWalk) {
    await putSurveySyncState(db, { ...state, linkedCount: walkedCount, lastFullWalkAt: now });
  }

  // --- Pass 2: refresh every held (not-yet-final) survey by explicit refs,
  // rolled-back detection included.
  try {
    const held = await getHeldSurveys(db, now - UNAVAILABLE_TTL_MS);
    for (let i = 0; i < held.length; i += MAX_REFS_PER_CALL) {
      const chunk = held.slice(i, i + MAX_REFS_PER_CALL);
      const byRef = new Map(chunk.map(h => [h.ref, h]));
      const result = await tessera.surveysByRefs(chunk.map(h => h.ref));
      if (!result.ready) break;
      const set = decodeSet(result.value);
      const present = new Set(set.aggregates.map(a => a.key));
      // D1's 100-bind cap is per statement, not summed across a batch, and the
      // widest statement here binds 9 — so one chunk's refreshes commit as a
      // single batch, keeping the whole page's rewrite atomic. An empty answer
      // (every held ref rolled back) yields no statements: D1 rejects an empty
      // batch, so it must not be issued.
      const refreshStatements = set.aggregates.flatMap(a => {
        const h = byRef.get(a.key);
        const claimedCount = set.responseCounts[a.key] ?? 0;
        const finalState = set.finalState[a.key]?.state ?? null;
        // Every row here was held, so any non-null finalState is its
        // arrival — and it must trigger an audit rather than freeze the
        // stored count, because verdicts land late: a proof verdict can
        // still flip a counted response after the count itself settles.
        // A ref that was unavailable and is answered again triggers too: its
        // bundle 404'd for as long as it was gone, so the count on the row
        // predates the rollback and the backoff those failures built describes
        // a survey that was absent, not this one.
        const triggered =
          h !== undefined &&
          (h.unavailable ||
            claimedCount !== h.claimedCount ||
            (h.tipEpoch <= h.endEpoch && set.tip.epoch > h.endEpoch) ||
            finalState !== null);
        return [
          buildRefreshSurvey(db, {
            ref: a.key,
            claimedCount,
            cancelled: a.cancelled,
            finalState,
            auditDueAt: triggered ? now : null,
            tipEpoch: set.tip.epoch,
            tesseraFetchedAt: set.fetchedAt,
            now,
          }),
          buildDeleteGovLinks(db, a.key),
          ...a.govLinks.map(l => buildInsertGovLink(db, a.key, l.actionId, l.title)),
        ];
      });
      if (refreshStatements.length > 0) await db.batch(refreshStatements);
      refreshed += set.aggregates.length;
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
  } catch (err) {
    console.error('[surveys] refresh pass failed', err);
    counters.failed++;
  }

  // --- Pass 3: audit counts through Tessera's published auditResponses, for
  // every survey whose audit is due. Every outcome is persisted on the row, so
  // a crashed or snapshot-less run leaves those surveys simply due again. A
  // 404 says the survey is outside Tessera's corpus right now, which is the
  // same thing pass 2 records as a rollback and not proof it is gone: the
  // settlement window can bring the record back, which is why a rolled-back
  // row keeps its refresh slot for four days. The audit schedule follows that
  // lifecycle — a held row backs off and retries until it retires out of the
  // due set, and only a decided one, whose count can no longer be confirmed,
  // concedes.
  try {
    for (const due of await getAuditDueSurveys(db, now, now - UNAVAILABLE_TTL_MS, AUDIT_LIMIT)) {
      try {
        const bundle = await collectBundle(tessera, due.ref);
        if (!bundle) break;
        const audit = auditResponses(bundle.responses, bundle.record.definition, bundle.verdicts);
        const counted = audit.counted.filter(r => r.response.role === Role.DRep).length;
        const nextDueAt = due.finalState === null ? now + AUDIT_RECHECK_MS : null;
        await markSurveyAudited(db, due.ref, counted, nextDueAt, now);
        audited++;
      } catch (err) {
        console.error(`[surveys] audit failed for ${due.ref}`, err);
        counters.failed++;
        const gone = err instanceof TesseraHttpError && err.status === 404;
        if (due.finalState !== null && (gone || due.auditAttempts + 1 >= MAX_AUDIT_ATTEMPTS)) {
          await concedeSurveyAudit(db, due.ref, now);
        } else {
          const backoff = Math.min(AUDIT_RETRY_BASE_MS * 2 ** due.auditAttempts, AUDIT_RETRY_MAX_MS);
          await markSurveyAuditFailed(db, due.ref, now + backoff, now);
        }
      }
    }
  } catch (err) {
    console.error('[surveys] audit pass failed', err);
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

  return { notReady: false, ...counters, refreshed, rolledBack, audited, settled };
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
