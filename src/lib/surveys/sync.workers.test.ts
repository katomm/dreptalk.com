import { env } from 'cloudflare:test';
import {
  MAX_BUNDLE_RESYNCS,
  MAX_PAGE_LIMIT,
  type SurveyBundlePayload,
  type SurveyChangesPayload,
  type SurveyListPayload,
  TesseraHttpError,
} from 'cardano-tessera-client';
import { Role, type SurveyDefinition } from 'cip-179';
import {
  type ChainTip,
  hexToBytes,
  QUICKNET_CHAIN_HASH,
  type ResponseRecord,
  type SurveyRecord,
} from 'cip-179/domain';
import type { TallyArtifact } from 'cip-179/tally';
import { describe, expect, it } from 'vitest';
import { buildInsertGovernanceAction } from '../db/governance.js';
import {
  deleteSurveyTallies,
  enqueueSurveyTallies,
  getSurveyTally,
  markSurveyTallyAttempt,
  takeSurveyTallyWork,
} from '../db/surveyTally.js';
import {
  getPublishableSurveys,
  getLinkedSurveyForAction,
  getSurveyByRef,
  getSurveyByTopicId,
  getSurveyGovLinks,
  getSurveySyncState,
  getTopicSlugBySurveyRef,
  listSurveysWithTopics,
} from '../db/surveys.js';
import { formatRelativeTime } from '../forum/view.js';
import {
  MAX_LIST_PAGES,
  MAX_TALLY_REQUESTS,
  publishSurvey,
  type SurveysSyncDeps,
  type SurveysTessera,
  syncSurveys,
} from './sync.js';
import { parseSurveyDefinition } from './view.js';

const TX_LINKED = 'a'.repeat(64);
const TX_SECOND = 'b'.repeat(64);
const TX_NON_DREP = 'c'.repeat(64);
const TX_UNLINKED = 'd'.repeat(64);
const KEY_LINKED = `${TX_LINKED}:0`;
const KEY_SECOND = `${TX_SECOND}:0`;
const KEY_NON_DREP = `${TX_NON_DREP}:0`;
const KEY_UNLINKED = `${TX_UNLINKED}:0`;
const ACTION_ID = 'gov_action1linkedaction';
const ACTION_SECOND = 'gov_action1secondaction';
const ARTIFACT_HASH = 'ab'.repeat(32);
/** The cursor the bootstrap's last page hands out, and the one a delta answers with. */
const BOOT_CURSOR = 'boot-cursor';
const DELTA_CURSOR = 'delta-cursor';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const LINKED_LINKS: SurveyListPayload['govLinks'] = [
  { surveyKey: KEY_LINKED, actionId: ACTION_ID, endEpoch: 300, title: 'The linking action' },
];
const FINALIZED: SurveyListPayload['finalState'] = {
  [KEY_LINKED]: { state: 'finalized', artifactHash: ARTIFACT_HASH },
};
/** The backend's audited in-window counts for the default page: two DReps
 * on the linked survey, one SPO on the non-DRep one. */
const COUNTED: SurveyListPayload['countedByRole'] = {
  [KEY_LINKED]: { [Role.DRep]: 2 },
  [KEY_NON_DREP]: { [Role.SPO]: 1 },
};

const tip: ChainTip = {
  epoch: 300,
  slot: 60_000_000,
  time: 1_780_000_000,
  epochSlot: 5_000,
  govActionLifetime: 6,
};

function definition(overrides: Partial<SurveyDefinition> = {}): SurveyDefinition {
  return {
    specVersion: 5,
    owner: { type: 'key', keyHash: hexToBytes('11'.repeat(28)) },
    title: 'Treasury priorities',
    description: 'Which budget line matters most?',
    eligibleRoles: [Role.DRep],
    endEpoch: 300,
    submissionMode: { type: 'public' },
    questions: [
      {
        type: 'singleChoice',
        prompt: 'Pick one',
        options: { type: 'options', labels: ['A', 'B'] },
      },
    ],
    ...overrides,
  };
}

function surveyRecord(txHash: string, def: SurveyDefinition): SurveyRecord {
  return {
    txHash,
    slot: tip.slot - 10_000,
    epochNo: tip.epoch - 1,
    ref: { txId: hexToBytes(txHash), index: 0 },
    definition: def,
  };
}

/** `countedByRole: null` is a backend that predates the field. */
function setOf(
  records: SurveyRecord[],
  govLinks: SurveyListPayload['govLinks'],
  counts: Record<string, number>,
  countedByRole: SurveyListPayload['countedByRole'] | null = COUNTED,
): SurveyListPayload {
  return {
    surveys: records,
    cancellations: [],
    govLinks,
    tip,
    responseCounts: counts,
    ...(countedByRole ? { countedByRole } : {}),
    finalState: {},
    fetchedAt: tip.time,
  };
}

/** One complete delta: what moved, what was removed, and where to ask from next. */
function deltaOf(
  set: SurveyListPayload,
  removed: string[] = [],
  nextCursor = DELTA_CURSOR,
): SurveyChangesPayload {
  return { ...set, removed, nextCursor };
}

/** Two hundred surveys nobody can answer here: a full delta page. */
function bulkOf(): SurveyRecord[] {
  return Array.from({ length: MAX_PAGE_LIMIT }, (_, i) =>
    surveyRecord(i.toString(16).padStart(64, '0'), definition({ eligibleRoles: [Role.SPO] })),
  );
}

/** A finalized tally artifact with the given DRep responders (a role with
 * none is absent from the artifact, as Tessera emits it). Only the shape the
 * sync reads. */
function artifactOf(drepResponders: number): TallyArtifact {
  return {
    tally: {
      perRole:
        drepResponders === 0
          ? []
          : [
              {
                role: Role.DRep,
                responders: Array.from({ length: drepResponders }, (_, i) => ({
                  credential: `key:${String(i).padStart(2, '0').repeat(28)}`,
                })),
              },
            ],
    },
  } as unknown as TallyArtifact;
}

/** The two DReps the bundle's responses come from, and the one nothing weighs.
 * Deliberately not the definition owner's hash ('11'), so a responder is never
 * confused with the survey's owner. */
const DREP_A = '44'.repeat(28);
const DREP_B = '55'.repeat(28);
const POWER_EPOCH = 312;
/** The end epoch an artifact commits its weighting to, the survey's own. */
const ARTIFACT_END_EPOCH = 300;
const NOW = 1_780_000_500_000;
/** The same instant in unix seconds, which is the unit both stamp columns of
 * survey_tally carry. */
const NOW_S = Math.floor(NOW / 1000);
/** What the tally pass may spend on a quiet tick: the run's only earlier
 * request is the one delta call of pass 1. A test that wants a survey to
 * consume the whole allowance sizes its bundle by this. */
const QUIET_BUDGET = MAX_TALLY_REQUESTS - 1;

/** The power history the tally pass weighs a response against, plus the
 * epoch's representative total. */
async function seedPower(epoch = POWER_EPOCH): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dreps (drep_id, hex, has_script, status, active, last_synced_at, created_at)
       VALUES ('drep_a', ?, 0, 'active', 1, 0, 0)`,
    ).bind(DREP_A),
    env.DB.prepare(
      `INSERT INTO dreps (drep_id, hex, has_script, status, active, last_synced_at, created_at)
       VALUES ('drep_b', ?, 0, 'active', 1, 0, 0)`,
    ).bind(DREP_B),
    env.DB.prepare(
      `INSERT INTO drep_voting_power_history (drep_id, epoch, amount)
       VALUES ('drep_a', ?, '4000000'), ('drep_b', ?, '1000000')`,
    ).bind(epoch, epoch),
    env.DB.prepare(
      `INSERT INTO governance_epoch_stats
         (epoch, total_drep_power, powered_drep_count, recently_voting_drep_count, gini,
          top10_share_pct, min_coalition_50, min_coalition_67, votes_cast, vote_data_complete,
          computed_at)
       VALUES (?, '20000000000000', 2, 1, 0.5, 10.0, 5, 9, 2, 0, 0)`,
    ).bind(epoch),
  ]);
}

/** One more epoch in the power history: the advance that makes a live tally
 * stale, with the same weights so only the epoch moves. */
async function advancePowerEpoch(epoch: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO drep_voting_power_history (drep_id, epoch, amount)
       VALUES ('drep_a', ?, '4000000'), ('drep_b', ?, '1000000')`,
    ).bind(epoch, epoch),
    env.DB.prepare(
      `INSERT INTO governance_epoch_stats
         (epoch, total_drep_power, powered_drep_count, recently_voting_drep_count, gini,
          top10_share_pct, min_coalition_50, min_coalition_67, votes_cast, vote_data_complete,
          computed_at)
       VALUES (?, '20000000000000', 2, 1, 0.5, 10.0, 5, 9, 2, 0, 0)`,
    ).bind(epoch),
  ]);
}

/** One on-chain response, in the window of the default definition (end epoch
 * 300, one single-choice question with two options). */
function response(drepHex: string, optionIndex: number, txHash: string): ResponseRecord {
  return {
    txHash,
    slot: tip.slot - 5_000,
    epochNo: tip.epoch - 1,
    responseIndex: 0,
    response: {
      specVersion: 5,
      surveyRef: { txId: hexToBytes(TX_LINKED), index: 0 },
      role: Role.DRep,
      credential: { type: 'key', keyHash: hexToBytes(drepHex) },
      answers: {
        type: 'public',
        answers: [{ type: 'singleChoice', questionIndex: 0, optionIndex }],
      },
    },
  };
}

/** Two counted DReps, weighing 4,000,000 and 1,000,000 lovelace. */
function twoResponses(): ResponseRecord[] {
  return [response(DREP_A, 0, 'e'.repeat(64)), response(DREP_B, 1, 'f'.repeat(64))];
}

/** One bundle page. Everything but `responses` describes the whole survey on
 * every page, as the contract says, and nothing in the tally pass reads the
 * page's own survey record, so one record serves every ref here. */
function bundlePage(
  responses: ResponseRecord[],
  extra: { nextCursor?: string | null; resync?: boolean } = {},
): SurveyBundlePayload {
  return {
    survey: surveyRecord(TX_LINKED, definition()),
    responses,
    cancellations: [],
    tip,
    fetchedAt: tip.time,
    ...extra,
  };
}

/** A bundle source that pages: `pages[ref]` page fetches per survey, one by
 * default, with the responses on the first page. Every fetch is recorded in
 * `log` as `<ref>@<cursor>`, which is how the budget tests count requests
 * rather than bundles. */
function pagingBundle(pages: Record<string, number>, log: string[]): SurveysTessera['bundle'] {
  return async (survey, cursor) => {
    const ref = survey as string;
    log.push(`${ref}@${cursor ?? 'first'}`);
    const total = pages[ref] ?? 1;
    const page = cursor ? Number(cursor.split('#')[1]) : 1;
    return {
      ready: true,
      body: bundlePage(page === 1 ? twoResponses() : [], {
        nextCursor: page < total ? `${ref}#${page + 1}` : null,
      }),
    };
  };
}

