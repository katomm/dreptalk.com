// CIP-179 surveys sync: mirror Tessera's answers about eligible surveys into
// D1 and open one system thread per survey a linking action imported here
// entitles to one. DRepTalk implements no CIP-179 rule of its own: records
// arrive decoded by cardano-tessera-client, lifecycle/cancellation come from
// cip-179's published aggregate(), and both participation figures are
// Tessera's own: the index's audited per-role count while a survey is open,
// the finalized tally artifact's DRep responders once it is decided. Nothing
// here counts a response.
//
// The mirror is Tessera's change selection: every run asks once for what
// moved since its cursor: each survey whose projection changed (a new
// record, a count, a link, a cancellation, a decision) and each key removed,
// and the first run asks the same of instant zero, which is the whole corpus.
// A delta row is the survey's complete state and every delivered row is a
// moved row, so the mirror needs no memory of its own: it writes down what
// Tessera's half of admission (./admission.ts) passes, whether or not the
// thread can open yet, and withdraws what it refuses. The thread
// is DRepTalk's half, decided over the stored rows after every discovery,
// from the row alone: the one fact Tessera cannot re-deliver, an action
// imported here, is the one no verdict on an answer depends on.

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
  buildPublishSurvey,
  buildUpsertSurvey,
  getPublishableSurveys,
  getSurveySyncState,
  getSurveysAwaitingFinalCount,
  type NewSurvey,
  type PublishableSurvey,
  putSurveySyncState,
  setSurveyFinalCount,
  withdrawSurveys,
} from '../db/surveys.js';
import { GOV_SYNC_AUTHOR } from '../governance/sync.js';
import { renderMarkdown } from '../markdown.js';
import { MAX_EXTERNAL_TITLE_LEN, sanitizeExternalText } from '../validation/input.js';
import { eligibleSurvey } from './admission.js';
import { parseSurveyDefinition, roleLabels, surveyDescription, surveyTitle } from './view.js';

export type SurveysTessera = Pick<TesseraClient, 'changes' | 'changesSince' | 'artifactByHash'>;

export interface SurveysSyncDeps {
  db: D1Database;
  tessera: SurveysTessera;
  now: number;
  /** Slug-suffix source (injected for deterministic tests). */
  rand: () => string;
}

export interface SurveysSyncResult {
  /** Backend had no snapshot yet. Nothing ran. */
  notReady: boolean;
  /** Rows written this run: one per delivered survey the mirror admits,
   * stored the first time and rewritten after. A quiet tick writes none. */
  written: number;
  /** Threads opened this run, for stored surveys a linking action now imported entitles to one. */
  published: number;
  /** Rows withdrawn this run: removed upstream, or listed but no longer
   * eligible, in practice the survey's or the linking action's transaction
   * rolled back. A published row is flagged, one with no thread deleted. */
  rolledBack: number;
  /** Finalized surveys whose artifact count was stored this run. */
  finalCounts: number;
  failed: number;
}

/** Hard cap on delta pages one run applies (200 surveys each). A backlog past
 * it (the first run's bootstrap of a large corpus, or a long outage)
 * continues next run from the cursor the last page handed out, with a
 * warning. The warning is the cue to raise the cap, not something to page
 * around. */
export const MAX_LIST_PAGES = 25;

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
  // aggregate() still takes the finalized-cancelled key set. The wire moved to
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
 * empty entry, a count of zero, not an unknown. */
function countedDreps(set: DecodedSet, key: string): number | null {
  const byRole = set.countedByRole?.[key];
  return byRole ? (byRole[String(Role.DRep)] ?? 0) : null;
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
 * post-Shelley), in unix ms, the thread's post date. */
function recordUnixMs(slot: number, tip: ChainTip): number {
  return (tip.time - (tip.slot - slot)) * 1000;
}

/** A linking action's title as Tessera extracted it from the CIP-108 anchor:
 * untrusted text, held to the survey title's own sanitizer and cap before it
 * is stored, and null once nothing is left. */
function linkTitle(title: string | null): string | null {
  return title === null ? null : sanitizeExternalText(title, MAX_EXTERNAL_TITLE_LEN) || null;
}

/** Applies one delta: the surveys it delivers, and the keys it removed.
 *
 * Every delivered survey Tessera's half of admission passes is written down,
 * with no comparison against what is stored, under the change selection a
 * delivered row *is* a moved row, and a quiet tick delivers none, so the
 * comparison could only save a write when Tessera moved something it reports
 * and this mirror does not keep. What admission refuses is withdrawn instead,
 * beside the keys the delta removed: eligibility failing on a stored survey
 * and its key disappearing are the same event upstream (the record's or the
 * linking action's transaction rolled back), and the withdrawal itself asks
 * the row what to do. Removals go first, as the contract says, so a key
 * removed and re-delivered in one delta ends up stored.
 *
 * The writes commit as one batch. D1's 100-bind cap is per statement, not
 * summed across a batch, and the widest statement here binds 13, so a
 * survey's row and its links are rewritten atomically. A delta with nothing to
 * write must issue no batch at all: D1 rejects an empty one. */
