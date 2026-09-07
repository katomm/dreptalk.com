// CIP-179 surveys sync: mirror Tessera's answers about admitted surveys into
// D1 and open one system thread per admission. DRepTalk implements no CIP-179
// rule of its own — records arrive decoded by cardano-tessera-client,
// lifecycle/cancellation come from cip-179's published aggregate(), and both
// participation figures are Tessera's own: the index's audited per-role count
// while a survey is held, the finalized tally artifact's DRep responders once
// it is decided. Nothing here counts a response.
//
// The mirror is Tessera's change selection. One walk of the linked list
// establishes a cursor; from then on every run asks once for what moved since
// it — each survey whose projection changed (a new record, a count, a link, a
// cancellation, a decision) and each key removed — and applies admission
// (./admission.ts) to every survey named: an unknown one is admitted on it, a
// held one withdrawn on its negation. A miss is re-evaluated when the survey
// moves again; a closed linked survey still gets its thread.

import {
  MAX_PAGE_LIMIT,
  type SurveyChangesPayload,
  type SurveyListPayload,
  type TesseraClient,
} from 'cardano-tessera-client';
import { Role } from 'cip-179';
import { aggregate, type ChainTip, type SurveyAggregate } from 'cip-179/domain';
import { toJsonSafe } from 'cip-179/tally';
import { SURVEYS_CATEGORY_SLUG } from '../../../config/categories.js';
import { createTopic } from '../db/forum.js';
import { getKnownProposalIds } from '../db/governance.js';
import { chunked } from '../db/sql.js';
import {
  buildDeleteGovLinks,
  buildInsertGovLink,
  buildInsertSurvey,
  buildRefreshSurvey,
  deleteLocalSurveyResponse,
  getHeldSurveys,
  getKnownSurveyRefs,
  getSettleableSurveyResponses,
  getSurveySyncState,
  getSurveysAwaitingFinalCount,
  type HeldSurvey,
  markStaleSurveyResponsesFailed,
  markSurveysUnavailable,
  putSurveySyncState,
  type SurveyRefresh,
  setSurveyFinalCount,
} from '../db/surveys.js';
import { GOV_SYNC_AUTHOR } from '../governance/sync.js';
import { PENDING_VOTE_TTL_SEC } from '../governance/tallySync.js';
import { renderMarkdown } from '../markdown.js';
import { admissible, eligibleSurvey } from './admission.js';
import { roleLabels, surveyDescription, surveyTitle } from './view.js';

export type SurveysTessera = Pick<
  TesseraClient,
  'surveys' | 'surveysByRefs' | 'changes' | 'artifactByHash' | 'responsesByTx'
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
  admitted: number;
  /** Held rows one of whose stored values the answer moved (an unchanged row costs no write). */
  refreshed: number;
  /** Held rows withdrawn this run: removed upstream, absent from a complete
   * answer, or present but no longer admissible — in practice the survey's or
   * the linking action's transaction rolled back. */
  rolledBack: number;
  /** Finalized surveys whose artifact count was stored this run. */
  finalCounts: number;
  /** Local answer rows deleted because their exact tx is indexed upstream. */
  settled: number;
  failed: number;
}

/** Hard cap on /api/surveys answers one run applies, a walk's pages or a
 * delta's (200 surveys each). A linked set past it is never walked to the
 * end, so no cursor is ever stored and every run warns; a change backlog past
 * it continues next run. Either is the cue to raise the cap, not something
 * to page around. */
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
/** Restarts a page walk tolerates when the snapshot moves mid-walk (resync). */
const MAX_RESYNC_RESTARTS = 2;

interface DecodedSet {
  aggregates: SurveyAggregate[];
  tip: ChainTip;
  countedByRole: SurveyListPayload['countedByRole'];
  finalState: NonNullable<SurveyListPayload['finalState']>;
  incomplete: boolean;
  /** Snapshot generation (unix s) the answer was served from. */
  fetchedAt: number | null;
}