/** A finalized artifact in the shape the tally pass reads: the DRep role's
 * electorate total, its counted responders with their committed weights, its
 * questions, and the end epoch the weighting stands on. `dreps: null` is a role
 * ABSENT from perRole, which means zero counted responders and is still the
 * artifact path. */
function tallyArtifact(
  opts: { dreps?: readonly { credential: string; weight: string }[] | null; total?: string } = {},
): TallyArtifact {
  const dreps =
    opts.dreps === undefined ? [{ credential: `key:${DREP_A}`, weight: '7000000' }] : opts.dreps;
  return {
    tally: {
      survey: { txId: TX_LINKED, index: 0, endEpoch: ARTIFACT_END_EPOCH },
      perRole:
        dreps === null
          ? []
          : [
              {
                role: Role.DRep,
                total: opts.total ?? '50000000',
                responders: dreps.map(d => ({ ...d, txHash: TX_LINKED, responseIndex: 0 })),
                questions: [
                  {
                    kind: 'options',
                    unit: 'singleChoice',
                    options: [{ index: 0, weight: '7000000', count: 1 }],
                    answeredCount: 1,
                    answeredWeight: '7000000',
                  },
                ],
              },
            ],
    },
  } as unknown as TallyArtifact;
}

const TX_OF: Record<string, string> = {
  [KEY_LINKED]: TX_LINKED,
  [KEY_SECOND]: TX_SECOND,
  [KEY_NON_DREP]: TX_NON_DREP,
  [KEY_UNLINKED]: TX_UNLINKED,
};

/** A list body delivering the named surveys, each linked, each with a distinct
 * title (two surveys sharing one would collide on the thread slug, since the
 * suffix is fixed in these tests) and two audited DRep responses. */
function corpusOf(
  keys: readonly string[],
  opts: {
    finalState?: SurveyListPayload['finalState'];
    defs?: Record<string, SurveyDefinition>;
  } = {},
): SurveyListPayload {
  return {
    ...setOf(
      keys.map(k =>
        surveyRecord(TX_OF[k], opts.defs?.[k] ?? definition({ title: `Survey ${k.slice(0, 4)}` })),
      ),
      keys.map(k => ({
        surveyKey: k,
        actionId: k === KEY_SECOND ? ACTION_SECOND : ACTION_ID,
        endEpoch: 300,
        title: null,
      })),
      {},
      Object.fromEntries(keys.map(k => [k, { [Role.DRep]: 2 }])),
    ),
    ...(opts.finalState ? { finalState: opts.finalState } : {}),
  };
}

/** Queue order is (last_attempt, queued_at), so a test that cares which survey
 * the pass reaches first has to separate the queued_at stamps one enqueue call
 * gives them all. */
async function orderQueue(refs: readonly string[]): Promise<void> {
  for (const [i, ref] of refs.entries()) {
    await env.DB.prepare('UPDATE survey_tally_queue SET queued_at = ? WHERE survey_ref = ?')
      .bind(1_000 + i, ref)
      .run();
  }
}

function fakeTessera(overrides: Partial<SurveysTessera> = {}): SurveysTessera {
  // The whole corpus, as the bootstrap delivers it: the delta carries no
  // filter, so a linked non-DRep survey and a DRep-eligible survey nothing
  // links ride beside the one the mirror wants.
  const corpus = setOf(
    [
      surveyRecord(TX_LINKED, definition()),
      surveyRecord(TX_NON_DREP, definition({ eligibleRoles: [Role.SPO], title: 'SPO poll' })),
      surveyRecord(TX_UNLINKED, definition({ title: 'Standalone poll' })),
    ],
    [
      { surveyKey: KEY_LINKED, actionId: ACTION_ID, endEpoch: 300, title: 'The linking action' },
      {
        surveyKey: KEY_NON_DREP,
        actionId: ACTION_ID,
        endEpoch: 300,
        title: 'The linking action',
      },
    ],
    { [KEY_LINKED]: 3, [KEY_NON_DREP]: 1, [KEY_UNLINKED]: 2 },
    { ...COUNTED, [KEY_UNLINKED]: { [Role.DRep]: 2 } },
  );
  return {
    changesSince:
      overrides.changesSince ??
      (async () => ({ ready: true, body: deltaOf(corpus, [], BOOT_CURSOR) })),
    // Nothing moved since the cursor: the steady state of every tick.
    changes: overrides.changes ?? (async () => ({ ready: true, body: deltaOf(setOf([], [], {})) })),
    artifactByHash: overrides.artifactByHash ?? (async () => artifactOf(2)),
    // One page, two counted DReps, no continuation: the bundle of a survey
    // nothing special is being asked about.
    bundle: overrides.bundle ?? (async () => ({ ready: true, body: bundlePage(twoResponses()) })),
  };
}

function deps(tessera: SurveysTessera, now = 1_780_000_500_000): SurveysSyncDeps {
  return { db: env.DB, tessera, now, rand: () => 'abcd1234' };
}

async function importLinkingAction(proposalId = ACTION_ID, now = 1): Promise<void> {
  await buildInsertGovernanceAction(env.DB, {
    id: `${'f'.repeat(64)}#${proposalId === ACTION_ID ? 0 : 1}`,
    proposalId,
    type: 'InfoAction',
    title: 'The linking action',
    abstract: null,
    rationaleHtml: null,
    authors: null,
    references: null,
    anchorUrl: null,
    anchorHash: null,
    anchorStatus: 'no-anchor',
    returnAddress: null,
    deposit: null,
    submittedEpoch: 295,
    submittedAt: null,
    expiryEpoch: 301,
    enactedEpoch: null,
    onchainPayload: null,
    metaVersion: 1,
    topicId: `topic-of-${proposalId}`,
    now,
  }).run();
}

interface StoredSurvey {
  ref: string;
  topic_id: string | null;
  counted_dreps: number | null;
  final_counted_dreps: number | null;
  final_state: string | null;
  artifact_hash: string | null;
  unavailable: number;
  cancelled: number;
  submitted_at: number;
  synced_at: number;
}

async function surveyRows(): Promise<StoredSurvey[]> {
  const { results } = await env.DB.prepare(
    `SELECT ref, topic_id, counted_dreps, final_counted_dreps, final_state, artifact_hash,
            unavailable, cancelled, submitted_at, synced_at
     FROM survey ORDER BY ref`,
  ).all<StoredSurvey>();
  return results;
}

/** The thread of a row that must have one. */
function threadOf(row: StoredSurvey): string {
  if (row.topic_id === null) throw new Error(`${row.ref} has no thread`);
  return row.topic_id;
}

async function linksOf(ref: string): Promise<{ action_id: string; title: string | null }[]> {
  const { results } = await env.DB.prepare(
    'SELECT action_id, title FROM survey_gov_link WHERE survey_ref = ? ORDER BY action_id',
  )
    .bind(ref)
    .all<{ action_id: string; title: string | null }>();
  return results;
}