async function applyDelta(
  deps: SurveysSyncDeps,
  set: DecodedSet,
  removed: readonly string[],
): Promise<{ written: number; rolledBack: number }> {
  const { db, now } = deps;
  const withdrawn = [...removed];
  const statements: D1PreparedStatement[] = [];
  let written = 0;
  for (const a of set.aggregates) {
    if (!eligibleSurvey(a)) {
      withdrawn.push(a.key);
      continue;
    }
    const decided = set.finalState[a.key];
    const row: NewSurvey = {
      ref: a.key,
      endEpoch: a.record.definition.endEpoch,
      eligibleRoles: a.record.definition.eligibleRoles,
      sealed: a.sealed,
      cancelled: a.cancelled,
      externalContent: a.external,
      // The record in cip-179's own wire form, the one its decoder reads back
      // on every page view and when the thread opens.
      definitionJson: JSON.stringify(toJsonSafe(a.record)),
      countedDreps: countedDreps(set, a.key),
      finalState: decided?.state ?? null,
      artifactHash: decided && decided.state !== 'untalliable' ? decided.artifactHash : null,
      submittedAt: recordUnixMs(a.record.slot, set.tip),
      now,
    };
    statements.push(
      buildUpsertSurvey(db, row),
      buildDeleteGovLinks(db, a.key),
      ...a.govLinks.map(l => buildInsertGovLink(db, a.key, l.actionId, linkTitle(l.title))),
    );
    written++;
  }
  const rolledBack = withdrawn.length > 0 ? await withdrawSurveys(db, withdrawn, now) : 0;
  if (statements.length > 0) await db.batch(statements);
  return { written, rolledBack };
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
    title: surveyTitle(def, p.ref),
    bodyMd,
    bodyHtml: renderMarkdown(bodyMd),
    source: 'survey',
    now,
    postedAt: p.submittedAt,
    rand: rand(),
    batchWith: topicId => [buildPublishSurvey(db, p.ref, topicId)],
  });
}

export async function syncSurveys(deps: SurveysSyncDeps): Promise<SurveysSyncResult> {
  const { db, tessera, now } = deps;
  const state = await getSurveySyncState(db);
  let written = 0;
  let published = 0;
  let rolledBack = 0;
  let finalCounts = 0;
  let failed = 0;
  const result = (notReady: boolean): SurveysSyncResult => ({
    notReady,
    written,
    published,
    rolledBack,
    finalCounts,
    failed,
  });

  /** The generation the last applied delta was read at. Each page is read at
   * whatever generation is published when its request arrives, and the cursor
   * is a keyset, so a row re-stamped after an earlier page is delivered again
   * on a later one: a run that reaches the end reflects its last page, not its
   * first. */
  let asOf: number | null = null;

  // --- Pass 1: the mirror. The delta since the cursor, to its end, or,
  // while there is no cursor, the delta since instant zero, which is the whole
  // corpus delivered the same way, tombstones included, and hands out an
  // ordinary cursor to continue from. A cursor never expires (the backend
  // keeps its tombstones for the life of the corpus), so a delta always
  // continues. Isolated like the passes after it: an answer that fails to
  // apply must not cost this tick its threads or its final counts.
  let cursor = state.changesCursor;
  /** The mirror reflects `asOf` after this pass: the delta was applied to its
   * end. */
  let mirrorComplete = false;
  try {
    for (let n = 0; n < MAX_LIST_PAGES; n++) {
      const answer =
        cursor === null
          ? await tessera.changesSince(0, MAX_PAGE_LIMIT)
          : await tessera.changes(cursor, MAX_PAGE_LIMIT);
      if (!answer.ready) return result(true);
      const delta = answer.body;
      const set = decodeSet(delta);
      const applied = await applyDelta(deps, set, delta.removed);
      written += applied.written;
      rolledBack += applied.rolledBack;
      if (set.fetchedAt !== null) asOf = set.fetchedAt;
      cursor = delta.nextCursor;
      // A short answer on both axes is one that reached the published
      // generation. A full one may have more behind it.
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
    failed++;
  }

  // The mirror's bookkeeping, one row: where the delta continues, and the
  // snapshot the rows now reflect. The "as of" advances only when the delta
  // was applied to its end. A run that broke off leaves rows describing an
  // older snapshot, and the line must not promise fresher.
  await putSurveySyncState(db, {
    changesCursor: cursor,
    tesseraFetchedAt: mirrorComplete && asOf !== null ? asOf : state.tesseraFetchedAt,
  });

  // --- Pass 2: publish. DRepTalk's half of admission, asked of the stored
  // rows now that discovery has run: every survey without a thread that an
  // imported action links gets one, from its row, with no request to Tessera.
  // Normally the survey stored a moment ago by pass 1, its action was
  // imported minutes before, and otherwise one whose action arrived late.
  // Either way the row is already there, so a thread that fails to open is
  // simply still pending on the next run.
  try {
    for (const p of await getPublishableSurveys(db)) {
      try {
        await publish(deps, p);
        published++;
      } catch (err) {
        console.error(`[surveys] publishing ${p.ref} failed`, err);
        failed++;
      }
    }
  } catch (err) {
    console.error('[surveys] publish pass failed', err);
    failed++;
  }

  // --- Pass 3: the final count of every finalized survey whose artifact has
  // not been read, normally the one whose decision pass 1 just wrote, plus
  // any whose artifact request failed on an earlier run. The artifact's DRep
  // responders are the responses counted at close, after the end-epoch role
  // membership the in-window count cannot apply. A role with no counted
  // responder is absent from it, so absence reads as zero. Each survey is its
  // own request and its own failure: one that fails is simply still awaiting
  // on the next run, and a hash the list named is one the backend published,
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
        failed++;
      }
    }
  } catch (err) {
    console.error('[surveys] final count pass failed', err);
    failed++;
  }

  return result(false);
}