/** One /api/surveys answer (page, delta or refs) as Tessera-computed aggregates. */
function decodeSet(set: SurveyListPayload | SurveyChangesPayload): DecodedSet {
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
    incomplete: set.incomplete === true,
    fetchedAt: set.fetchedAt ?? null,
  };
}

/** Which of the actions these aggregates link are imported here. */
function importedLinks(db: D1Database, aggregates: readonly SurveyAggregate[]) {
  return getKnownProposalIds(db, [
    ...new Set(aggregates.flatMap(a => a.govLinks.map(l => l.actionId))),
  ]);
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
function composeFirstPostMd(a: SurveyAggregate): string {
  const def = a.record.definition;
  const roles = roleLabels(def.eligibleRoles);
  const description = surveyDescription(def);
  const lines: string[] = ['**On-chain CIP-179 survey.**', ''];
  if (a.external) {
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
  known: Set<string>;
  held: Map<string, HeldSurvey>;
  /** Eligible surveys whose links all name actions not imported (yet). The
   * DRepTalk half of admission turns true with no move on Tessera's side,
   * and a change is delivered once — so these are re-asked by ref each run
   * until admission holds, the links are gone, or the record is. */
  deferred: Set<string>;
  admitted: number;
  refreshed: number;
  rolledBack: number;
  failed: number;
}

/** Withdraws held rows the latest answer no longer admits — a rolled-back
 * record, a link to an action not imported, a key removed upstream. Written
 * once: a withdrawn row stays withdrawn until presence clears it, so callers
 * name rows not yet unavailable only. */
async function withdraw(deps: SurveysSyncDeps, refs: readonly string[], m: Mirror): Promise<void> {
  if (refs.length === 0) return;
  await markSurveysUnavailable(deps.db, refs, deps.now);
  for (const ref of refs) {
    const h = m.held.get(ref);
    if (h) m.held.set(ref, { ...h, unavailable: true, links: new Map() });
  }
  m.rolledBack += refs.length;
}

/** Withdrawable: held and not yet withdrawn. */
function withdrawable(m: Mirror, refs: readonly string[]): string[] {
  return refs.filter(ref => m.held.get(ref)?.unavailable === false);
}

async function admit(
  deps: SurveysSyncDeps,
  set: DecodedSet,
  a: SurveyAggregate,
  m: Mirror,
): Promise<void> {
  const { db, now, rand } = deps;
  try {
    const bodyMd = composeFirstPostMd(a);
    const values = rowValues(set, a, now);
    const links = new Map(a.govLinks.map(l => [l.actionId, l.title]));
    // The survey row and its links commit in the same atomic batch as the
    // topic and first post, so a partial write can never leave an orphan
    // thread for the next run to duplicate.
    const title = surveyTitle(a.record.definition, a.key);
    await createTopic(db, {
      categorySlug: SURVEYS_CATEGORY_SLUG,
      authorId: GOV_SYNC_AUTHOR,
      title,
      bodyMd,
      bodyHtml: renderMarkdown(bodyMd),
      source: 'survey',
      now,
      postedAt: recordUnixMs(a.record.slot, set.tip),
      rand: rand(),
      batchWith: topicId => [
        buildInsertSurvey(db, {
          ...values,
          topicId,
          title,
          endEpoch: a.record.definition.endEpoch,
          eligibleRoles: a.record.definition.eligibleRoles,
          sealed: a.sealed,
          externalContent: a.external,
          // The record in cip-179's own wire form, the one its decoder reads
          // back on every page view.
          definitionJson: JSON.stringify(toJsonSafe(a.record)),
          submittedAt: recordUnixMs(a.record.slot, set.tip),
        }),
        ...a.govLinks.map(l => buildInsertGovLink(db, a.key, l.actionId, l.title)),
      ],
    });
    m.known.add(a.key);
    m.deferred.delete(a.key);
    m.admitted++;
    if (values.finalState === null) {
      m.held.set(a.key, {
        ref: a.key,
        countedDreps: values.countedDreps,
        cancelled: values.cancelled,
        unavailable: false,
        links,
      });
    }
  } catch (err) {
    console.error(`[surveys] admission failed for ${a.key}`, err);
    m.failed++;
  }
}

/** Applies one answer to the mirror: held rows are refreshed where a stored
 * value moved and withdrawn where admission no longer holds; unknown
 * surveys are admitted, or deferred while their links name actions not
 * imported. The definition-derived half of admission is asked first, so an
 * answer of known or ineligible surveys costs no database round trip. */
async function applySet(deps: SurveysSyncDeps, set: DecodedSet, m: Mirror): Promise<void> {
  const { db, now } = deps;
  const held: [SurveyAggregate, HeldSurvey][] = [];
  const candidates: SurveyAggregate[] = [];
  for (const a of set.aggregates) {
    const h = m.held.get(a.key);
    if (h) held.push([a, h]);
    else if (!m.known.has(a.key) && eligibleSurvey(a)) candidates.push(a);
  }
  if (held.length + candidates.length === 0) return;
  const imported = await importedLinks(db, [...held.map(([a]) => a), ...candidates]);

  // D1's 100-bind cap is per statement, not summed across a batch, and the
  // widest statement here binds 6 — so one answer's refreshes commit as a
  // single batch, keeping its rewrite atomic. An answer that moved nothing
  // yields no statements: D1 rejects an empty batch, so it must not be issued.
  const statements: D1PreparedStatement[] = [];
  const refreshed = new Map<string, HeldSurvey | null>();
  const withdrawn: string[] = [];
  for (const [a, h] of held) {
    if (!admissible(a, imported)) {
      if (!h.unavailable) withdrawn.push(a.key);
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
    refreshed.set(
      a.key,
      next.finalState === null
        ? {
            ref: a.key,
            countedDreps: next.countedDreps,
            cancelled: next.cancelled,
            unavailable: false,
            links,
          }
        : null,
    );
  }
  if (statements.length > 0) await db.batch(statements);
  for (const [key, h] of refreshed) {
    if (h) m.held.set(key, h);
    else m.held.delete(key);
  }
  m.refreshed += refreshed.size;
  await withdraw(deps, withdrawn, m);

  for (const a of candidates) {
    if (admissible(a, imported)) await admit(deps, set, a, m);
    else if (a.govLinks.length > 0) m.deferred.add(a.key);
    else m.deferred.delete(a.key);
  }
}

export async function syncSurveys(deps: SurveysSyncDeps): Promise<SurveysSyncResult> {
  const { db, tessera, now } = deps;
  const state = await getSurveySyncState(db);
  const m: Mirror = {
    known: await getKnownSurveyRefs(db),
    held: new Map((await getHeldSurveys(db)).map(h => [h.ref, h])),
    deferred: new Set(state.deferredRefs),
    admitted: 0,
    refreshed: 0,
    rolledBack: 0,
    failed: 0,
  };
  let finalCounts = 0;
  let settled = 0;
  const result = (notReady: boolean): SurveysSyncResult => ({
    notReady,
    admitted: m.admitted,
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

  // --- Pass 1: the mirror. With a cursor, the delta since it, to its end;
  // without one — the first run, or the backend answering that the cursor
  // outlived its retention window — a walk of the linked list, whose last
  // page hands out the cursor to continue from. A page answering from an
  // older snapshot (`resync`) restarts the walk from a fresh page one: its
  // rows belong to a generation the walk is abandoning, and a stale answer's
  // terminal cursor is not this generation's end either. Isolated like the
  // passes after it: an answer that fails to apply must not cost the pending
  // answers their poll for the whole tick.
  let cursor = state.changesCursor;
  /** Every held row reflects `asOf` after this pass: the delta was applied
   * to its end, or a walk completed within one generation. */
  let mirrorComplete = false;
  let walked = false;
  try {
    if (cursor !== null) {
      for (let n = 0; n < MAX_LIST_PAGES; n++) {
        const answer = await tessera.changes(cursor, MAX_PAGE_LIMIT);
        if (!answer.ready) return result(true);
        const delta = answer.body;
        if (delta.nextCursor === null) {
          cursor = null;
          break;
        }
        // Removals first, as the contract says: a key removed and re-landed
        // in one answer is withdrawn, then cleared by its row.
        for (const key of delta.removed) m.deferred.delete(key);
        await withdraw(deps, withdrawable(m, delta.removed), m);
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
      if (cursor !== null && !mirrorComplete) {
        console.warn(
          `[surveys] change backlog exceeds ${MAX_LIST_PAGES} pages; continued next run`,
        );
      }
    }
    if (cursor === null) {
      walked = true;
      for (let restart = 0; restart <= MAX_RESYNC_RESTARTS && !mirrorComplete; restart++) {
        let resynced = false;
        let pageCursor: string | null = null;
        for (let n = 0; n < MAX_LIST_PAGES; n++) {
          const answer = await tessera.surveys({
            filter: 'linked',
            limit: MAX_PAGE_LIMIT,
            ...(pageCursor === null ? {} : { cursor: pageCursor }),
          });
          if (!answer.ready) return result(true);
          const page = answer.body;
          if (page.resync) {
            resynced = true;
            break;
          }
          const set = decodeSet(page);
          await applySet(deps, set, m);
          used(set);
          pageCursor = page.nextCursor ?? null;
          if (pageCursor === null) {
            cursor = page.changesCursor ?? null;
            mirrorComplete = true;
            break;
          }
        }
        // Only a moved snapshot earns a restart. A walk the page cap ended is
        // abandoned as well, and restarting it would only walk the cap again.
        if (!resynced) {
          if (!mirrorComplete) {
            console.warn(
              `[surveys] linked set exceeds ${MAX_LIST_PAGES} pages; walk not completed`,
            );
          }
          break;
        }
      }
    }
  } catch (err) {
    console.error('[surveys] mirror pass failed', err);
    m.failed++;
  }

  // --- Pass 2: by reference. The deferred surveys every run; on a run that
  // walked, every held row as well — the linked list covers only what is
  // linked now, so a held row that left it while the mirror had no cursor is
  // re-asked here, and its absence from a COMPLETE answer is the rollback the
  // delta would otherwise have delivered as a removal. From an incomplete
  // answer, absence proves nothing. Empty on a steady-state run.
  const asked = [...m.deferred, ...(walked ? m.held.keys() : [])];
  let refsAnswered = true;
  try {
    for (const chunk of chunked(asked, MAX_PAGE_LIMIT)) {
      const answer = await tessera.surveysByRefs(chunk);
      if (!answer.ready) {
        refsAnswered = false;
        break;
      }
      const set = decodeSet(answer.body);
      await applySet(deps, set, m);
      used(set);
      if (!set.incomplete) {
        const present = new Set(set.aggregates.map(a => a.key));
        const absent = chunk.filter(key => !present.has(key));
        for (const key of absent) m.deferred.delete(key);
        await withdraw(deps, withdrawable(m, absent), m);
      }
    }
  } catch (err) {
    console.error('[surveys] reference pass failed', err);
    m.failed++;
    refsAnswered = false;
  }

  // The mirror's bookkeeping, one row: where the delta continues, what is
  // still deferred, and the snapshot the held rows now reflect. The "as of"
  // advances only when every held row was brought up to it — a delta or a
  // walk that broke off leaves rows describing an older snapshot, and the
  // line must not promise fresher. The deferred set is bounded by one refs
  // request; past that the oldest wait for a change to name them again.
  if (m.deferred.size > MAX_PAGE_LIMIT) {
    console.warn(
      `[surveys] ${m.deferred.size} deferred surveys; keeping the newest ${MAX_PAGE_LIMIT}`,
    );
  }
  await putSurveySyncState(db, {
    changesCursor: cursor,
    deferredRefs: [...m.deferred].slice(-MAX_PAGE_LIMIT),
    tesseraFetchedAt:
      mirrorComplete && refsAnswered && asOf !== null ? asOf : state.tesseraFetchedAt,
  });

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
