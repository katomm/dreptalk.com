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
  batchByBinds,
  buildDeleteGovLinks,
  buildInsertGovLink,
  buildInsertSurvey,
  buildRefreshSurvey,
  deleteLocalSurveyResponse,
  getHeldSurveys,
  getKnownSurveyRefs,
  getPendingSurveyResponses,
  getSurveySyncState,
  type HeldSurvey,
  markStaleSurveyResponsesFailed,
  markSurveysUnavailable,
  putSurveySyncState,
  updateCountedDreps,
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
  /** Pending local answers aged to 'failed' past the confirmation cutoff. */
  agedFailed: number;
  failed: number;
}

/** Walk the whole linked list / re-audit every held survey at most daily. */
const BACKSTOP_MS = 24 * 60 * 60 * 1000;
/** Hard cap on list pages one run walks (paranoia bound, 200 surveys each). */
const MAX_LIST_PAGES = 25;
/** Bundle audits per run, so a daily re-audit of a large held set spreads over
 * a few runs instead of stretching one cron invocation. */
const AUDIT_LIMIT = 20;
/** Response pages one bundle collection reads (200 responses each). */
const MAX_BUNDLE_PAGES = 50;
/** Restarts a page walk tolerates when the snapshot moves mid-walk (resync). */
const MAX_RESYNC_RESTARTS = 2;

/** Binds of the per-survey statement groups batchByBinds packs (see db/surveys.ts). */
const REFRESH_BINDS = 7;
const DELETE_LINKS_BINDS = 1;
const LINK_BINDS = 3;

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
 * include an imported action. Returns the admitted keys. */
async function admitFromSet(
  deps: SurveysSyncDeps,
  set: DecodedSet,
  known: Set<string>,
  counters: { admitted: number; failed: number },
): Promise<string[]> {
  const { db, now, rand } = deps;
  const actionIds = [...new Set(set.aggregates.flatMap(a => a.govLinks.map(l => l.actionId)))];
  const imported = await getKnownProposalIds(db, actionIds);
  const admittedKeys: string[] = [];
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
      admittedKeys.push(a.key);
      counters.admitted++;
    } catch (err) {
      console.error(`[surveys] admission failed for ${a.key}`, err);
      counters.failed++;
    }
  }
  return admittedKeys;
}

/** Keys due an audit after a refresh: the raw count moved, or the tip crossed
 * the survey's end epoch this refresh (verdicts land late — a count can be
 * final while a proof verdict still flips a counted response). */
