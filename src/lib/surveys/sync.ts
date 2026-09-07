// CIP-179 surveys sync: mirror Tessera's answers about eligible surveys into
// D1 and open one system thread per survey a linking action imported here
// entitles to one. DRepTalk implements no CIP-179 rule of its own — records
// arrive decoded by cardano-tessera-client, lifecycle/cancellation come from
// cip-179's published aggregate(), and both participation figures are
// Tessera's own: the index's audited per-role count while a survey is held,
// the finalized tally artifact's DRep responders once it is decided. Nothing
// here counts a response.
//
// The mirror is Tessera's change selection: every run asks once for what
// moved since its cursor — each survey whose projection changed (a new
// record, a count, a link, a cancellation, a decision) and each key removed —
// and the first run asks the same of instant zero, which is the whole corpus.
// A delta row is the survey's complete state, so the mirror stores what
// Tessera's half of admission (./admission.ts) passes, whether or not the
// thread can open yet, and withdraws a held row on its negation. The thread
// is DRepTalk's half, decided over the stored rows after every discovery,
// from the row alone: the one fact Tessera cannot re-deliver — an action
// imported here — is the one no verdict on an answer depends on.

import {
  MAX_PAGE_LIMIT,
  type SurveyChangesPayload,
  type SurveyListPayload,
  type TesseraClient,
} from 'cardano-tessera-client';
import { Role, type SurveyDefinition } from 'cip-179';
import { aggregate, type ChainTip, type SurveyAggregate } from 'cip-179/domain';
import { toJsonSafe } from 'cip-179/tally';
import { SURVEYS_CATEGORY_SLUG } from '../../../config/categories.js';
import { createTopic } from '../db/forum.js';
import {
  buildDeleteGovLinks,
  buildInsertGovLink,
  buildInsertSurvey,
  buildPublishSurvey,
  buildRefreshSurvey,
  deleteLocalSurveyResponse,
  deleteSurveys,
  getHeldSurveys,
  getKnownSurveyRefs,
  getPublishableSurveys,
  getSettleableSurveyResponses,
  getSurveySyncState,
  getSurveysAwaitingFinalCount,
  type HeldSurvey,
  markStaleSurveyResponsesFailed,
  markSurveysUnavailable,
  type PublishableSurvey,
  putSurveySyncState,
  type SurveyRefresh,
  setSurveyFinalCount,
} from '../db/surveys.js';
import { GOV_SYNC_AUTHOR } from '../governance/sync.js';
import { PENDING_VOTE_TTL_SEC } from '../governance/tallySync.js';
import { renderMarkdown } from '../markdown.js';
import { eligibleSurvey } from './admission.js';
import { parseSurveyDefinition, roleLabels, surveyDescription, surveyTitle } from './view.js';

export type SurveysTessera = Pick<
  TesseraClient,
  'changes' | 'changesSince' | 'artifactByHash' | 'responsesByTx'
>;

export interface SurveysSyncDeps {
  db: D1Database;
  tessera: SurveysTessera;
  now: number;
  /** Slug-suffix source (injected for deterministic tests). */
  rand: () => string;
}

export interface SurveysSyncResult {
  /** Backend had no snapshot yet; nothing ran. */
  notReady: boolean;
  /** Surveys mirrored this run — a row, no thread yet. */
  stored: number;
  /** Threads opened this run, for stored surveys a linking action now imported entitles to one. */
  published: number;
  /** Held rows one of whose stored values the answer moved (an unchanged row costs no write). */
  refreshed: number;
  /** Rows withdrawn this run: removed upstream, or listed but no longer
   * eligible — in practice the survey's or the linking action's transaction
   * rolled back. A published row is flagged, one with no thread deleted. */
  rolledBack: number;
  /** Finalized surveys whose artifact count was stored this run. */
  finalCounts: number;
  /** Local answer rows deleted because their exact tx is indexed upstream. */
  settled: number;
  failed: number;
}