describe('syncSurveys', () => {
  it('mirrors only the DRep-eligible linked survey, opens its thread, stores the audited DRep count', async () => {
    await importLinkingAction();

    const r = await syncSurveys(deps(fakeTessera()));
    expect(r).toMatchObject({ notReady: false, written: 1, published: 1, failed: 0 });

    // Exactly one row: neither the linked non-DRep survey nor the DRep survey
    // nothing links is eligible, a link is Tessera's fact, and the survey
    // is delivered again when one arrives.
    const rows = await surveyRows();
    expect(rows.map(s => s.ref)).toEqual([KEY_LINKED]);
    // The card number is the backend's audited DRep count, not the list's
    // raw responseCount of 3, and no artifact figure yet on a held survey.
    expect(rows[0]).toMatchObject({
      counted_dreps: 2,
      final_counted_dreps: null,
      final_state: null,
      artifact_hash: null,
    });

    const topic = await env.DB.prepare(
      'SELECT id, category_slug, source, title FROM topics WHERE id = ?',
    )
      .bind(threadOf(rows[0]))
      .first<{ id: string; category_slug: string; source: string; title: string }>();
    expect(topic).toMatchObject({
      category_slug: 'surveys',
      source: 'survey',
      title: 'Treasury priorities',
    });
    expect((await linksOf(KEY_LINKED)).map(l => l.action_id)).toEqual([ACTION_ID]);

    // Second run: nothing new, nothing duplicated.
    const r2 = await syncSurveys(deps(fakeTessera()));
    expect(r2).toMatchObject({ written: 0, published: 0, failed: 0 });
    expect((await surveyRows()).length).toBe(1);
    const topics = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM topics WHERE source = 'survey'",
    ).first<{ n: number }>();
    expect(topics?.n).toBe(1);
  });

  it("stores the titles and opening post sanitized and capped, the definition in cip-179's wire form", async () => {
    await importLinkingAction();
    const rawTitle = ` Bud\u0000get ${'t'.repeat(400)}`;
    const record = surveyRecord(
      TX_LINKED,
      definition({ title: rawTitle, description: `Why\u0007 this\n\n\n\n${'d'.repeat(5000)}` }),
    );
    // The linking action's title is anchor text too.
    const links: SurveyListPayload['govLinks'] = [
      { ...LINKED_LINKS[0], title: ` Act\u0000ion ${'a'.repeat(400)}` },
    ];
    const corpus = deltaOf(setOf([record], links, { [KEY_LINKED]: 0 }), [], BOOT_CURSOR);
    await syncSurveys(
      deps(fakeTessera({ changesSince: async () => ({ ready: true, body: corpus }) })),
    );

    const [row] = await surveyRows();
    const expectedTitle = `Budget ${'t'.repeat(293)}`;
    const topic = await env.DB.prepare('SELECT title FROM topics WHERE id = ?')
      .bind(threadOf(row))
      .first<{ title: string }>();
    expect(topic?.title).toBe(expectedTitle);
    const survey = await getSurveyByTopicId(env.DB, threadOf(row));
    expect(await linksOf(KEY_LINKED)).toEqual([
      { action_id: ACTION_ID, title: `Action ${'a'.repeat(293)}` },
    ]);
    const post = await env.DB.prepare('SELECT body_md FROM posts WHERE topic_id = ?')
      .bind(threadOf(row))
      .first<{ body_md: string }>();
    expect(post?.body_md).toContain(`Why this\n\n${'d'.repeat(3990)}\n`);
    expect(post?.body_md).not.toContain('\u0007');
    // The stored record is what the widget re-decodes: untouched.
    expect(survey?.definitionJson).toContain(JSON.stringify(rawTitle).slice(1, -1));
  });

  it('stores a linked survey whose action is not imported, and opens its thread once it is, from the row alone', async () => {
    // Nothing imported: the survey is eligible on Tessera's facts alone, so
    // its row is written now and nothing is remembered, the thread waits.
    expect(await syncSurveys(deps(fakeTessera()))).toMatchObject({
      written: 1,
      published: 0,
      failed: 0,
    });
    const [row] = await surveyRows();
    expect(row).toMatchObject({ ref: KEY_LINKED, topic_id: null });
    expect((await linksOf(KEY_LINKED)).map(l => l.action_id)).toEqual([ACTION_ID]);
    // No page can reach it.
    expect(await listSurveysWithTopics(env.DB, { limit: 10, offset: 0 })).toEqual([]);
    expect(await getTopicSlugBySurveyRef(env.DB, KEY_LINKED)).toBeNull();
    expect(await getLinkedSurveyForAction(env.DB, ACTION_ID)).toBeNull();

    // A quiet tick: still waiting, and nothing asked of Tessera about it.
    expect(await syncSurveys(deps(fakeTessera()))).toMatchObject({ written: 0, published: 0 });
    expect((await surveyRows())[0].topic_id).toBeNull();

    // The action is imported: the next tick opens the thread from the stored
    // record, the delta is quiet, and no bootstrap is asked for again.
    await importLinkingAction();
    const silent = fakeTessera({
      changesSince: async () => {
        throw new Error('no bootstrap once a cursor is held');
      },
    });
    expect(await syncSurveys(deps(silent))).toMatchObject({
      written: 0,
      published: 1,
      failed: 0,
    });
    const [published] = await surveyRows();
    const topic = await env.DB.prepare('SELECT title, created_at FROM topics WHERE id = ?')
      .bind(threadOf(published))
      .first<{ title: string; created_at: number }>();
    // Dated by the publication time the row stored, not by the tick.
    expect(topic).toEqual({ title: 'Treasury priorities', created_at: published.submitted_at });
    expect(await getTopicSlugBySurveyRef(env.DB, KEY_LINKED)).not.toBeNull();
    expect((await getLinkedSurveyForAction(env.DB, ACTION_ID))?.survey.ref).toBe(KEY_LINKED);

    // Published once: a later tick opens no second thread.
    expect(await syncSurveys(deps(silent))).toMatchObject({ published: 0 });
    const topics = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM topics WHERE source = 'survey'",
    ).first<{ n: number }>();
    expect(topics?.n).toBe(1);
  });

  it('deletes a survey with no thread the delta removes, and stores it again when it returns', async () => {
    await syncSurveys(deps(fakeTessera()));
    expect((await surveyRows()).map(r => r.ref)).toEqual([KEY_LINKED]);

    // Removed upstream with no thread to keep: the row and its links go.
    const gone = fakeTessera({
      changes: async () => ({ ready: true, body: deltaOf(setOf([], [], {}), [KEY_LINKED]) }),
    });
    expect((await syncSurveys(deps(gone))).rolledBack).toBe(1);
    expect(await surveyRows()).toEqual([]);
    expect(await linksOf(KEY_LINKED)).toEqual([]);
    // Removed again: nothing left to withdraw.
    expect((await syncSurveys(deps(gone))).rolledBack).toBe(0);

    // The removal was advisory after all: the record returns, and its row
    // with it, a store, not a refresh, since nothing was kept.
    const linked = surveyRecord(TX_LINKED, definition());
    const back = fakeTessera({
      changes: async () => ({
        ready: true,
        body: deltaOf(setOf([linked], LINKED_LINKS, { [KEY_LINKED]: 3 })),
      }),
    });
    expect(await syncSurveys(deps(back))).toMatchObject({ written: 1, published: 0 });
    expect((await surveyRows())[0]).toMatchObject({ ref: KEY_LINKED, topic_id: null });

    // Listed with no link at all: no longer eligible, and gone the same way.
    const unlinked = fakeTessera({
      changes: async () => ({
        ready: true,
        body: deltaOf(setOf([linked], [], { [KEY_LINKED]: 3 })),
      }),
    });
    expect((await syncSurveys(deps(unlinked))).rolledBack).toBe(1);
    expect(await surveyRows()).toEqual([]);
  });

  it('stores no in-window count while the backend serves none, and picks it up once it does', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    const linked = surveyRecord(TX_LINKED, definition());
    const blind = fakeTessera({
      changesSince: async () => ({
        ready: true,
        body: deltaOf(setOf([linked], LINKED_LINKS, { [KEY_LINKED]: 3 }, null), [], BOOT_CURSOR),
      }),
    });
    // The raw count of 3 is never a fallback: the row says "unknown".
    await syncSurveys(deps(blind, now));
    expect((await surveyRows())[0].counted_dreps).toBeNull();
    expect((await syncSurveys(deps(blind, now + HOUR_MS))).written).toBe(0);
    expect((await surveyRows())[0].counted_dreps).toBeNull();

    // The field appears on the wire: one write, the audited figure is stored.
    const counted = fakeTessera({
      changes: async () => ({
        ready: true,
        body: deltaOf(setOf([linked], LINKED_LINKS, { [KEY_LINKED]: 3 })),
      }),
    });
    expect((await syncSurveys(deps(counted, now + 2 * HOUR_MS))).written).toBe(1);
    expect((await surveyRows())[0].counted_dreps).toBe(2);

    // A survey the field names with nothing counted is a zero, not an unknown.
    const empty = fakeTessera({
      changes: async () => ({
        ready: true,
        body: deltaOf(setOf([linked], LINKED_LINKS, { [KEY_LINKED]: 3 }, { [KEY_LINKED]: {} })),
      }),
    });
    await syncSurveys(deps(empty, now + 3 * HOUR_MS));
    expect((await surveyRows())[0].counted_dreps).toBe(0);
  });

  it('rewrites the row of every survey the delta delivers, and none on a quiet tick', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    await syncSurveys(deps(fakeTessera(), now));
    expect((await surveyRows())[0].synced_at).toBe(now);

    // A quiet tick delivers nothing, so nothing is written: synced_at keeps
    // dating Tessera's last report about the survey, not the last look.
    expect((await syncSurveys(deps(fakeTessera(), now + HOUR_MS))).written).toBe(0);
    expect((await surveyRows())[0].synced_at).toBe(now);

    // The audited count moved.
    const linked = surveyRecord(TX_LINKED, definition());
    const answer = (
      countedByRole: SurveyListPayload['countedByRole'],
      govLinks: SurveyListPayload['govLinks'] = LINKED_LINKS,
    ) =>
      fakeTessera({
        changes: async () => ({
          ready: true,
          body: deltaOf(setOf([linked], govLinks, { [KEY_LINKED]: 4 }, countedByRole)),
        }),
      });
    const moved = now + 2 * HOUR_MS;
    expect((await syncSurveys(deps(answer({ [KEY_LINKED]: { 0: 3 } }), moved))).written).toBe(1);
    expect((await surveyRows())[0]).toMatchObject({ counted_dreps: 3, synced_at: moved });

    // A link moved, the action's title, then a second linking action: the
    // links are rewritten from the answer, not merged into what is there.
    const retitled = now + 3 * HOUR_MS;
    const links: SurveyListPayload['govLinks'] = [{ ...LINKED_LINKS[0], title: 'Renamed action' }];
    expect(
      (await syncSurveys(deps(answer({ [KEY_LINKED]: { 0: 3 } }, links), retitled))).written,
    ).toBe(1);
    expect(await linksOf(KEY_LINKED)).toEqual([{ action_id: ACTION_ID, title: 'Renamed action' }]);
    expect((await surveyRows())[0].synced_at).toBe(retitled);
    const second: SurveyListPayload['govLinks'] = [
      ...links,
      { surveyKey: KEY_LINKED, actionId: ACTION_SECOND, endEpoch: 300, title: 'Another' },
    ];
    const relinked = now + 4 * HOUR_MS;
    expect(
      (await syncSurveys(deps(answer({ [KEY_LINKED]: { 0: 3 } }, second), relinked))).written,
    ).toBe(1);
    expect((await linksOf(KEY_LINKED)).map(l => l.action_id)).toEqual([ACTION_ID, ACTION_SECOND]);

    // The same row delivered again: written, unasked whether anything this
    // mirror stores moved, Tessera reports the change, so there was one, and
    // it may well be in a figure no column here keeps.
    const again = relinked + HOUR_MS;
    expect(
      (await syncSurveys(deps(answer({ [KEY_LINKED]: { 0: 3 } }, second), again))).written,
    ).toBe(1);
    expect((await surveyRows())[0]).toMatchObject({ counted_dreps: 3, synced_at: again });
    expect((await linksOf(KEY_LINKED)).map(l => l.action_id)).toEqual([ACTION_ID, ACTION_SECOND]);
  });

  it('rewrites the stored definition on delivery, so a form an older codec wrote decodes again', async () => {
    await importLinkingAction();
    const points = definition({
      questions: [
        {
          type: 'pointsAllocation',
          prompt: 'Spend',
          options: { type: 'options', labels: ['A', 'B'] },
          budget: 10n,
        },
      ],
    });
    const body = deltaOf(
      setOf([surveyRecord(TX_LINKED, points)], LINKED_LINKS, { [KEY_LINKED]: 3 }),
    );
    const delivery = fakeTessera({
      changesSince: async () => ({ ready: true, body }),
      changes: async () => ({ ready: true, body }),
    });
    await syncSurveys(deps(delivery));
    const stored = async () => (await getSurveyByRef(env.DB, KEY_LINKED))?.definitionJson ?? '';
    expect(await stored()).toContain('"budget":{"$bigint":"10"}');

    // The row as cip-179 0.4.0 wrote it, a points budget as a plain number,
    // which the 0.5.0 decoder refuses.
    await env.DB.prepare('UPDATE survey SET definition = ? WHERE ref = ?')
      .bind((await stored()).replace('{"$bigint":"10"}', '10'), KEY_LINKED)
      .run();
    expect(parseSurveyDefinition(await stored())).toBeNull();

    // Tessera re-stamps the survey: the delivery carries the current form, and
    // the row takes it.
    expect((await syncSurveys(deps(delivery))).written).toBe(1);
    expect(parseSurveyDefinition(await stored())?.questions[0]).toMatchObject({ budget: 10n });
  });

  it('bootstraps from instant zero once, then asks only for what changed from its cursor', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    const first = surveyRecord(TX_LINKED, definition());
    let calls: string[] = [];
    let backlog = false;
    const mirror = fakeTessera({
      changesSince: async since => {
        calls.push(`since:${since}`);
        // A corpus wider than one page: the first page full, continued by
        // the ordinary cursor it hands out.
        return { ready: true, body: deltaOf(setOf(bulkOf(), [], {}), [], 'boot-page-2') };
      },
      changes: async cursor => {
        calls.push(cursor);
        if (cursor === 'boot-page-2') {
          return {
            ready: true,
            body: deltaOf(setOf([first], LINKED_LINKS, { [KEY_LINKED]: 3 }), [], BOOT_CURSOR),
          };
        }
        const full = backlog && calls.length === 1;
        return {
          ready: true,
          body: deltaOf(setOf(full ? bulkOf() : [], [], {}), [], `${DELTA_CURSOR}-${calls.length}`),
        };
      },
    });
    // No cursor yet: the whole corpus as delta pages, and the last page's
    // cursor kept.
    await syncSurveys(deps(mirror, now));
    expect(calls).toEqual(['since:0', 'boot-page-2']);
    expect(await getSurveySyncState(env.DB)).toMatchObject({ changesCursor: BOOT_CURSOR });
    expect((await surveyRows()).map(r => r.ref)).toEqual([KEY_LINKED]);

    // The steady state of every five-minute tick: one delta from the stored
    // cursor, its answer's cursor stored for the next.
    calls = [];
    await syncSurveys(deps(mirror, now + HOUR_MS));
    expect(calls).toEqual([BOOT_CURSOR]);
    expect((await getSurveySyncState(env.DB)).changesCursor).toBe(`${DELTA_CURSOR}-1`);

    // A backlog: a full page is followed up in the same run until a short one.
    calls = [];
    backlog = true;
    await syncSurveys(deps(mirror, now + 2 * HOUR_MS));
    expect(calls).toEqual([`${DELTA_CURSOR}-1`, `${DELTA_CURSOR}-1`]);
    expect((await getSurveySyncState(env.DB)).changesCursor).toBe(`${DELTA_CURSOR}-2`);
  });

  it('stops at the page cap, keeps the cursor it reached, and dates nothing', async () => {
    let calls = 0;
    const endless = async () => {
      calls++;
      return {
        ready: true as const,
        body: deltaOf(setOf(bulkOf(), [], {}), [], `cursor-${calls}`),
      };
    };
    expect(
      (await syncSurveys(deps(fakeTessera({ changesSince: endless, changes: endless })))).failed,
    ).toBe(0);
    // The cap is the whole request budget. The backlog continues next run
    // from where this one stopped, and the "as of" waits for a run that
    // reaches the end.
    expect(calls).toBe(MAX_LIST_PAGES);
    expect(await getSurveySyncState(env.DB)).toEqual({
      changesCursor: `cursor-${MAX_LIST_PAGES}`,
      tesseraFetchedAt: null,
      incomplete: false,
    });
  });

  it('opens one thread when two overlapping runs publish the same survey', async () => {
    // A run before the linking action is imported here stores the row and
    // opens no thread, which is the state a publish pass starts from. Both
    // calls below then read that same unpublished row, exactly what two runs
    // whose publish passes overlap each do.
    await syncSurveys(deps(fakeTessera()));
    expect((await surveyRows())[0].topic_id).toBeNull();
    await importLinkingAction();
    const [candidate] = await getPublishableSurveys(env.DB);

    const d = deps(fakeTessera());
    const claimed = await Promise.all([publishSurvey(d, candidate), publishSurvey(d, candidate)]);

    // Exactly one claim, and the loser wrote nothing at all: an orphan thread
    // would sit in the category forever, since the claim it was opened for is
    // taken and no later run offers the survey again.
    expect(claimed.filter(Boolean)).toHaveLength(1);
    const { results: threads } = await env.DB.prepare(
      "SELECT id FROM topics WHERE source = 'survey'",
    ).all<{ id: string }>();
    expect(threads).toHaveLength(1);
    const { results: posts } = await env.DB.prepare(
      "SELECT id FROM posts WHERE topic_id IN (SELECT id FROM topics WHERE source = 'survey')",
    ).all<{ id: string }>();
    expect(posts).toHaveLength(1);
    expect((await surveyRows())[0].topic_id).toBe(threads[0].id);
  });

  it('does not write a final count against an artifact hash the row no longer names', async () => {
    await importLinkingAction();
    const decided = setOf(
      [surveyRecord(TX_LINKED, definition())],
      LINKED_LINKS,
      { [KEY_LINKED]: 3 },
    );
    const finalized: SurveyListPayload = {
      ...decided,
      finalState: { [KEY_LINKED]: { state: 'finalized', artifactHash: ARTIFACT_HASH } },
    };
    const r = await syncSurveys(
      deps(
        fakeTessera({
          changesSince: async () => ({ ready: true, body: deltaOf(finalized, [], BOOT_CURSOR) }),
          // The overlapping mirror: it re-finalizes the survey onto a second
          // artifact while this run's request for the first is in flight.
          artifactByHash: async () => {
            await env.DB.prepare('UPDATE survey SET artifact_hash = ? WHERE ref = ?')
              .bind('cd'.repeat(32), KEY_LINKED)
              .run();
            return artifactOf(9);
          },
        }),
      ),
    );

    // The figure belongs to the artifact it was read from. Writing it beside
    // the newer hash would pin a wrong final count for good, since a row with
    // a count is never asked about again.
    expect(r).toMatchObject({ finalCounts: 0 });
    const [row] = await surveyRows();
    expect(row).toMatchObject({ artifact_hash: 'cd'.repeat(32), final_counted_dreps: null });
  });

  it('records an incomplete upstream scan with the snapshot it describes, and clears it', async () => {
    await importLinkingAction();
    const short: SurveyChangesPayload = {
      ...deltaOf(setOf([surveyRecord(TX_LINKED, definition())], LINKED_LINKS, { [KEY_LINKED]: 3 }), [], BOOT_CURSOR),
      incomplete: true,
    };
    await syncSurveys(deps(fakeTessera({ changesSince: async () => ({ ready: true, body: short }) })));
    // The snapshot is current and short at once. The page may say how fresh
    // it is, but not that it is whole.
    expect(await getSurveySyncState(env.DB)).toEqual({
      changesCursor: BOOT_CURSOR,
      tesseraFetchedAt: tip.time,
      incomplete: true,
    });

    // A later answer that read everything takes the claim back.
    await syncSurveys(deps(fakeTessera()));
    expect(await getSurveySyncState(env.DB)).toMatchObject({ incomplete: false });
  });

  it('keeps the cursor and the "as of" it could not advance when the delta fails', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    await syncSurveys(deps(fakeTessera(), now));

    // The delta the backend cannot serve: the pass records its failure and
    // the later passes still run.
    const broken = fakeTessera({
      changes: async () => {
        throw new TesseraHttpError('/api/surveys', 502, '');
      },
    });
    expect(await syncSurveys(deps(broken, now + HOUR_MS))).toMatchObject({ failed: 1 });
    // Nothing was applied, so the next run asks from the same position, and
    // the page keeps claiming the generation the rows actually reflect.
    expect(await getSurveySyncState(env.DB)).toMatchObject({
      changesCursor: BOOT_CURSOR,
      tesseraFetchedAt: tip.time,
    });
  });

  it('withdraws a published survey the delta removes, and clears it when it reappears', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    await syncSurveys(deps(fakeTessera(), now));

    // Removed upstream: withdrawn, and the linking action's thread stops
    // naming the survey.
    const gone = fakeTessera({
      changes: async () => ({ ready: true, body: deltaOf(setOf([], [], {}), [KEY_LINKED]) }),
    });
    expect((await syncSurveys(deps(gone, now + HOUR_MS))).rolledBack).toBe(1);
    let [row] = await surveyRows();
    expect(row).toMatchObject({ unavailable: 1, synced_at: now + HOUR_MS });
    expect(await linksOf(KEY_LINKED)).toEqual([]);
    expect(await getLinkedSurveyForAction(env.DB, ACTION_ID)).toBeNull();

    // Removed again: withdrawn once, the statement asks for rows not already
    // flagged, so nothing is written, and the row still lists for the pages.
    expect((await syncSurveys(deps(gone, now + 2 * HOUR_MS))).rolledBack).toBe(0);
    expect((await surveyRows())[0].synced_at).toBe(now + HOUR_MS);
    expect(await listSurveysWithTopics(env.DB, { limit: 10, offset: 0 })).toHaveLength(1);

    // The record returns, long after: the flag cleared by its presence
    // alone, and relinked.
    const linked = surveyRecord(TX_LINKED, definition());
    const back = fakeTessera({
      changes: async () => ({
        ready: true,
        body: deltaOf(setOf([linked], LINKED_LINKS, { [KEY_LINKED]: 3 })),
      }),
    });
    expect((await syncSurveys(deps(back, now + 10 * DAY_MS))).written).toBe(1);
    [row] = await surveyRows();
    expect(row).toMatchObject({ unavailable: 0, synced_at: now + 10 * DAY_MS });
    expect((await linksOf(KEY_LINKED)).map(l => l.action_id)).toEqual([ACTION_ID]);
    expect((await getLinkedSurveyForAction(env.DB, ACTION_ID))?.survey.ref).toBe(KEY_LINKED);
  });

  it('keeps a published survey whose link moved to an action not imported yet, and withdraws it once no link is left', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    await syncSurveys(deps(fakeTessera(), now));

    const linked = surveyRecord(TX_LINKED, definition());
    const answer = (govLinks: SurveyListPayload['govLinks']) =>
      fakeTessera({
        changes: async () => ({
          ready: true,
          body: deltaOf(setOf([linked], govLinks, { [KEY_LINKED]: 3 })),
        }),
      });
    // The record is still indexed and still linked, now by an action
    // DRepTalk has not imported yet: eligible on Tessera's facts, so the
    // thread stays and the link is what Tessera says, the card names the
    // action by Tessera's title until discovery imports it.
    const elsewhere: SurveyListPayload['govLinks'] = [
      { surveyKey: KEY_LINKED, actionId: 'gov_action1resubmitted', endEpoch: 300, title: 'Again' },
    ];
    expect(await syncSurveys(deps(answer(elsewhere), now + HOUR_MS))).toMatchObject({
      written: 1,
      rolledBack: 0,
    });
    expect((await surveyRows())[0].unavailable).toBe(0);
    expect(await linksOf(KEY_LINKED)).toEqual([
      { action_id: 'gov_action1resubmitted', title: 'Again' },
    ]);
    expect(await getLinkedSurveyForAction(env.DB, ACTION_ID)).toBeNull();
    expect(await getSurveyGovLinks(env.DB, KEY_LINKED)).toEqual([
      { actionId: 'gov_action1resubmitted', title: 'Again', actionTitle: null, topicSlug: null },
    ]);

    // No link at all: not eligible, in practice the linking action's
    // transaction rolled back, and withdrawn like a rolled-back record:
    // the flag, the links, no row written for it.
    expect(await syncSurveys(deps(answer([]), now + 2 * HOUR_MS))).toMatchObject({
      written: 0,
      rolledBack: 1,
    });
    let [row] = await surveyRows();
    expect(row).toMatchObject({ unavailable: 1, synced_at: now + 2 * HOUR_MS });
    expect(await linksOf(KEY_LINKED)).toEqual([]);

    // Withdrawn once: a run that still finds it ineligible writes nothing.
    expect(await syncSurveys(deps(answer([]), now + 3 * HOUR_MS))).toMatchObject({
      written: 0,
      rolledBack: 0,
    });
    expect((await surveyRows())[0].synced_at).toBe(now + 2 * HOUR_MS);

    // The link is back: cleared and relinked in one write.
    expect(await syncSurveys(deps(answer(LINKED_LINKS), now + 4 * HOUR_MS))).toMatchObject({
      written: 1,
      rolledBack: 0,
    });
    [row] = await surveyRows();
    expect(row).toMatchObject({ unavailable: 0, synced_at: now + 4 * HOUR_MS });
    expect((await linksOf(KEY_LINKED)).map(l => l.action_id)).toEqual([ACTION_ID]);
    expect((await getLinkedSurveyForAction(env.DB, ACTION_ID))?.survey.ref).toBe(KEY_LINKED);
  });

  it('mirrors neither an untalliable survey nor a sealed one on an unsupported drand chain', async () => {
    await importLinkingAction();
    const valid = surveyRecord(TX_LINKED, definition());
    const invalid = surveyRecord(TX_SECOND, definition({ title: 'No questions', questions: [] }));
    const foreignChain = surveyRecord(
      TX_NON_DREP,
      definition({
        title: 'Sealed elsewhere',
        submissionMode: {
          type: 'sealed',
          chainHash: hexToBytes('ff'.repeat(32)),
          round: 1_000,
          paddingSize: 64,
        },
      }),
    );
    const links: SurveyListPayload['govLinks'] = [KEY_LINKED, KEY_SECOND, KEY_NON_DREP].map(
      surveyKey => ({ surveyKey, actionId: ACTION_ID, endEpoch: 300, title: null }),
    );
    const corpus = deltaOf(setOf([valid, invalid, foreignChain], links, {}), [], BOOT_CURSOR);
    const r = await syncSurveys(
      deps(fakeTessera({ changesSince: async () => ({ ready: true, body: corpus }) })),
    );
    // All three are linked to the imported action. Only the valid public
    // survey gets a row and a thread. The other two would be decided
    // untalliable at close, and a thread inviting answers to them wastes
    // every fee spent.
    expect(r).toMatchObject({ written: 1, published: 1, failed: 0 });
    expect((await surveyRows()).map(s => s.ref)).toEqual([KEY_LINKED]);
  });

  it('freezes a survey at any final state, and reads the artifact of a finalized one only', async () => {
    const first = surveyRecord(TX_LINKED, definition());
    const second = surveyRecord(TX_SECOND, definition({ title: 'Second survey' }));
    const links: SurveyListPayload['govLinks'] = [
      { surveyKey: KEY_LINKED, actionId: ACTION_ID, endEpoch: 300, title: 'The linking action' },
      { surveyKey: KEY_SECOND, actionId: ACTION_SECOND, endEpoch: 300, title: 'The other action' },
    ];
    const counts = { [KEY_LINKED]: 3, [KEY_SECOND]: 1 };
    const counted = { [KEY_LINKED]: { 0: 2 }, [KEY_SECOND]: { 0: 1 } };
    const open = setOf([first, second], links, counts, counted);
    await importLinkingAction();
    await importLinkingAction(ACTION_SECOND);
    await syncSurveys(
      deps(
        fakeTessera({
          changesSince: async () => ({ ready: true, body: deltaOf(open, [], BOOT_CURSOR) }),
        }),
      ),
    );
    // The delta declares both decided for good, one cancelled, one
    // finalized, each with an artifact. Only the cancelled one may surface as
    // a cancellation. Both must freeze. Only the finalized one's artifact is
    // a count to read.
    const decided: SurveyListPayload = {
      ...open,
      finalState: {
        [KEY_LINKED]: { state: 'cancelled', artifactHash: 'ab'.repeat(32) },
        [KEY_SECOND]: { state: 'finalized', artifactHash: 'cd'.repeat(32) },
      },
    };
    const asked: string[] = [];
    const r = await syncSurveys(
      deps(
        fakeTessera({
          changes: async () => ({ ready: true, body: deltaOf(decided) }),
          artifactByHash: async hash => {
            asked.push(hash);
            return artifactOf(1);
          },
        }),
      ),
    );
    expect(r).toMatchObject({ written: 2, finalCounts: 1, failed: 0 });
    expect(asked).toEqual(['cd'.repeat(32)]);
    expect(await surveyRows()).toMatchObject([
      {
        ref: KEY_LINKED,
        cancelled: 1,
        final_state: 'cancelled',
        artifact_hash: 'ab'.repeat(32),
        counted_dreps: 2,
        final_counted_dreps: null,
      },
      {
        ref: KEY_SECOND,
        cancelled: 0,
        final_state: 'finalized',
        artifact_hash: 'cd'.repeat(32),
        counted_dreps: 1,
        final_counted_dreps: 1,
      },
    ]);
    // Both decided: a re-delivery is written like any other row, one rule
    // for every row, and Tessera does not move a decided survey anyway, but
    // no artifact is read again, since the count it carried is stored.
    const again = await syncSurveys(
      deps(
        fakeTessera({
          changes: async () => ({ ready: true, body: deltaOf(decided) }),
          artifactByHash: async () => {
            throw new Error('a counted artifact must not be read again');
          },
        }),
      ),
    );
    expect(again).toMatchObject({ written: 2, finalCounts: 0, failed: 0 });
    // The write leaves the artifact's count alone: it is the artifact pass's
    // column, not the delta's.
    expect((await surveyRows()).map(r => r.final_counted_dreps)).toEqual([null, 1]);
  });

  it('keeps asking for the artifact of a finalized survey until it answers', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    await syncSurveys(deps(fakeTessera(), now));

    const linked = surveyRecord(TX_LINKED, definition());
    const finalized = (artifactByHash: SurveysTessera['artifactByHash']) =>
      fakeTessera({
        changes: async () => ({
          ready: true,
          body: deltaOf({
            ...setOf([linked], LINKED_LINKS, { [KEY_LINKED]: 3 }),
            finalState: FINALIZED,
          }),
        }),
        artifactByHash,
      });

    // The decision arrives while the artifact route is down: the decision and
    // its hash are kept, the in-window figure stands, the failure is charged.
    const down = finalized(async () => {
      throw new TesseraHttpError('/api/artifacts', 500, '');
    });
    expect(await syncSurveys(deps(down, now + HOUR_MS))).toMatchObject({
      written: 1,
      finalCounts: 0,
      failed: 1,
    });
    let [row] = await surveyRows();
    expect(row).toMatchObject({
      final_state: 'finalized',
      artifact_hash: ARTIFACT_HASH,
      counted_dreps: 2,
      final_counted_dreps: null,
    });

    // The backend does not know the hash it named: a failure too, not a
    // count of nothing.
    expect(
      await syncSurveys(
        deps(
          finalized(async () => null),
          now + 2 * HOUR_MS,
        ),
      ),
    ).toMatchObject({ written: 1, finalCounts: 0, failed: 1 });

    // Next run: the artifact is asked for again, and a finalized tally can
    // count fewer DReps than the in-window figure did (end-epoch role
    // membership), which is the number to show.
    const asked: string[] = [];
    const up = finalized(async hash => {
      asked.push(hash);
      return artifactOf(1);
    });
    expect(await syncSurveys(deps(up, now + 3 * HOUR_MS))).toMatchObject({
      written: 1,
      finalCounts: 1,
      failed: 0,
    });
    expect(asked).toEqual([ARTIFACT_HASH]);
    [row] = await surveyRows();
    expect(row).toMatchObject({ counted_dreps: 2, final_counted_dreps: 1 });
  });

  it('reads the artifact again when a delivery moves the hash beside a stored count', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    const linked = surveyRecord(TX_LINKED, definition());
    const decidedWith = (artifactHash: string): SurveyListPayload => ({
      ...setOf([linked], LINKED_LINKS, { [KEY_LINKED]: 3 }),
      finalState: { [KEY_LINKED]: { state: 'finalized', artifactHash } },
    });
    const asked: string[] = [];
    const serving = (dreps: number, body: SurveyListPayload) =>
      fakeTessera({
        changesSince: async () => ({ ready: true, body: deltaOf(body, [], BOOT_CURSOR) }),
        changes: async () => ({ ready: true, body: deltaOf(body) }),
        artifactByHash: async hash => {
          asked.push(hash);
          return artifactOf(dreps);
        },
      });
    await syncSurveys(deps(serving(1, decidedWith(ARTIFACT_HASH)), now));
    expect((await surveyRows())[0]).toMatchObject({
      artifact_hash: ARTIFACT_HASH,
      final_counted_dreps: 1,
    });

    // A re-projection names another artifact: the stored count described the
    // old one, so it goes with the hash and the new artifact is read, a
    // count never sits beside a hash it was not read from.
    const other = 'ef'.repeat(32);
    expect(await syncSurveys(deps(serving(2, decidedWith(other)), now + HOUR_MS))).toMatchObject({
      written: 1,
      finalCounts: 1,
      failed: 0,
    });
    expect(asked).toEqual([ARTIFACT_HASH, other]);
    expect((await surveyRows())[0]).toMatchObject({ artifact_hash: other, final_counted_dreps: 2 });
  });

  it('reads the artifact of a survey stored already finalized in the same run', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    const linked = surveyRecord(TX_LINKED, definition());
    const decided: SurveyListPayload = {
      ...setOf([linked], LINKED_LINKS, { [KEY_LINKED]: 3 }),
      finalState: FINALIZED,
    };
    const fake = fakeTessera({
      changesSince: async () => ({ ready: true, body: deltaOf(decided, [], BOOT_CURSOR) }),
      // No DRep entry at all: nobody was counted at close.
      artifactByHash: async () => artifactOf(0),
    });
    expect(await syncSurveys(deps(fake, now))).toMatchObject({
      written: 1,
      published: 1,
      finalCounts: 1,
      failed: 0,
    });
    expect((await surveyRows())[0]).toMatchObject({
      final_state: 'finalized',
      artifact_hash: ARTIFACT_HASH,
      counted_dreps: 2,
      final_counted_dreps: 0,
    });
  });

  it('serves the page readers: by topic, the category list, and the /s/<ref> slug', async () => {
    await importLinkingAction();
    await syncSurveys(deps(fakeTessera()));

    const [row] = await surveyRows();
    const byTopic = await getSurveyByTopicId(env.DB, threadOf(row));
    expect(byTopic).toMatchObject({
      ref: KEY_LINKED,
      endEpoch: 300,
      eligibleRoles: [Role.DRep],
      countedDreps: 2,
      finalCountedDreps: null,
      sealed: false,
      unavailable: false,
    });
    // The stored wire record must decode back to the definition.
    expect(byTopic?.definitionJson).toContain('Which budget line matters most?');

    const list = await listSurveysWithTopics(env.DB, { limit: 10, offset: 0 });
    expect(list).toHaveLength(1);
    expect(list[0].postCount).toBe(1);
    expect(list[0].topicSlug).toContain('treasury-priorities');
    expect(list[0].topicTitle).toBe('Treasury priorities');

    expect(await getTopicSlugBySurveyRef(env.DB, KEY_LINKED)).toBe(list[0].topicSlug);
    expect(await getTopicSlugBySurveyRef(env.DB, `${'9'.repeat(64)}:0`)).toBeNull();

    // Linkage, both directions. The action's own topic id names no real topic
    // row here, so the survey-side view resolves the title but no thread link.
    expect(await getSurveyGovLinks(env.DB, KEY_LINKED)).toEqual([
      {
        actionId: ACTION_ID,
        title: 'The linking action',
        actionTitle: 'The linking action',
        topicSlug: null,
      },
    ]);
    const linked = await getLinkedSurveyForAction(env.DB, ACTION_ID);
    expect(linked?.survey.ref).toBe(KEY_LINKED);
    expect(linked?.topicSlug).toBe(list[0].topicSlug);
    expect(linked?.topicTitle).toBe('Treasury priorities');
    expect(await getLinkedSurveyForAction(env.DB, 'gov_action1unknown')).toBeNull();
  });

  it('skips the run without recording an error while the backend has no snapshot', async () => {
    const empty = {
      notReady: true,
      written: 0,
      published: 0,
      rolledBack: 0,
      finalCounts: 0,
      tallies: 0,
      failed: 0,
    };
    // Before the bootstrap, and once a cursor is held.
    expect(
      await syncSurveys(deps(fakeTessera({ changesSince: async () => ({ ready: false }) }))),
    ).toEqual(empty);
    expect(await getSurveySyncState(env.DB)).toEqual({
      changesCursor: null,
      tesseraFetchedAt: null,
      incomplete: false,
    });
    await importLinkingAction();
    await syncSurveys(deps(fakeTessera()));
    expect(
      await syncSurveys(deps(fakeTessera({ changes: async () => ({ ready: false }) }))),
    ).toEqual(empty);
    expect(await getSurveySyncState(env.DB)).toEqual({
      changesCursor: BOOT_CURSOR,
      tesseraFetchedAt: tip.time,
      incomplete: false,
    });
  });

  it('dates the mirror by the last answer it applied, and not at all when a pass broke off', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    const linked = surveyRecord(TX_LINKED, definition());
    // A bootstrap of two pages, each read at the generation published when its
    // own request arrived. The cursor is a keyset, so a row re-stamped after
    // page one comes back on a later page: what the mirror reflects when it
    // reaches the end is the page it finished on, not the one it started with.
    const boot = fakeTessera({
      changesSince: async () => ({
        ready: true,
        body: {
          ...deltaOf(setOf(bulkOf(), [], {}), [], 'boot-page-2'),
          fetchedAt: tip.time - 100,
        },
      }),
      changes: async () => ({
        ready: true,
        body: {
          ...deltaOf(setOf([linked], LINKED_LINKS, { [KEY_LINKED]: 3 }), [], BOOT_CURSOR),
          fetchedAt: tip.time - 40,
        },
      }),
    });
    await syncSurveys(deps(boot, now));
    expect(await getSurveySyncState(env.DB)).toMatchObject({
      changesCursor: BOOT_CURSOR,
      tesseraFetchedAt: tip.time - 40,
    });

    // The delta fails: no row was brought up to anything, so the stamp must
    // not move.
    const broken = fakeTessera({
      changes: async () => {
        throw new TesseraHttpError('/api/surveys', 500, '');
      },
    });
    expect((await syncSurveys(deps(broken, now + HOUR_MS))).failed).toBe(1);
    expect((await getSurveySyncState(env.DB)).tesseraFetchedAt).toBe(tip.time - 40);

    // A quiet delta from a newer generation: every row reflects it.
    const quiet = fakeTessera({
      changes: async () => ({
        ready: true,
        body: { ...deltaOf(setOf([], [], {})), fetchedAt: tip.time + 180 },
      }),
    });
    await syncSurveys(deps(quiet, now + 2 * HOUR_MS));
    expect((await getSurveySyncState(env.DB)).tesseraFetchedAt).toBe(tip.time + 180);
  });
});