function auditTriggers(held: HeldSurvey[], set: DecodedSet): string[] {
  const byRef = new Map(held.map(h => [h.ref, h]));
  const due: string[] = [];
  for (const a of set.aggregates) {
    const h = byRef.get(a.key);
    if (!h) continue;
    const newCount = set.responseCounts[a.key] ?? 0;
    const crossed = h.tipEpoch <= h.endEpoch && set.tip.epoch > h.endEpoch;
    if (newCount !== h.claimedCount || crossed) due.push(a.key);
  }
  return due;
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
  let agedFailed = 0;

  const state = await getSurveySyncState(db);
  const known = await getKnownSurveyRefs(db);
  const auditQueue = new Set<string>();

  // --- Pass 1: discover. Page one of ?filter=linked re-evaluates the whole
  // linked set while it fits (counts.linked sizes the universe); walk further
  // only when the count moved, an action was imported since the last complete
  // walk (the DRepTalk half of an admission turning true late), or the daily
  // backstop is due.
  const page1 = await tessera.surveyList({ filter: 'linked', limit: MAX_REFS_PER_CALL });
  if (!page1.ready) {
    return {
      notReady: true,
      admitted: 0,
      refreshed: 0,
      rolledBack: 0,
      audited: 0,
      settled: 0,
      agedFailed: 0,
      failed: 0,
    };
  }
  const linkedCount = page1.value.counts.linked;
  const walkTriggered =
    page1.value.nextCursor !== null &&
    (linkedCount !== state.linkedCount ||
      (await hasActionsCreatedSince(db, state.lastFullWalkAt ?? 0)) ||
      now - (state.lastFullWalkAt ?? 0) > BACKSTOP_MS);

  let completeWalk = false;
  for (let restart = 0; restart <= MAX_RESYNC_RESTARTS && !completeWalk; restart++) {
    let page =
      restart === 0
        ? page1
        : await tessera.surveyList({ filter: 'linked', limit: MAX_REFS_PER_CALL });
    for (let n = 0; n < MAX_LIST_PAGES; n++) {
      if (!page.ready) {
        return { notReady: true, ...counters, refreshed, rolledBack, audited, settled, agedFailed };
      }
      for (const key of await admitFromSet(deps, decodeSet(page.value), known, counters)) {
        auditQueue.add(key);
      }
      if (page.value.nextCursor === null) {
        completeWalk = true;
        break;
      }
      if (!walkTriggered) break;
      // A resync flag means the snapshot moved under the cursor; restart the
      // walk so no survey is skipped across the generation boundary.
      if (page.value.resync) break;
      page = await tessera.surveyList({
        filter: 'linked',
        limit: MAX_REFS_PER_CALL,
        cursor: page.value.nextCursor,
      });
    }
    if (!walkTriggered) break;
  }
  if (completeWalk) {
    await putSurveySyncState(db, { ...state, linkedCount, lastFullWalkAt: now });
  }

  // --- Pass 2: refresh every held (not-yet-final) survey by explicit refs,
  // rolled-back detection included. Just-admitted rows are current already.
  try {
    const held = (await getHeldSurveys(db)).filter(h => !auditQueue.has(h.ref));
    for (let i = 0; i < held.length; i += MAX_REFS_PER_CALL) {
      const chunk = held.slice(i, i + MAX_REFS_PER_CALL);
      const result = await tessera.surveysByRefs(chunk.map(h => h.ref));
      if (!result.ready) break;
      const set = decodeSet(result.value);
      for (const key of auditTriggers(chunk, set)) auditQueue.add(key);
      const present = new Set(set.aggregates.map(a => a.key));
      await batchByBinds(
        db,
        set.aggregates.map(a => ({
          statements: [
            buildRefreshSurvey(db, {
              ref: a.key,
              claimedCount: set.responseCounts[a.key] ?? 0,
              cancelled: a.cancelled,
              finalState: set.finalState[a.key]?.state ?? null,
              tipEpoch: set.tip.epoch,
              tesseraFetchedAt: set.fetchedAt,
              now,
            }),
            buildDeleteGovLinks(db, a.key),
            ...a.govLinks.map(l => buildInsertGovLink(db, a.key, l.actionId, l.title)),
          ],
          binds: REFRESH_BINDS + DELETE_LINKS_BINDS + a.govLinks.length * LINK_BINDS,
        })),
      );
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
      // Rows whose audited count never landed (an earlier failed audit) retry.
      for (const h of chunk) {
        if (h.countedDreps === null && present.has(h.ref)) auditQueue.add(h.ref);
      }
    }
  } catch (err) {
    console.error('[surveys] refresh pass failed', err);
    counters.failed++;
  }

  // --- Pass 3: audit counts. Recompute counted_dreps through Tessera's
  // published auditResponses for the queued surveys, plus everything held on
  // the daily re-audit. Capped per run; an uncapped daily pass keeps its due
  // flag so the next run continues.
  const dailyAudit = now - (state.lastAuditAt ?? 0) > BACKSTOP_MS;
  try {
    if (dailyAudit) {
      for (const h of await getHeldSurveys(db)) {
        if (!h.unavailable) auditQueue.add(h.ref);
      }
    }
    const queue = [...auditQueue];
    for (const key of queue.slice(0, AUDIT_LIMIT)) {
      try {
        const bundle = await collectBundle(tessera, key);
        if (!bundle) break;
        const audit = auditResponses(bundle.responses, bundle.record.definition, bundle.verdicts);
        const counted = audit.counted.filter(r => r.response.role === Role.DRep).length;
        await updateCountedDreps(db, key, counted, now);
        audited++;
      } catch (err) {
        console.error(`[surveys] audit failed for ${key}`, err);
        counters.failed++;
      }
    }
    if (dailyAudit && queue.length <= AUDIT_LIMIT) {
      await putSurveySyncState(db, { ...(await getSurveySyncState(db)), lastAuditAt: now });
    }
  } catch (err) {
    console.error('[surveys] audit pass failed', err);
    counters.failed++;
  }

  // --- Pass 4: settle optimistic local answers by exact transaction. A row
  // whose tx Tessera has indexed *with a response for this survey* is done —
  // the on-chain record supersedes it (and, being tx-exact, a replacement is
  // observable where /api/responded would hide it). A well-formed unindexed
  // hash answers 200 with an empty list ("submitted, not indexed yet" is the
  // state this pass polls), so an empty answer just leaves the row pending;
  // past the same cutoff the GA-vote sweep uses, a pending row turns 'failed'
  // and the card invites answering again. The overlay never claims validity:
  // "counted" is only knowable at finalization.
  try {
    const pending = await getPendingSurveyResponses(db);
    const byTx = new Map<string, typeof pending>();
    for (const row of pending) {
      const rows = byTx.get(row.txHash);
      if (rows) rows.push(row);
      else byTx.set(row.txHash, [row]);
    }
    for (const [txHash, rows] of byTx) {
      const result = await tessera.responsesByTx(txHash);
      if (!result.ready) break;
      const answered = new Set(result.value.map(r => r.surveyKey));
      for (const row of rows) {
        if (answered.has(row.surveyRef)) {
          await deleteLocalSurveyResponse(db, row.surveyRef, row.userId);
          settled++;
        }
      }
    }
    agedFailed = await markStaleSurveyResponsesFailed(db, now - PENDING_VOTE_TTL_SEC * 1000);
  } catch (err) {
    console.error('[surveys] settle pass failed', err);
    counters.failed++;
  }

  return { notReady: false, ...counters, refreshed, rolledBack, audited, settled, agedFailed };
}