/** Hard cap on delta pages one run applies (200 surveys each). A backlog past
 * it — the first run's bootstrap of a large corpus, or a long outage —
 * continues next run from the cursor the last page handed out, with a
 * warning; the cue to raise the cap, not something to page around. */
export const MAX_LIST_PAGES = 25;
/** Local answers one run polls: pass 4 spends one request per distinct
 * transaction, so an unpolled backlog must not be able to walk the Worker's
 * subrequest budget. What is left over waits one cron interval. */
const SETTLE_LIMIT = 50;
/** How long a failed local answer keeps being polled after it was recorded.
 * The confirmation cutoff fails a row on the clock alone, so a transaction
 * that lands late — after an outage longer than the cutoff, say — must still
 * settle it, or the card invites an answer the chain already has. A week
 * outlasts any outage worth recovering from and bounds the polled set. */
const FAILED_POLL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface DecodedSet {
  aggregates: SurveyAggregate[];
  tip: ChainTip;
  countedByRole: SurveyListPayload['countedByRole'];
  finalState: NonNullable<SurveyListPayload['finalState']>;
  /** Snapshot generation (unix s) the answer was served from. */
  fetchedAt: number | null;
}

/** One delta as Tessera-computed aggregates. */
function decodeSet(set: SurveyChangesPayload): DecodedSet {
  const finalState = set.finalState ?? {};
  // aggregate() still takes the finalized-cancelled key set; the wire moved to
  // the richer finalState map, so the caller derives the set it wants.
  const finalizedCancelled = new Set(
    Object.entries(finalState)
      .filter(([, v]) => v.state === 'cancelled')
      .map(([k]) => k),
  );
  return {
    aggregates: aggregate(
      set.surveys,
      set.cancellations,
      set.responseCounts,
      set.tip,
      set.govLinks,
      finalizedCancelled,
    ),
    tip: set.tip,
    countedByRole: set.countedByRole,
    finalState,
    fetchedAt: set.fetchedAt ?? null,
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
    artifactHash: decided && decided.state !== 'untalliable' ? decided.artifactHash : null,
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

/** Opening post, rendered through the same sanitizing markdown path as
 * governance threads (the description is untrusted on-chain data, capped
 * like an action's abstract before it gets there). */
function composeFirstPostMd(def: SurveyDefinition, external: boolean): string {
  const roles = roleLabels(def.eligibleRoles);
  const description = surveyDescription(def);
  const lines: string[] = ['**On-chain CIP-179 survey.**', ''];
  if (external) {
    lines.push('The survey text lives in an external document that is not loaded here.', '');
  } else if (description) {
    lines.push(description, '');
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
function recordUnixMs(slot: number, tip: ChainTip): number {
  return (tip.time - (tip.slot - slot)) * 1000;
}

/** The mirror's working set for one run, kept current as answers are applied
 * so a survey two answers name in the same run is compared against what the
 * first one wrote. */
interface Mirror {
  /** Every stored survey, ref → published (has a thread). */
  known: Map<string, boolean>;
  held: Map<string, HeldSurvey>;
  stored: number;
  published: number;
  refreshed: number;
  rolledBack: number;
  failed: number;
}

/** What the mirror remembers of a row it just wrote, while the survey is
 * still undecided; a decided row cannot move, so nothing is kept for it. */
function heldOf(values: SurveyRefresh, links: Map<string, string | null>): HeldSurvey | null {
  return values.finalState === null
    ? {
        ref: values.ref,
        countedDreps: values.countedDreps,
        cancelled: values.cancelled,
        unavailable: false,
        links,
      }
    : null;
}

/** Withdraws the rows the latest answer no longer lists as eligible — a
 * rolled-back record, links gone, a key removed upstream — by what there is
 * to preserve. A published row keeps its thread and takes the flag, once: a
 * withdrawn row stays withdrawn until presence clears it. A row with no
 * thread is deleted; a removal that was advisory delivers it again. Keys the
 * mirror never stored are ignored, so a delta's removals go through as is. */
async function withdraw(deps: SurveysSyncDeps, refs: readonly string[], m: Mirror): Promise<void> {
  const deleted = refs.filter(ref => m.known.get(ref) === false);
  const flagged = refs.filter(
    ref => m.known.get(ref) === true && m.held.get(ref)?.unavailable === false,
  );
  if (deleted.length > 0) {
    await deleteSurveys(deps.db, deleted);
    for (const ref of deleted) {
      m.known.delete(ref);
      m.held.delete(ref);
    }
  }
  if (flagged.length > 0) {
    await markSurveysUnavailable(deps.db, flagged, deps.now);
    for (const ref of flagged) {
      const h = m.held.get(ref);
      if (h) m.held.set(ref, { ...h, unavailable: true, links: new Map() });
    }
  }
  m.rolledBack += deleted.length + flagged.length;
}

/** Applies one answer to the mirror: held rows are refreshed where a stored
 * value moved and withdrawn where eligibility no longer holds; unknown
 * eligible surveys are stored, thread or no thread. One answer commits as a
 * single batch — D1's 100-bind cap is per statement, not summed across a
 * batch, and the widest statement here binds 13 — so its rewrite is atomic.
 * An answer that moved nothing yields no statements: D1 rejects an empty
 * batch, so it must not be issued. */
async function applySet(deps: SurveysSyncDeps, set: DecodedSet, m: Mirror): Promise<void> {
  const { db, now } = deps;
  const statements: D1PreparedStatement[] = [];
  const refreshed = new Map<string, HeldSurvey | null>();
  const stored = new Map<string, HeldSurvey | null>();
  const withdrawn: string[] = [];
  for (const a of set.aggregates) {
    const h = m.held.get(a.key);
    if (h) {
      if (!eligibleSurvey(a)) {
        withdrawn.push(a.key);
        continue;
      }
      const next = rowValues(set, a, now);
      const links = new Map(a.govLinks.map(l => [l.actionId, l.title]));
      if (!refreshChanged(h, next, links)) continue;
      statements.push(
        buildRefreshSurvey(db, next),
        buildDeleteGovLinks(db, a.key),
        ...a.govLinks.map(l => buildInsertGovLink(db, a.key, l.actionId, l.title)),
      );
      refreshed.set(a.key, heldOf(next, links));
    } else if (!m.known.has(a.key) && eligibleSurvey(a)) {
      const values = rowValues(set, a, now);
      statements.push(
        buildInsertSurvey(db, {
          ...values,
          title: surveyTitle(a.record.definition, a.key),
          endEpoch: a.record.definition.endEpoch,
          eligibleRoles: a.record.definition.eligibleRoles,
          sealed: a.sealed,
          externalContent: a.external,
          // The record in cip-179's own wire form, the one its decoder reads
          // back on every page view and when the thread opens.
          definitionJson: JSON.stringify(toJsonSafe(a.record)),
          submittedAt: recordUnixMs(a.record.slot, set.tip),
        }),
        ...a.govLinks.map(l => buildInsertGovLink(db, a.key, l.actionId, l.title)),
      );
      stored.set(a.key, heldOf(values, new Map(a.govLinks.map(l => [l.actionId, l.title]))));
    }
  }
  if (statements.length > 0) await db.batch(statements);
  for (const [key, h] of refreshed) {
    if (h) m.held.set(key, h);
    else m.held.delete(key);
  }
  for (const [key, h] of stored) {
    m.known.set(key, false);
    if (h) m.held.set(key, h);
  }
  m.refreshed += refreshed.size;
  m.stored += stored.size;
  await withdraw(deps, withdrawn, m);
}

/** Opens the thread of one stored survey, from the row alone. The row takes
 * the topic in the same atomic batch as the topic and first post, so a
 * partial write can neither leave an orphan thread for the next run to
 * duplicate nor a published survey without one. The post date is the
 * publication time the row stored, since no tip need be at hand: the survey
 * may be waiting on an action imported on a tick whose delta was empty. */
async function publish(deps: SurveysSyncDeps, p: PublishableSurvey): Promise<void> {
  const { db, now, rand } = deps;
  const def = parseSurveyDefinition(p.definitionJson);
  if (def === null) throw new Error('stored record does not decode');
  const bodyMd = composeFirstPostMd(def, p.externalContent);
  await createTopic(db, {
    categorySlug: SURVEYS_CATEGORY_SLUG,
    authorId: GOV_SYNC_AUTHOR,
    title: p.title,
    bodyMd,
    bodyHtml: renderMarkdown(bodyMd),
    source: 'survey',
    now,
    postedAt: p.submittedAt ?? now,
    rand: rand(),
    batchWith: topicId => [buildPublishSurvey(db, p.ref, topicId)],
  });
}

export async function syncSurveys(deps: SurveysSyncDeps): Promise<SurveysSyncResult> {
  const { db, tessera, now } = deps;
  const state = await getSurveySyncState(db);
  const m: Mirror = {
    known: await getKnownSurveyRefs(db),
    held: new Map((await getHeldSurveys(db)).map(h => [h.ref, h])),
    stored: 0,
    published: 0,
    refreshed: 0,
    rolledBack: 0,
    failed: 0,
  };
  let finalCounts = 0;
  let settled = 0;
  const result = (notReady: boolean): SurveysSyncResult => ({
    notReady,
    stored: m.stored,
    published: m.published,
    refreshed: m.refreshed,
    rolledBack: m.rolledBack,
    finalCounts,
    settled,
    failed: m.failed,
  });

  /** The oldest generation any row was written from this run: what the "as
   * of" line may claim once every held row reflects it. */
  let asOf: number | null = null;
  const used = (set: DecodedSet) => {
    if (set.fetchedAt !== null)
      asOf = asOf === null ? set.fetchedAt : Math.min(asOf, set.fetchedAt);
  };

  // --- Pass 1: the mirror. The delta since the cursor, to its end — or,
  // while there is no cursor, the delta since instant zero, which is the whole
  // corpus delivered the same way, tombstones included, and hands out an
  // ordinary cursor to continue from. A cursor never expires (the backend
  // keeps its tombstones for the life of the corpus), so a delta always
  // continues. Isolated like the passes after it: an answer that fails to
  // apply must not cost the pending answers their poll for the whole tick.
  let cursor = state.changesCursor;
  /** Every held row reflects `asOf` after this pass: the delta was applied
   * to its end. */
  let mirrorComplete = false;
  try {
    for (let n = 0; n < MAX_LIST_PAGES; n++) {
      const answer =
        cursor === null
          ? await tessera.changesSince(0, MAX_PAGE_LIMIT)
          : await tessera.changes(cursor, MAX_PAGE_LIMIT);
      if (!answer.ready) return result(true);
      const delta = answer.body;
      // Removals first, as the contract says: a key removed and re-landed
      // in one answer is withdrawn, then stored again by its row.
      await withdraw(deps, delta.removed, m);
      const set = decodeSet(delta);
      await applySet(deps, set, m);
      used(set);
      cursor = delta.nextCursor;
      // A short answer on both axes is one that reached the published
      // generation; a full one may have more behind it.
      if (delta.surveys.length < MAX_PAGE_LIMIT && delta.removed.length < MAX_PAGE_LIMIT) {
        mirrorComplete = true;
        break;
      }
    }
    if (!mirrorComplete) {
      console.warn(`[surveys] change backlog exceeds ${MAX_LIST_PAGES} pages; continued next run`);
    }
  } catch (err) {
    console.error('[surveys] mirror pass failed', err);
    m.failed++;
  }

  // The mirror's bookkeeping, one row: where the delta continues, and the
  // snapshot the held rows now reflect. The "as of" advances only when every
  // held row was brought up to it — a delta that broke off leaves rows
  // describing an older snapshot, and the line must not promise fresher.
  await putSurveySyncState(db, {
    changesCursor: cursor,
    tesseraFetchedAt: mirrorComplete && asOf !== null ? asOf : state.tesseraFetchedAt,
  });

  // --- Pass 2: publish. DRepTalk's half of admission, asked of the stored
  // rows now that discovery has run: every survey without a thread that an
  // imported action links gets one, from its row, with no request to Tessera.
  // Normally the survey stored a moment ago by pass 1 — its action was
  // imported minutes before — and otherwise one whose action arrived late;
  // either way the row is already there, so a thread that fails to open is
  // simply still pending on the next run.
  try {
    for (const p of await getPublishableSurveys(db)) {
      try {
        await publish(deps, p);
        m.known.set(p.ref, true);
        m.published++;
      } catch (err) {
        console.error(`[surveys] publishing ${p.ref} failed`, err);
        m.failed++;
      }
    }
  } catch (err) {
    console.error('[surveys] publish pass failed', err);
    m.failed++;
  }

  // --- Pass 3: the final count of every finalized survey whose artifact has
  // not been read — normally the one whose decision pass 1 just wrote, plus
  // any whose artifact request failed on an earlier run. The artifact's DRep
  // responders are the responses counted at close, after the end-epoch role
  // membership the in-window count cannot apply; a role with no counted
  // responder is absent from it, so absence reads as zero. Each survey is its
  // own request and its own failure: one that fails is simply still awaiting
  // on the next run — and a hash the list named is one the backend published,
  // so an unknown one is a failure, not a state.
  try {
    for (const { ref, artifactHash } of await getSurveysAwaitingFinalCount(db)) {
      try {
        const artifact = await tessera.artifactByHash(artifactHash);
        if (artifact === null) throw new Error(`artifact ${artifactHash} unknown to the backend`);
        const dreps = artifact.tally.perRole.find(r => r.role === Role.DRep);
        await setSurveyFinalCount(db, ref, dreps ? dreps.responders.length : 0, now);
        finalCounts++;
      } catch (err) {
        console.error(`[surveys] final count for ${ref} failed`, err);
        m.failed++;
      }
    }
  } catch (err) {
    console.error('[surveys] final count pass failed', err);
    m.failed++;
  }

  // --- Pass 4: settle optimistic local answers by exact transaction. Matching
  // the transaction, not just the survey, is what makes a replacement visible
  // where /api/responded would hide it. An unindexed hash answers 200 with an
  // empty list — "submitted, not indexed yet" is the state this pass polls —
  // so an empty answer leaves the row pending for reconcileSurveyResponses to
  // age once the cutoff passes. The overlay never claims validity: "counted"
  // is only knowable at finalization.
  try {
    const polled = await getSettleableSurveyResponses(
      db,
      SETTLE_LIMIT,
      now - FAILED_POLL_WINDOW_MS,
    );
    const byTx = new Map<string, typeof polled>();
    for (const row of polled) {
      const rows = byTx.get(row.txHash);
      if (rows) rows.push(row);
      else byTx.set(row.txHash, [row]);
    }
    for (const [txHash, rows] of byTx) {
      try {
        const answer = await tessera.responsesByTx(txHash);
        if (!answer.ready) break;
        // The row is this account's own claim, so settling it needs the
        // response to be the one it claims: same survey, answered as a DRep,
        // by the credential the session derived at record time. One
        // transaction can carry responses to several surveys and in several
        // roles, and a wallet holding more than one DRep credential can answer
        // for another of them — matching the survey alone would clear a row
        // nothing on chain answers.
        const asDrep = answer.body.responses.filter(r => r.role === Role.DRep);
        for (const row of rows) {
          const onChain = asDrep.some(
            r => r.surveyKey === row.surveyRef && r.credential === row.credential,
          );
          if (onChain && (await deleteLocalSurveyResponse(db, row.surveyRef, row.userId, txHash))) {
            settled++;
          }
        }
      } catch (err) {
        // Each transaction is a separate claim: one that errors must not hold
        // back the rows queued behind it, which would otherwise reach their
        // cutoff having never been polled at all.
        console.error(`[surveys] settling ${txHash} failed`, err);
        m.failed++;
      }
    }
  } catch (err) {
    console.error('[surveys] settle pass failed', err);
    m.failed++;
  }

  return result(false);
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