// The informational tally, pass 4. Every trigger is funnelled into the durable
// queue and the work order is read from the queue alone, and the request budget
// is reserved per REQUEST, because the unbounded dimension of a bundle is its
// pages rather than the bundle itself.
describe('syncSurveys tally pass', () => {
  it('writes a tally for a survey the delta delivered', async () => {
    await importLinkingAction();
    await seedPower();

    const r = await syncSurveys(deps(fakeTessera(), NOW));
    expect(r).toMatchObject({ written: 1, tallies: 1, failed: 0 });

    const t = await getSurveyTally(env.DB, KEY_LINKED);
    expect(t).toMatchObject({
      weightedSource: 'live',
      headcountSource: 'audit',
      artifactHash: null,
      powerEpoch: POWER_EPOCH,
      counted: 2,
      matchedCount: 2,
      answeredPower: '5000000',
      totalPower: '20000000000000',
      computedAt: NOW_S,
      bundleFetchedAt: tip.time,
    });
    // Written, so the queue row this run stamped is gone.
    expect(await takeSurveyTallyWork(env.DB, 10)).toEqual([]);
  });

  // The stamp's UNIT, asserted the way the card actually consumes it rather than
  // as a bare number. SurveyTally.astro renders formatRelativeTime(computedAt *
  // 1000, now), and formatRelativeTime answers 'just now' for every diff under a
  // minute, negative ones included. So a computedAt written in milliseconds would
  // read as "computed just now" for ever, which is exactly the claim the line
  // exists to avoid, and no equality assertion on the number would say so.
  it('stamps computed_at in seconds, so the reading ages instead of reading as fresh for ever', async () => {
    await importLinkingAction();
    await seedPower();
    await syncSurveys(deps(fakeTessera(), NOW));

    const t = await getSurveyTally(env.DB, KEY_LINKED);
    expect(formatRelativeTime(t!.computedAt * 1000, NOW + HOUR_MS)).toBe('1h ago');
    // And the same unit as its neighbour, which arrives from the serving tier in
    // seconds: the two columns may never drift apart by a factor of 1000.
    expect(Math.abs(t!.computedAt - t!.bundleFetchedAt)).toBeLessThan(86_400);
  });

  it('dequeues only after a successful write', async () => {
    await importLinkingAction();
    await seedPower();

    const down = fakeTessera({
      bundle: async () => {
        throw new TesseraHttpError('/api/surveys/a/0', 500, '');
      },
    });
    expect(await syncSurveys(deps(down, NOW))).toMatchObject({ tallies: 0, failed: 1 });
    expect(await getSurveyTally(env.DB, KEY_LINKED)).toBeNull();
    expect(await takeSurveyTallyWork(env.DB, 10)).toEqual([KEY_LINKED]);

    // The next tick delivers nothing, so the durable queue row is the only
    // work order there is, and it is dropped once the write lands.
    expect(await syncSurveys(deps(fakeTessera(), NOW + HOUR_MS))).toMatchObject({
      written: 0,
      tallies: 1,
    });
    expect(await getSurveyTally(env.DB, KEY_LINKED)).not.toBeNull();
    expect(await takeSurveyTallyWork(env.DB, 10)).toEqual([]);
  });

  it('gives an existing survey its first tally with no new delta at all', async () => {
    await importLinkingAction();
    await seedPower();
    await syncSurveys(deps(fakeTessera(), NOW));

    // The migration day: the survey row and the delta cursor are stored while
    // both tally tables are empty. Without the no-row trigger this survey would
    // never be tallied: no delta delivers it again, and the staleness query
    // reads the very table it has no row in.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM survey_tally'),
      env.DB.prepare('DELETE FROM survey_tally_queue'),
    ]);
    const silent = fakeTessera({
      changesSince: async () => {
        throw new Error('no bootstrap once a cursor is held');
      },
    });
    expect(await syncSurveys(deps(silent, NOW + HOUR_MS))).toMatchObject({
      written: 0,
      tallies: 1,
      failed: 0,
    });
    expect((await getSurveyTally(env.DB, KEY_LINKED))?.counted).toBe(2);
  });

  it('leaves a capped-out survey queued and tallies it on the next run', async () => {
    // Stored with no power history, so the first run queues both surveys and
    // tallies neither.
    const two = fakeTessera({
      changesSince: async () => ({
        ready: true,
        body: deltaOf(corpusOf([KEY_LINKED, KEY_SECOND]), [], BOOT_CURSOR),
      }),
    });
    expect(await syncSurveys(deps(two, NOW))).toMatchObject({ written: 2, tallies: 0 });
    await seedPower();
    await orderQueue([KEY_LINKED, KEY_SECOND]);

    // The first survey's bundle costs the whole allowance.
    const log: string[] = [];
    const paging = fakeTessera({ bundle: pagingBundle({ [KEY_LINKED]: QUIET_BUDGET }, log) });
    expect(await syncSurveys(deps(paging, NOW + HOUR_MS))).toMatchObject({
      tallies: 1,
      failed: 0,
    });
    expect(await getSurveyTally(env.DB, KEY_LINKED)).not.toBeNull();
    expect(await getSurveyTally(env.DB, KEY_SECOND)).toBeNull();
    expect(await takeSurveyTallyWork(env.DB, 10)).toEqual([KEY_SECOND]);
    // Nothing was even asked about the second survey: the budget was gone
    // before its turn came.
    expect(log.filter(e => e.startsWith(KEY_SECOND))).toEqual([]);

    const next: string[] = [];
    expect(
      await syncSurveys(deps(fakeTessera({ bundle: pagingBundle({}, next) }), NOW + 2 * HOUR_MS)),
    ).toMatchObject({ tallies: 1 });
    expect(await getSurveyTally(env.DB, KEY_SECOND)).not.toBeNull();
    expect(await takeSurveyTallyWork(env.DB, 10)).toEqual([]);
    expect(next.map(e => e.split('@')[0])).toEqual([KEY_SECOND]);
  });

  it('counts every bundle PAGE against the budget, not every bundle', async () => {
    const three = fakeTessera({
      changesSince: async () => ({
        ready: true,
        body: deltaOf(corpusOf([KEY_LINKED, KEY_SECOND, KEY_UNLINKED]), [], BOOT_CURSOR),
      }),
    });
    expect(await syncSurveys(deps(three, NOW))).toMatchObject({ written: 3, tallies: 0 });
    await seedPower();
    await orderQueue([KEY_LINKED, KEY_SECOND, KEY_UNLINKED]);

    // A bundle of many pages costs one request per page. Counting bundles
    // instead would leave the allowance almost untouched and tally all three.
    const log: string[] = [];
    const paging = fakeTessera({
      bundle: pagingBundle({ [KEY_LINKED]: QUIET_BUDGET - 1, [KEY_SECOND]: 1 }, log),
    });
    expect(await syncSurveys(deps(paging, NOW + HOUR_MS))).toMatchObject({
      tallies: 2,
      failed: 0,
    });
    expect(log.length).toBe(QUIET_BUDGET);
    expect(await getSurveyTally(env.DB, KEY_LINKED)).not.toBeNull();
    expect(await getSurveyTally(env.DB, KEY_SECOND)).not.toBeNull();
    expect(await getSurveyTally(env.DB, KEY_UNLINKED)).toBeNull();
    expect(await takeSurveyTallyWork(env.DB, 10)).toEqual([KEY_UNLINKED]);
  });

  it('aborts mid-collection when the budget runs out and writes nothing', async () => {
    await seedPower();
    // A bundle that never ends: the reservation refuses the page after the
    // allowance, and a half-collected bundle is a wrong result, not a stale one.
    const log: string[] = [];
    const endless = fakeTessera({
      bundle: async (_survey, cursor) => {
        log.push(String(cursor ?? 'first'));
        return { ready: true, body: bundlePage(twoResponses(), { nextCursor: 'more' }) };
      },
    });
    // Out of budget is a deferral, not a failure.
    expect(await syncSurveys(deps(endless, NOW))).toMatchObject({ tallies: 0, failed: 0 });
    expect(log.length).toBe(QUIET_BUDGET);
    expect(await getSurveyTally(env.DB, KEY_LINKED)).toBeNull();
    expect(await takeSurveyTallyWork(env.DB, 10)).toEqual([KEY_LINKED]);
  });

  it('counts resync restarts against the budget', async () => {
    const three = fakeTessera({
      changesSince: async () => ({
        ready: true,
        body: deltaOf(corpusOf([KEY_LINKED, KEY_SECOND, KEY_UNLINKED]), [], BOOT_CURSOR),
      }),
    });
    await syncSurveys(deps(three, NOW));
    await seedPower();
    await orderQueue([KEY_LINKED, KEY_SECOND, KEY_UNLINKED]);

    // The first survey's second page reports resync once, so the collection is
    // abandoned and restarted: its first page is fetched a second time and that
    // repeat is a further reserved request. Four requests for one bundle, and
    // the third survey is out of allowance because of it.
    const log: string[] = [];
    const paged = pagingBundle({ [KEY_SECOND]: QUIET_BUDGET - 4 }, log);
    let resynced = false;
    const fake = fakeTessera({
      bundle: async (survey, cursor) => {
        const ref = survey as string;
        if (ref !== KEY_LINKED) return paged(survey, cursor);
        log.push(`${ref}@${cursor ?? 'first'}`);
        if (!cursor) return { ready: true, body: bundlePage(twoResponses(), { nextCursor: 'p2' }) };
        if (!resynced) {
          resynced = true;
          return { ready: true, body: bundlePage([], { resync: true }) };
        }
        return { ready: true, body: bundlePage([], { nextCursor: null }) };
      },
    });
    expect(await syncSurveys(deps(fake, NOW + HOUR_MS))).toMatchObject({
      tallies: 2,
      failed: 0,
    });
    expect(log.filter(e => e.startsWith(KEY_LINKED)).length).toBe(4);
    expect(log.length).toBe(QUIET_BUDGET);
    expect(await getSurveyTally(env.DB, KEY_UNLINKED)).toBeNull();
    expect(await takeSurveyTallyWork(env.DB, 10)).toEqual([KEY_UNLINKED]);
  });

  it('refuses the artifact read when no budget is left for it', async () => {
    await importLinkingAction();
    await syncSurveys(deps(fakeTessera(), NOW));
    await seedPower();

    // This run spends two requests before the tally pass: the delta, and the
    // final-count pass's own artifact read. The bundle then takes the rest, so
    // the tally pass has nothing left to reserve for its artifact request.
    const artifacts: string[] = [];
    const log: string[] = [];
    const fake = fakeTessera({
      changes: async () => ({
        ready: true,
        body: deltaOf({ ...corpusOf([KEY_LINKED]), finalState: FINALIZED }),
      }),
      artifactByHash: async hash => {
        artifacts.push(hash);
        return tallyArtifact();
      },
      bundle: pagingBundle({ [KEY_LINKED]: MAX_TALLY_REQUESTS - 2 }, log),
    });
    expect(await syncSurveys(deps(fake, NOW + HOUR_MS))).toMatchObject({
      finalCounts: 1,
      tallies: 0,
      failed: 0,
    });
    // Only the final-count pass asked. A budget that ignored what the earlier
    // passes spent would have had room for a second artifact request here.
    expect(artifacts).toEqual([ARTIFACT_HASH]);
    expect(log.length).toBe(MAX_TALLY_REQUESTS - 2);
    expect(await getSurveyTally(env.DB, KEY_LINKED)).toBeNull();
    expect(await takeSurveyTallyWork(env.DB, 10)).toEqual([KEY_LINKED]);
  });

  it('records an attempt and does not starve a third survey when a fetch throws', async () => {
    const three = fakeTessera({
      changesSince: async () => ({
        ready: true,
        body: deltaOf(corpusOf([KEY_LINKED, KEY_SECOND, KEY_UNLINKED]), [], BOOT_CURSOR),
      }),
    });
    await syncSurveys(deps(three, NOW));
    await seedPower();
    await orderQueue([KEY_LINKED, KEY_SECOND, KEY_UNLINKED]);

    const log: string[] = [];
    const paged = pagingBundle({}, log);
    const fake = fakeTessera({
      bundle: async (survey, cursor) => {
        if ((survey as string) === KEY_LINKED) throw new TesseraHttpError('/api/surveys', 500, '');
        return paged(survey, cursor);
      },
    });
    expect(await syncSurveys(deps(fake, NOW + HOUR_MS))).toMatchObject({
      tallies: 2,
      failed: 1,
    });
    expect(await getSurveyTally(env.DB, KEY_LINKED)).toBeNull();
    expect(await getSurveyTally(env.DB, KEY_SECOND)).not.toBeNull();
    expect(await getSurveyTally(env.DB, KEY_UNLINKED)).not.toBeNull();
    expect(await takeSurveyTallyWork(env.DB, 10)).toEqual([KEY_LINKED]);

    // The attempt was recorded, so a never-tried survey sorts ahead of the one
    // that keeps failing and it can never hold the front of the queue.
    await enqueueSurveyTallies(env.DB, [KEY_NON_DREP], NOW + 2 * HOUR_MS);
    expect(await takeSurveyTallyWork(env.DB, 10)).toEqual([KEY_NON_DREP, KEY_LINKED]);
  });

  it('writes nothing when the bundle collection throws its restart limit', async () => {
    await seedPower();
    const log: string[] = [];
    const churning = fakeTessera({
      bundle: async (_survey, cursor) => {
        log.push(String(cursor ?? 'first'));
        if (!cursor) return { ready: true, body: bundlePage(twoResponses(), { nextCursor: 'p2' }) };
        return { ready: true, body: bundlePage([], { resync: true }) };
      },
    });
    expect(await syncSurveys(deps(churning, NOW))).toMatchObject({ tallies: 0, failed: 1 });
    // Two pages per attempt, one attempt more than the restart limit allows.
    expect(log.length).toBe(2 * (MAX_BUNDLE_RESYNCS + 1));
    expect(await getSurveyTally(env.DB, KEY_LINKED)).toBeNull();
    expect(await takeSurveyTallyWork(env.DB, 10)).toEqual([KEY_LINKED]);
  });

  it('requeues a live row after an epoch advance and never an artifact row', async () => {
    await seedPower();
    const both = fakeTessera({
      changesSince: async () => ({
        ready: true,
        body: deltaOf(
          corpusOf([KEY_LINKED, KEY_SECOND], {
            finalState: { [KEY_SECOND]: { state: 'finalized', artifactHash: ARTIFACT_HASH } },
          }),
          [],
          BOOT_CURSOR,
        ),
      }),
      artifactByHash: async () => tallyArtifact(),
    });
    expect(await syncSurveys(deps(both, NOW))).toMatchObject({ tallies: 2, failed: 0 });
    const artifactRow = await getSurveyTally(env.DB, KEY_SECOND);
    expect(artifactRow).toMatchObject({
      weightedSource: 'artifact',
      powerEpoch: ARTIFACT_END_EPOCH,
    });
    // Both were written, so neither is in the queue: the staleness funnel is
    // what has to put the live one back.
    expect(await takeSurveyTallyWork(env.DB, 10)).toEqual([]);

    await advancePowerEpoch(POWER_EPOCH + 1);
    const log: string[] = [];
    const quiet = fakeTessera({
      artifactByHash: async () => tallyArtifact(),
      bundle: pagingBundle({}, log),
    });
    expect(await syncSurveys(deps(quiet, NOW + HOUR_MS))).toMatchObject({
      tallies: 1,
      failed: 0,
    });
    expect((await getSurveyTally(env.DB, KEY_LINKED))?.powerEpoch).toBe(POWER_EPOCH + 1);
    // The artifact row weighs at the survey's end epoch, which every later
    // local epoch passes, so requeueing it would never stop.
    expect(await getSurveyTally(env.DB, KEY_SECOND)).toEqual(artifactRow);
    expect(log.map(e => e.split('@')[0])).toEqual([KEY_LINKED]);
  });

  it('selects strictly by queue attempt history, not by trigger order', async () => {
    await seedPower();
    const both = fakeTessera({
      changesSince: async () => ({
        ready: true,
        body: deltaOf(corpusOf([KEY_LINKED, KEY_SECOND]), [], BOOT_CURSOR),
      }),
    });
    expect(await syncSurveys(deps(both, NOW))).toMatchObject({ tallies: 2 });

    // The state under test: the second survey is back to having no tally row
    // and no queue row (the no-row trigger's candidate), while the first is a
    // stale live row whose last attempt failed. Staleness is funnelled first,
    // and the queue's own order has to override that.
    await deleteSurveyTallies(env.DB, [KEY_SECOND]);
    await enqueueSurveyTallies(env.DB, [KEY_LINKED], NOW);
    await markSurveyTallyAttempt(env.DB, KEY_LINKED, NOW);
    await advancePowerEpoch(POWER_EPOCH + 1);

    // The never-tried survey must go first and take the whole allowance. Were
    // the stale one picked first it would be recomputed at the new epoch and
    // the never-tried one would abort one page short.
    const log: string[] = [];
    const paging = fakeTessera({ bundle: pagingBundle({ [KEY_SECOND]: QUIET_BUDGET }, log) });
    expect(await syncSurveys(deps(paging, NOW + HOUR_MS))).toMatchObject({
      tallies: 1,
      failed: 0,
    });
    expect((await getSurveyTally(env.DB, KEY_SECOND))?.powerEpoch).toBe(POWER_EPOCH + 1);
    expect((await getSurveyTally(env.DB, KEY_LINKED))?.powerEpoch).toBe(POWER_EPOCH);
    expect(await takeSurveyTallyWork(env.DB, 10)).toEqual([KEY_LINKED]);
    expect(log.filter(e => e.startsWith(KEY_LINKED))).toEqual([]);
  });

  it('takes every weighted figure from the artifact once the survey is finalized', async () => {
    await seedPower();
    const finalized = fakeTessera({
      changesSince: async () => ({
        ready: true,
        body: deltaOf(corpusOf([KEY_LINKED], { finalState: FINALIZED }), [], BOOT_CURSOR),
      }),
      artifactByHash: async () => tallyArtifact(),
    });
    expect(await syncSurveys(deps(finalized, NOW))).toMatchObject({
      finalCounts: 1,
      tallies: 1,
      failed: 0,
    });
    const t = await getSurveyTally(env.DB, KEY_LINKED);
    expect(t).toMatchObject({
      weightedSource: 'artifact',
      headcountSource: 'audit',
      artifactHash: ARTIFACT_HASH,
      // The epoch the artifact committed its weighting to, not the local one.
      powerEpoch: ARTIFACT_END_EPOCH,
      matchedCount: 1,
      answeredPower: '7000000',
      totalPower: '50000000',
      // The head count stays ours: an artifact carries none.
      counted: 2,
    });
  });

  it('stays on the artifact path when the artifact has no DRep role', async () => {
    await seedPower();
    const finalized = fakeTessera({
      changesSince: async () => ({
        ready: true,
        body: deltaOf(corpusOf([KEY_LINKED], { finalState: FINALIZED }), [], BOOT_CURSOR),
      }),
      // A role with no counted responder is absent from perRole, which means
      // zero, not an absent artifact.
      artifactByHash: async () => tallyArtifact({ dreps: null }),
    });
    expect(await syncSurveys(deps(finalized, NOW))).toMatchObject({ tallies: 1, failed: 0 });
    const t = await getSurveyTally(env.DB, KEY_LINKED);
    expect(t).toMatchObject({
      weightedSource: 'artifact',
      artifactHash: ARTIFACT_HASH,
      matchedCount: 0,
      answeredPower: '0',
      totalPower: null,
      counted: 2,
    });
    // The head count survives, which is the whole point of the unit-weight run.
    expect(t?.questions.headcount).toHaveLength(1);
    expect(t?.questions.weighted).toEqual([]);
  });

  it('tallies a sealed survey from its artifact and marks the head count source', async () => {
    await seedPower();
    // Sealed on quicknet, so admission stores it. Responses stay encrypted, so
    // the bundle carries none here: nothing can read an answer before the
    // artifact exists.
    const sealed = definition({
      title: 'Sealed poll',
      submissionMode: {
        type: 'sealed',
        chainHash: QUICKNET_CHAIN_HASH,
        round: 1_000,
        paddingSize: 64,
      },
    });
    const defs = { [KEY_LINKED]: sealed };
    const open = fakeTessera({
      changesSince: async () => ({
        ready: true,
        body: deltaOf(corpusOf([KEY_LINKED], { defs }), [], BOOT_CURSOR),
      }),
      bundle: async () => ({ ready: true, body: bundlePage([]) }),
    });
    // No artifact: no row at all, rather than a row claiming an empty result.
    expect(await syncSurveys(deps(open, NOW))).toMatchObject({
      written: 1,
      tallies: 0,
      failed: 0,
    });
    expect(await getSurveyTally(env.DB, KEY_LINKED)).toBeNull();

    const closed = fakeTessera({
      changes: async () => ({
        ready: true,
        body: deltaOf({ ...corpusOf([KEY_LINKED], { defs }), finalState: FINALIZED }),
      }),
      artifactByHash: async () => tallyArtifact(),
      bundle: async () => ({ ready: true, body: bundlePage([]) }),
    });
    expect(await syncSurveys(deps(closed, NOW + HOUR_MS))).toMatchObject({
      tallies: 1,
      failed: 0,
    });
    const t = await getSurveyTally(env.DB, KEY_LINKED);
    expect(t).toMatchObject({ weightedSource: 'artifact', headcountSource: 'artifact' });
    expect(t?.questions.headcount).toEqual(t?.questions.weighted);
  });

  it('deletes the old tally when the artifact hash changes, so nothing stale shows', async () => {
    await seedPower();
    const serving = (artifactHash: string, artifact: () => TallyArtifact | null) =>
      fakeTessera({
        changesSince: async () => ({
          ready: true,
          body: deltaOf(
            corpusOf([KEY_LINKED], {
              finalState: { [KEY_LINKED]: { state: 'finalized', artifactHash } },
            }),
            [],
            BOOT_CURSOR,
          ),
        }),
        changes: async () => ({
          ready: true,
          body: deltaOf(
            corpusOf([KEY_LINKED], {
              finalState: { [KEY_LINKED]: { state: 'finalized', artifactHash } },
            }),
          ),
        }),
        artifactByHash: async () => artifact(),
      });
    await syncSurveys(deps(serving(ARTIFACT_HASH, () => tallyArtifact()), NOW));
    expect(await getSurveyTally(env.DB, KEY_LINKED)).toMatchObject({
      artifactHash: ARTIFACT_HASH,
    });

    // A second artifact is named and cannot be read. The old figures describe
    // the old artifact, so they go rather than keep being shown as current.
    const moved = 'ef'.repeat(32);
    const r = await syncSurveys(
      deps(
        serving(moved, () => {
          throw new TesseraHttpError('/api/artifacts', 500, '');
        }),
        NOW + HOUR_MS,
      ),
    );
    expect(r).toMatchObject({ written: 1, tallies: 0, failed: 2 });
    expect(await getSurveyTally(env.DB, KEY_LINKED)).toBeNull();
    expect(await takeSurveyTallyWork(env.DB, 10)).toEqual([KEY_LINKED]);
  });

  it('refuses the write when the survey was withdrawn during the fetch', async () => {
    await seedPower();
    const vanishing = fakeTessera({
      bundle: async () => {
        await env.DB.prepare('DELETE FROM survey WHERE ref = ?').bind(KEY_LINKED).run();
        return { ready: true, body: bundlePage(twoResponses()) };
      },
    });
    expect(await syncSurveys(deps(vanishing, NOW))).toMatchObject({ tallies: 0, failed: 0 });
    expect(await getSurveyTally(env.DB, KEY_LINKED)).toBeNull();
    expect(await takeSurveyTallyWork(env.DB, 10)).toEqual([KEY_LINKED]);
  });

  it('refuses the write when an artifact appeared during the fetch', async () => {
    await seedPower();
    const overtaken = fakeTessera({
      bundle: async () => {
        await env.DB.prepare('UPDATE survey SET artifact_hash = ? WHERE ref = ?')
          .bind(ARTIFACT_HASH, KEY_LINKED)
          .run();
        return { ready: true, body: bundlePage(twoResponses()) };
      },
    });
    // The computation assumed no artifact, so its result may not be stored
    // beside one.
    expect(await syncSurveys(deps(overtaken, NOW))).toMatchObject({ tallies: 0, failed: 0 });
    expect(await getSurveyTally(env.DB, KEY_LINKED)).toBeNull();
    expect(await takeSurveyTallyWork(env.DB, 10)).toEqual([KEY_LINKED]);
  });

  it('deletes tally rows only for surveys the withdrawal actually deleted', async () => {
    // One published survey (its linking action is imported) and one with no
    // thread. Withdrawal deletes the second and only flags the first.
    await importLinkingAction();
    await seedPower();
    const both = fakeTessera({
      changesSince: async () => ({
        ready: true,
        body: deltaOf(corpusOf([KEY_LINKED, KEY_SECOND]), [], BOOT_CURSOR),
      }),
    });
    expect(await syncSurveys(deps(both, NOW))).toMatchObject({ published: 1, tallies: 2 });

    const gone = fakeTessera({
      changes: async () => ({
        ready: true,
        body: deltaOf(setOf([], [], {}), [KEY_LINKED, KEY_SECOND]),
      }),
    });
    expect(await syncSurveys(deps(gone, NOW + HOUR_MS))).toMatchObject({ rolledBack: 2 });
    // The published row kept its thread and its figures: a removal is advisory
    // and can be transient, and the card shows the unavailable reason instead
    // of the figures while it stands.
    expect(await getSurveyTally(env.DB, KEY_LINKED)).not.toBeNull();
    expect((await surveyRows())[0]).toMatchObject({ ref: KEY_LINKED, unavailable: 1 });
    // The deleted row's derived figures went with it: D1 has no cascade.
    expect(await getSurveyTally(env.DB, KEY_SECOND)).toBeNull();
    expect(await takeSurveyTallyWork(env.DB, 10)).toEqual([]);
  });

  it('writes no tally for an external-content, cancelled or untalliable survey', async () => {
    await seedPower();
    const external = definition({
      title: 'External poll',
      contentAnchor: { uri: 'ipfs://QmExternal', hash: hexToBytes('ab'.repeat(32)) },
    });
    const mixed = fakeTessera({
      changesSince: async () => ({
        ready: true,
        body: deltaOf(
          corpusOf([KEY_LINKED, KEY_SECOND, KEY_UNLINKED], {
            defs: { [KEY_LINKED]: external },
            finalState: {
              [KEY_SECOND]: { state: 'cancelled', artifactHash: ARTIFACT_HASH },
              [KEY_UNLINKED]: { state: 'untalliable' },
            },
          }),
          [],
          BOOT_CURSOR,
        ),
      }),
    });
    expect(await syncSurveys(deps(mixed, NOW))).toMatchObject({ written: 3, tallies: 0 });
    // No row at all, not an empty one: none of the three has figures to show.
    expect(await getSurveyTally(env.DB, KEY_LINKED)).toBeNull();
    expect(await getSurveyTally(env.DB, KEY_SECOND)).toBeNull();
    expect(await getSurveyTally(env.DB, KEY_UNLINKED)).toBeNull();
    // The queue row survives, because only a written tally drops one. Each such
    // survey costs one row read per run and no upstream request, and the attempt
    // stamp this run wrote sends it to the back of the order, so it can neither
    // spend the budget nor hold up work that has something to compute.
    expect((await takeSurveyTallyWork(env.DB, 10)).sort()).toEqual(
      [KEY_LINKED, KEY_SECOND, KEY_UNLINKED].sort(),
    );
  });

  it('writes no tally when the power history is empty', async () => {
    await importLinkingAction();
    expect(await syncSurveys(deps(fakeTessera(), NOW))).toMatchObject({
      written: 1,
      tallies: 0,
      failed: 0,
    });
    expect(await getSurveyTally(env.DB, KEY_LINKED)).toBeNull();
    // Queued all the same, so the first run after the history fills in has its
    // work order waiting.
    expect(await takeSurveyTallyWork(env.DB, 10)).toEqual([KEY_LINKED]);
  });
});
