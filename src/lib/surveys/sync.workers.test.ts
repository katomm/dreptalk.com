import { env } from 'cloudflare:test';
import {
  MAX_PAGE_LIMIT,
  type SurveyChangesPayload,
  type SurveyListPayload,
  TesseraHttpError,
} from 'cardano-tessera-client';
import { Role, type SurveyDefinition } from 'cip-179';
import { type ChainTip, hexToBytes, type SurveyRecord } from 'cip-179/domain';
import type { TallyArtifact } from 'cip-179/tally';
import { describe, expect, it } from 'vitest';
import { buildInsertGovernanceAction } from '../db/governance.js';
import {
  getHeldSurveys,
  getLinkedSurveyForAction,
  getSettleableSurveyResponses,
  getSurveyByTopicId,
  getSurveyGovLinks,
  getSurveySyncState,
  getTopicSlugBySurveyRef,
  getViewerSurveyResponse,
  listSurveysWithTopics,
  recordLocalSurveyResponse,
} from '../db/surveys.js';
import { PENDING_VOTE_TTL_SEC } from '../governance/tallySync.js';
import {
  MAX_LIST_PAGES,
  reconcileSurveyResponses,
  type SurveysSyncDeps,
  type SurveysTessera,
  syncSurveys,
} from './sync.js';

const TX_LINKED = 'a'.repeat(64);
const TX_SECOND = 'b'.repeat(64);
const TX_NON_DREP = 'c'.repeat(64);
const KEY_LINKED = `${TX_LINKED}:0`;
const KEY_SECOND = `${TX_SECOND}:0`;
const KEY_NON_DREP = `${TX_NON_DREP}:0`;
const ACTION_ID = 'gov_action1linkedaction';
const ACTION_SECOND = 'gov_action1secondaction';
const ARTIFACT_HASH = 'ab'.repeat(32);
/** The cursor a completed walk hands out, and the one a delta answers with. */
const WALK_CURSOR = 'walk-cursor';
const DELTA_CURSOR = 'delta-cursor';

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
/** Mirrors the sync's FAILED_POLL_WINDOW_MS. */
const FAILED_POLL_WINDOW_MS = 7 * DAY_MS;

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

/** One page of the paged list, the last one: the walk's cursor rides on it. */
function pageOf(set: SurveyListPayload, linked: number): SurveyListPayload {
  return {
    ...set,
    counts: { all: linked, linked, active: linked, sealed: 0, public: linked, mine: 0 },
    nextCursor: null,
    changesCursor: WALK_CURSOR,
  };
}

/** One complete delta: what moved, what was removed, and where to ask from next. */
function deltaOf(set: SurveyListPayload, removed: string[] = []): SurveyChangesPayload {
  return { ...set, removed, nextCursor: DELTA_CURSOR };
}

/** The backend's answer to a cursor past its retention window. */
const RESYNC: SurveyChangesPayload = {
  ...setOf([], [], {}),
  removed: [],
  resync: true,
  nextCursor: null,
};

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

function fakeTessera(overrides: Partial<SurveysTessera> = {}): SurveysTessera {
  const linked = surveyRecord(TX_LINKED, definition());
  const page = pageOf(
    setOf(
      // A linked non-DRep survey rides on the same page; the standalone
      // DRep-eligible survey is NOT here because ?filter=linked excludes it.
      [
        linked,
        surveyRecord(TX_NON_DREP, definition({ eligibleRoles: [Role.SPO], title: 'SPO poll' })),
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
      { [KEY_LINKED]: 3, [KEY_NON_DREP]: 1 },
    ),
    2,
  );
  return {
    surveys: overrides.surveys ?? (async () => ({ ready: true, body: page })),
    surveysByRefs:
      overrides.surveysByRefs ??
      (async () => ({
        ready: true,
        body: setOf([linked], page.govLinks.slice(0, 1), { [KEY_LINKED]: 3 }),
      })),
    // Nothing moved since the cursor: the steady state of every tick.
    changes: overrides.changes ?? (async () => ({ ready: true, body: deltaOf(setOf([], [], {})) })),
    artifactByHash: overrides.artifactByHash ?? (async () => artifactOf(2)),
    // "Submitted, not indexed yet" — the backend's answer for any tx the
    // fake was not told about.
    responsesByTx:
      overrides.responsesByTx ??
      (async () => ({ ready: true, body: { responses: [], fetchedAt: tip.time } })),
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
  topic_id: string;
  counted_dreps: number | null;
  final_counted_dreps: number | null;
  final_state: string | null;
  artifact_hash: string | null;
  unavailable: number;
  unavailable_since: number | null;
  cancelled: number;
  synced_at: number;
}

async function surveyRows(): Promise<StoredSurvey[]> {
  const { results } = await env.DB.prepare(
    `SELECT ref, topic_id, counted_dreps, final_counted_dreps, final_state, artifact_hash,
            unavailable, unavailable_since, cancelled, synced_at
     FROM survey ORDER BY ref`,
  ).all<StoredSurvey>();
  return results;
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
  it('admits only the DRep-eligible linked survey, opens its thread, stores the audited DRep count', async () => {
    await importLinkingAction();

    const r = await syncSurveys(deps(fakeTessera()));
    expect(r).toMatchObject({ notReady: false, admitted: 1, failed: 0 });

    // Exactly one row: the linked non-DRep survey is not admitted, and the
    // standalone survey never appears in the linked list at all.
    const rows = await surveyRows();
    expect(rows.map(s => s.ref)).toEqual([KEY_LINKED]);
    // The card number is the backend's audited DRep count, not the list's
    // raw responseCount of 3 — and no artifact figure yet on a held survey.
    expect(rows[0]).toMatchObject({
      counted_dreps: 2,
      final_counted_dreps: null,
      final_state: null,
      artifact_hash: null,
    });

    const topic = await env.DB.prepare(
      'SELECT id, category_slug, source, title FROM topics WHERE id = ?',
    )
      .bind(rows[0].topic_id)
      .first<{ id: string; category_slug: string; source: string; title: string }>();
    expect(topic).toMatchObject({
      category_slug: 'surveys',
      source: 'survey',
      title: 'Treasury priorities',
    });
    expect((await linksOf(KEY_LINKED)).map(l => l.action_id)).toEqual([ACTION_ID]);

    // Second run: nothing new, nothing duplicated.
    const r2 = await syncSurveys(deps(fakeTessera()));
    expect(r2).toMatchObject({ admitted: 0, failed: 0 });
    expect((await surveyRows()).length).toBe(1);
    const topics = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM topics WHERE source = 'survey'",
    ).first<{ n: number }>();
    expect(topics?.n).toBe(1);
  });

  it("stores the title and opening post sanitized and capped, the definition in cip-179's wire form", async () => {
    await importLinkingAction();
    const rawTitle = ` Bud\u0000get ${'t'.repeat(400)}`;
    const record = surveyRecord(
      TX_LINKED,
      definition({ title: rawTitle, description: `Why\u0007 this\n\n\n\n${'d'.repeat(5000)}` }),
    );
    const page = pageOf(setOf([record], LINKED_LINKS, { [KEY_LINKED]: 0 }), 1);
    await syncSurveys(deps(fakeTessera({ surveys: async () => ({ ready: true, body: page }) })));

    const [row] = await surveyRows();
    const expectedTitle = `Budget ${'t'.repeat(293)}`;
    const topic = await env.DB.prepare('SELECT title FROM topics WHERE id = ?')
      .bind(row.topic_id)
      .first<{ title: string }>();
    expect(topic?.title).toBe(expectedTitle);
    const survey = await getSurveyByTopicId(env.DB, row.topic_id);
    expect(survey?.title).toBe(expectedTitle);
    const post = await env.DB.prepare('SELECT body_md FROM posts WHERE topic_id = ?')
      .bind(row.topic_id)
      .first<{ body_md: string }>();
    expect(post?.body_md).toContain(`Why this\n\n${'d'.repeat(3990)}\n`);
    expect(post?.body_md).not.toContain('\u0007');
    // The stored record is what the widget re-decodes: untouched.
    expect(survey?.definitionJson).toContain(JSON.stringify(rawTitle).slice(1, -1));
  });

  it('defers a linked DRep survey whose action is not imported, and admits it once it is', async () => {
    // Nothing imported: the survey is eligible and linked, so it is remembered
    // rather than dropped — a change is delivered once, and nothing upstream
    // will move when the action lands here.
    const r = await syncSurveys(deps(fakeTessera()));
    expect(r.admitted).toBe(0);
    expect((await surveyRows()).length).toBe(0);
    expect((await getSurveySyncState(env.DB)).deferredRefs).toEqual([KEY_LINKED]);

    // Still deferred on a quiet tick, asked by reference each time.
    const asked: string[][] = [];
    const quiet = fakeTessera({
      surveysByRefs: async refs => {
        asked.push([...refs]);
        return fakeTessera().surveysByRefs(refs);
      },
    });
    await syncSurveys(deps(quiet));
    expect(asked).toEqual([[KEY_LINKED]]);
    expect((await getSurveySyncState(env.DB)).deferredRefs).toEqual([KEY_LINKED]);

    // The action is imported: the next reference answer admits it.
    await importLinkingAction();
    expect(await syncSurveys(deps(fakeTessera()))).toMatchObject({ admitted: 1, failed: 0 });
    expect((await surveyRows()).map(s => s.ref)).toEqual([KEY_LINKED]);
    expect((await getSurveySyncState(env.DB)).deferredRefs).toEqual([]);
  });

  it('stores no in-window count while the backend serves none, and picks it up once it does', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    const linked = surveyRecord(TX_LINKED, definition());
    const blind = fakeTessera({
      surveys: async () => ({
        ready: true,
        body: pageOf(setOf([linked], LINKED_LINKS, { [KEY_LINKED]: 3 }, null), 1),
      }),
      surveysByRefs: async () => ({
        ready: true,
        body: setOf([linked], LINKED_LINKS, { [KEY_LINKED]: 3 }, null),
      }),
    });
    // The raw count of 3 is never a fallback: the row says "unknown".
    await syncSurveys(deps(blind, now));
    expect((await surveyRows())[0].counted_dreps).toBeNull();
    expect((await syncSurveys(deps(blind, now + HOUR_MS))).refreshed).toBe(0);
    expect((await surveyRows())[0].counted_dreps).toBeNull();

    // The field appears on the wire: one refresh, the audited figure lands.
    const counted = fakeTessera({
      changes: async () => ({
        ready: true,
        body: deltaOf(setOf([linked], LINKED_LINKS, { [KEY_LINKED]: 3 })),
      }),
    });
    expect((await syncSurveys(deps(counted, now + 2 * HOUR_MS))).refreshed).toBe(1);
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

  it('writes a held row only when the answer moved a value it stores', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    await syncSurveys(deps(fakeTessera(), now));
    expect((await surveyRows())[0].synced_at).toBe(now);

    // A quiet tick: nothing written, so synced_at keeps dating the last
    // change rather than the last look.
    expect((await syncSurveys(deps(fakeTessera(), now + HOUR_MS))).refreshed).toBe(0);
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
    expect((await syncSurveys(deps(answer({ [KEY_LINKED]: { 0: 3 } }), moved))).refreshed).toBe(1);
    expect((await surveyRows())[0]).toMatchObject({ counted_dreps: 3, synced_at: moved });

    // Only a link moved — the action's title, then a second linking action.
    const retitled = now + 3 * HOUR_MS;
    const links: SurveyListPayload['govLinks'] = [{ ...LINKED_LINKS[0], title: 'Renamed action' }];
    expect(
      (await syncSurveys(deps(answer({ [KEY_LINKED]: { 0: 3 } }, links), retitled))).refreshed,
    ).toBe(1);
    expect(await linksOf(KEY_LINKED)).toEqual([{ action_id: ACTION_ID, title: 'Renamed action' }]);
    expect((await surveyRows())[0].synced_at).toBe(retitled);
    const second: SurveyListPayload['govLinks'] = [
      ...links,
      { surveyKey: KEY_LINKED, actionId: ACTION_SECOND, endEpoch: 300, title: 'Another' },
    ];
    const relinked = now + 4 * HOUR_MS;
    expect(
      (await syncSurveys(deps(answer({ [KEY_LINKED]: { 0: 3 } }, second), relinked))).refreshed,
    ).toBe(1);
    expect((await linksOf(KEY_LINKED)).map(l => l.action_id)).toEqual([ACTION_ID, ACTION_SECOND]);
    // The same row delivered again, unchanged: quiet.
    expect(
      (await syncSurveys(deps(answer({ [KEY_LINKED]: { 0: 3 } }, second), relinked + HOUR_MS)))
        .refreshed,
    ).toBe(0);
    expect((await surveyRows())[0].synced_at).toBe(relinked);
  });

  it('walks the linked list once, then asks only for what changed from its cursor', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    const first = surveyRecord(TX_LINKED, definition());
    let listCalls = 0;
    let deltaCalls = 0;
    const cursorsAsked: string[] = [];
    // Two hundred surveys nobody can answer here: a full delta page.
    const bulk = Array.from({ length: MAX_PAGE_LIMIT }, (_, i) =>
      surveyRecord(i.toString(16).padStart(64, '0'), definition({ eligibleRoles: [Role.SPO] })),
    );
    let backlog = false;
    let stale = false;
    const mirror = fakeTessera({
      surveys: async params => {
        listCalls++;
        if (params?.cursor) return { ready: true, body: pageOf(setOf([], [], {}), 2) };
        return {
          ready: true,
          body: {
            ...pageOf(setOf([first], LINKED_LINKS, { [KEY_LINKED]: 3 }), 2),
            nextCursor: 'page-2',
          },
        };
      },
      changes: async cursor => {
        deltaCalls++;
        cursorsAsked.push(cursor);
        if (stale) return { ready: true, body: RESYNC };
        const full = backlog && deltaCalls === 1;
        return {
          ready: true,
          body: {
            ...deltaOf(setOf(full ? bulk : [], [], {})),
            nextCursor: `${DELTA_CURSOR}-${deltaCalls}`,
          },
        };
      },
    });
    // No cursor yet: the walk, both pages, and the last page's cursor kept.
    await syncSurveys(deps(mirror, now));
    expect([listCalls, deltaCalls]).toEqual([2, 0]);
    expect(await getSurveySyncState(env.DB)).toMatchObject({ changesCursor: WALK_CURSOR });

    // The steady state of every five-minute tick: one delta from the stored
    // cursor, its answer's cursor stored for the next.
    listCalls = 0;
    await syncSurveys(deps(mirror, now + HOUR_MS));
    expect([listCalls, deltaCalls]).toEqual([0, 1]);
    expect(cursorsAsked).toEqual([WALK_CURSOR]);
    expect((await getSurveySyncState(env.DB)).changesCursor).toBe(`${DELTA_CURSOR}-1`);

    // A backlog: a full page is followed up in the same run until a short one.
    deltaCalls = 0;
    backlog = true;
    await syncSurveys(deps(mirror, now + 2 * HOUR_MS));
    expect([listCalls, deltaCalls]).toEqual([0, 2]);
    expect(cursorsAsked.slice(1)).toEqual([`${DELTA_CURSOR}-1`, `${DELTA_CURSOR}-1`]);
    expect((await getSurveySyncState(env.DB)).changesCursor).toBe(`${DELTA_CURSOR}-2`);

    // The cursor outlived the backend's retention: walk again, same run.
    deltaCalls = 0;
    stale = true;
    await syncSurveys(deps(mirror, now + 3 * HOUR_MS));
    expect([listCalls, deltaCalls]).toEqual([2, 1]);
    expect((await getSurveySyncState(env.DB)).changesCursor).toBe(WALK_CURSOR);
  });

  it('stops a walk at the page cap instead of restarting it', async () => {
    let calls = 0;
    const endless = fakeTessera({
      surveys: async () => {
        calls++;
        return {
          ready: true,
          body: { ...pageOf(setOf([], [], {}), 10_000), nextCursor: `cursor-${calls}` },
        };
      },
    });
    expect((await syncSurveys(deps(endless))).failed).toBe(0);
    // The cap is the whole request budget — no restart re-walks it — and a
    // walk that never reached the end hands out no cursor.
    expect(calls).toBe(MAX_LIST_PAGES);
    expect(await getSurveySyncState(env.DB)).toMatchObject({
      changesCursor: null,
      tesseraFetchedAt: null,
    });
  });

  it('settles even when the mirror pass fails, and keeps the cursor it could not advance', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    await syncSurveys(deps(fakeTessera(), now));
    const cred = `key:${'aa'.repeat(28)}`;
    const tx = '11'.repeat(32);
    await recordLocalSurveyResponse(env.DB, {
      surveyRef: KEY_LINKED,
      userId: 'u-settle',
      txHash: tx,
      credential: cred,
      now: now - 1_000,
    });

    // The delta the backend cannot serve: the mirror fails, the pending
    // answer is still polled and settled.
    const broken = fakeTessera({
      changes: async () => {
        throw new TesseraHttpError('/api/surveys', 502, '');
      },
      responsesByTx: async () => ({
        ready: true,
        body: {
          responses: [
            { surveyKey: KEY_LINKED, responseIndex: 0, role: 0, credential: cred, slot: 1 },
          ],
          fetchedAt: tip.time,
        },
      }),
    });
    expect(await syncSurveys(deps(broken, now + HOUR_MS))).toMatchObject({
      failed: 1,
      settled: 1,
    });
    expect(await getViewerSurveyResponse(env.DB, KEY_LINKED, 'u-settle')).toBeNull();
    // Nothing was applied, so the next run asks from the same position.
    expect(await getSurveySyncState(env.DB)).toMatchObject({
      changesCursor: WALK_CURSOR,
      tesseraFetchedAt: tip.time,
    });
  });

  it('restarts the walk when a list page answers from an older snapshot', async () => {
    await importLinkingAction();
    await importLinkingAction(ACTION_SECOND);
    const first = surveyRecord(TX_LINKED, definition());
    const second = surveyRecord(TX_SECOND, definition({ title: 'Second survey' }));
    const links: SurveyListPayload['govLinks'] = [
      { surveyKey: KEY_LINKED, actionId: ACTION_ID, endEpoch: 300, title: 'The linking action' },
      { surveyKey: KEY_SECOND, actionId: ACTION_SECOND, endEpoch: 300, title: 'The other action' },
    ];
    const pageOne = (linked: number): SurveyListPayload => ({
      ...pageOf(setOf([first], links.slice(0, 1), { [KEY_LINKED]: 3 }), linked),
      nextCursor: 'cursor-1',
    });
    const pageTwo = pageOf(setOf([second], links.slice(1), { [KEY_SECOND]: 1 }), 3);
    // The best-effort answer to a cursor minted against an older snapshot:
    // rows gone AND the cursor terminal — the pair that reads like a finished
    // walk if `resync` is not checked first.
    const stale: SurveyListPayload = { ...pageOf(setOf([], [], {}), 2), resync: true };
    const bothRefs = async () => ({
      ready: true as const,
      body: setOf([first, second], links, { [KEY_LINKED]: 3, [KEY_SECOND]: 1 }),
    });

    // Generation two counts one more linked survey than the one abandoned.
    let calls = 0;
    const moved = fakeTessera({
      surveys: async params => {
        calls++;
        if (!params?.cursor) return { ready: true, body: pageOne(calls === 1 ? 2 : 3) };
        return { ready: true, body: calls === 2 ? stale : pageTwo };
      },
      surveysByRefs: bothRefs,
    });
    const now = 1_780_000_500_000;
    expect(await syncSurveys(deps(moved, now))).toMatchObject({ admitted: 2, failed: 0 });
    // Page two of the restarted walk is where the second survey lives: taking
    // the stale terminal page would have admitted only the first.
    expect((await surveyRows()).map(r => r.ref)).toEqual([KEY_LINKED, KEY_SECOND]);
    expect(await getSurveySyncState(env.DB)).toEqual({
      changesCursor: WALK_CURSOR,
      deferredRefs: [],
      tesseraFetchedAt: tip.time,
    });

    // A walk that never converges hands out no cursor and dates nothing, so
    // the next run walks again instead of believing a complete walk happened.
    const churning = fakeTessera({
      changes: async () => ({ ready: true, body: RESYNC }),
      surveys: async params =>
        params?.cursor ? { ready: true, body: stale } : { ready: true, body: pageOne(4) },
      surveysByRefs: bothRefs,
    });
    expect(await syncSurveys(deps(churning, now + HOUR_MS))).toMatchObject({ admitted: 0 });
    expect(await getSurveySyncState(env.DB)).toEqual({
      changesCursor: null,
      deferredRefs: [],
      tesseraFetchedAt: tip.time,
    });
  });

  it('withdraws a held survey the delta removes, and clears it when it reappears', async () => {
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
    expect(row).toMatchObject({ unavailable: 1, unavailable_since: now + HOUR_MS });
    expect(await linksOf(KEY_LINKED)).toEqual([]);
    expect(await getLinkedSurveyForAction(env.DB, ACTION_ID)).toBeNull();

    // Removed again: withdrawn once — no write, so the stamp keeps its first
    // value — and the row still lists for the pages.
    expect((await syncSurveys(deps(gone, now + 2 * HOUR_MS))).rolledBack).toBe(0);
    expect((await surveyRows())[0].unavailable_since).toBe(now + HOUR_MS);
    expect(await listSurveysWithTopics(env.DB, { limit: 10, offset: 0 })).toHaveLength(1);

    // The record re-lands, long after: cleared, clock and all — a write, even
    // though nothing else on the row moved — and relinked.
    const linked = surveyRecord(TX_LINKED, definition());
    const back = fakeTessera({
      changes: async () => ({
        ready: true,
        body: deltaOf(setOf([linked], LINKED_LINKS, { [KEY_LINKED]: 3 })),
      }),
    });
    expect((await syncSurveys(deps(back, now + 10 * DAY_MS))).refreshed).toBe(1);
    [row] = await surveyRows();
    expect(row).toMatchObject({ unavailable: 0, unavailable_since: null });
    expect((await linksOf(KEY_LINKED)).map(l => l.action_id)).toEqual([ACTION_ID]);
    expect((await getLinkedSurveyForAction(env.DB, ACTION_ID))?.survey.ref).toBe(KEY_LINKED);
  });

  it('re-asks every held row by reference on a walk, and withdraws what a complete answer omits', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    await syncSurveys(deps(fakeTessera(), now));

    // The cursor is stale, and the survey has left the linked list while the
    // mirror was not watching: the walk cannot say whether it is gone, the
    // reference answer can — but an incomplete one proves nothing.
    const asked: string[][] = [];
    const fresh = (refs: SurveyListPayload) =>
      fakeTessera({
        changes: async () => ({ ready: true, body: RESYNC }),
        surveys: async () => ({ ready: true, body: pageOf(setOf([], [], {}), 0) }),
        surveysByRefs: async keys => {
          asked.push([...keys]);
          return { ready: true, body: refs };
        },
      });
    const r = await syncSurveys(
      deps(fresh({ ...setOf([], [], {}), incomplete: true }), now + HOUR_MS),
    );
    expect(r).toMatchObject({ rolledBack: 0, failed: 0 });
    expect((await surveyRows())[0].unavailable).toBe(0);

    expect((await syncSurveys(deps(fresh(setOf([], [], {})), now + 2 * HOUR_MS))).rolledBack).toBe(
      1,
    );
    expect(asked).toEqual([[KEY_LINKED], [KEY_LINKED]]);
    expect((await surveyRows())[0]).toMatchObject({
      unavailable: 1,
      unavailable_since: now + 2 * HOUR_MS,
    });
    expect(await linksOf(KEY_LINKED)).toEqual([]);
  });

  it('withdraws a held survey whose imported link is gone, and re-admits it when it returns', async () => {
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
    // The record is still indexed, but its only link now names an action
    // DRepTalk never imported: admission no longer holds. Same treatment as a
    // rolled-back record — the flag, the clock, the links — since in practice
    // it is the linking action's transaction that rolled back.
    const elsewhere: SurveyListPayload['govLinks'] = [
      { surveyKey: KEY_LINKED, actionId: 'gov_action1notimported', endEpoch: 300, title: null },
    ];
    expect(await syncSurveys(deps(answer(elsewhere), now + HOUR_MS))).toMatchObject({
      refreshed: 0,
      rolledBack: 1,
    });
    let [row] = await surveyRows();
    expect(row).toMatchObject({ unavailable: 1, unavailable_since: now + HOUR_MS });
    expect(await linksOf(KEY_LINKED)).toEqual([]);
    expect(await getLinkedSurveyForAction(env.DB, ACTION_ID)).toBeNull();

    // Withdrawn once: a run that still finds it inadmissible writes nothing.
    expect(await syncSurveys(deps(answer(elsewhere), now + 2 * HOUR_MS))).toMatchObject({
      refreshed: 0,
      rolledBack: 0,
    });
    expect((await surveyRows())[0].unavailable_since).toBe(now + HOUR_MS);

    // The imported link is back: cleared and relinked in one write.
    expect(await syncSurveys(deps(answer(LINKED_LINKS), now + 3 * HOUR_MS))).toMatchObject({
      refreshed: 1,
      rolledBack: 0,
    });
    [row] = await surveyRows();
    expect(row).toMatchObject({ unavailable: 0, unavailable_since: null });
    expect((await linksOf(KEY_LINKED)).map(l => l.action_id)).toEqual([ACTION_ID]);
    expect((await getLinkedSurveyForAction(env.DB, ACTION_ID))?.survey.ref).toBe(KEY_LINKED);
  });

  it('admits neither an untalliable survey nor a sealed one on an unsupported drand chain', async () => {
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
    const page = pageOf(setOf([valid, invalid, foreignChain], links, {}), 3);
    const r = await syncSurveys(
      deps(fakeTessera({ surveys: async () => ({ ready: true, body: page }) })),
    );
    // All three are linked to the imported action; only the valid public
    // survey gets a thread. The other two would be decided untalliable at
    // close, and a thread inviting answers to them wastes every fee spent.
    // Neither is deferred either: it is not the link that is missing.
    expect(r).toMatchObject({ admitted: 1, failed: 0 });
    expect((await surveyRows()).map(s => s.ref)).toEqual([KEY_LINKED]);
    expect((await getSurveySyncState(env.DB)).deferredRefs).toEqual([]);
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
          surveys: async () => ({ ready: true, body: pageOf(open, 2) }),
          surveysByRefs: async () => ({ ready: true, body: open }),
        }),
      ),
    );
    expect((await getHeldSurveys(env.DB)).map(h => h.ref).sort()).toEqual([KEY_LINKED, KEY_SECOND]);

    // The delta declares both decided for good — one cancelled, one
    // finalized, each with an artifact. Only the cancelled one may surface as
    // a cancellation; both must freeze; only the finalized one's artifact is
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
    expect(r).toMatchObject({ refreshed: 2, finalCounts: 1, failed: 0 });
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
    expect(await getHeldSurveys(env.DB)).toEqual([]);

    // Both frozen: the same rows delivered again touch nothing, and no
    // artifact is asked for again — the bounded working set the finalState
    // wire buys.
    const quiet = await syncSurveys(
      deps(
        fakeTessera({
          changes: async () => ({ ready: true, body: deltaOf(decided) }),
          artifactByHash: async () => {
            throw new Error('a counted artifact must not be read again');
          },
        }),
      ),
    );
    expect(quiet).toMatchObject({ refreshed: 0, finalCounts: 0, failed: 0 });
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

    // The decision lands while the artifact route is down: the decision and
    // its hash are kept, the in-window figure stands, the failure is charged.
    const down = finalized(async () => {
      throw new TesseraHttpError('/api/artifacts', 500, '');
    });
    expect(await syncSurveys(deps(down, now + HOUR_MS))).toMatchObject({
      refreshed: 1,
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
    ).toMatchObject({ refreshed: 0, finalCounts: 0, failed: 1 });

    // Next run: the row is no longer refreshed, but its artifact is asked for
    // again — and a finalized tally can count fewer DReps than the in-window
    // figure did (end-epoch role membership), which is the number to show.
    const asked: string[] = [];
    const up = finalized(async hash => {
      asked.push(hash);
      return artifactOf(1);
    });
    expect(await syncSurveys(deps(up, now + 3 * HOUR_MS))).toMatchObject({
      refreshed: 0,
      finalCounts: 1,
      failed: 0,
    });
    expect(asked).toEqual([ARTIFACT_HASH]);
    [row] = await surveyRows();
    expect(row).toMatchObject({ counted_dreps: 2, final_counted_dreps: 1 });
  });

  it('reads the artifact of a survey admitted already finalized in the same run', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    const linked = surveyRecord(TX_LINKED, definition());
    const finalPage: SurveyListPayload = {
      ...pageOf(setOf([linked], LINKED_LINKS, { [KEY_LINKED]: 3 }), 1),
      finalState: FINALIZED,
    };
    const fake = fakeTessera({
      surveys: async () => ({ ready: true, body: finalPage }),
      surveysByRefs: async () => {
        throw new Error('a decided survey must not be refreshed');
      },
      // No DRep entry at all: nobody was counted at close.
      artifactByHash: async () => artifactOf(0),
    });
    expect(await syncSurveys(deps(fake, now))).toMatchObject({
      admitted: 1,
      refreshed: 0,
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
    const byTopic = await getSurveyByTopicId(env.DB, row.topic_id);
    expect(byTopic).toMatchObject({
      ref: KEY_LINKED,
      title: 'Treasury priorities',
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
    expect(await getLinkedSurveyForAction(env.DB, 'gov_action1unknown')).toBeNull();
  });

  it('skips the run without recording an error while the backend has no snapshot', async () => {
    const empty = {
      notReady: true,
      admitted: 0,
      refreshed: 0,
      rolledBack: 0,
      finalCounts: 0,
      settled: 0,
      failed: 0,
    };
    // Before the first walk, and once a cursor is held.
    expect(
      await syncSurveys(deps(fakeTessera({ surveys: async () => ({ ready: false }) }))),
    ).toEqual(empty);
    expect(await getSurveySyncState(env.DB)).toEqual({
      changesCursor: null,
      deferredRefs: [],
      tesseraFetchedAt: null,
    });
    await importLinkingAction();
    await syncSurveys(deps(fakeTessera()));
    expect(
      await syncSurveys(deps(fakeTessera({ changes: async () => ({ ready: false }) }))),
    ).toEqual(empty);
    expect(await getSurveySyncState(env.DB)).toEqual({
      changesCursor: WALK_CURSOR,
      deferredRefs: [],
      tesseraFetchedAt: tip.time,
    });
  });

  it('dates the mirror by the oldest answer used, and not at all when a pass broke off', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    const linked = surveyRecord(TX_LINKED, definition());
    const refsAt = (fetchedAt: number) => async () => ({
      ready: true as const,
      body: { ...setOf([linked], LINKED_LINKS, { [KEY_LINKED]: 3 }), fetchedAt },
    });
    // The walk answers from tip.time, the refs from an older generation: the
    // held row now reflects the older one, so that is the "as of".
    await syncSurveys(deps(fakeTessera({ surveysByRefs: refsAt(tip.time - 100) }), now));
    expect((await getSurveySyncState(env.DB)).tesseraFetchedAt).toBe(tip.time - 100);

    // The delta fails: the held row was not brought up to anything, so the
    // stamp must not move.
    const broken = fakeTessera({
      changes: async () => {
        throw new TesseraHttpError('/api/surveys', 500, '');
      },
    });
    expect((await syncSurveys(deps(broken, now + HOUR_MS))).failed).toBe(1);
    expect((await getSurveySyncState(env.DB)).tesseraFetchedAt).toBe(tip.time - 100);

    // A quiet delta from a newer generation: every held row reflects it.
    const quiet = fakeTessera({
      changes: async () => ({
        ready: true,
        body: { ...deltaOf(setOf([], [], {})), fetchedAt: tip.time + 180 },
      }),
    });
    await syncSurveys(deps(quiet, now + 2 * HOUR_MS));
    expect((await getSurveySyncState(env.DB)).tesseraFetchedAt).toBe(tip.time + 180);
  });

  it('settles a local answer by its exact tx, keeps a fresh one pending, ages a stale one', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    const txIndexed = '11'.repeat(32);
    const txWaiting = '22'.repeat(32);
    const txDropped = '33'.repeat(32);
    const cred = `key:${'aa'.repeat(28)}`;
    const tessera = fakeTessera({
      responsesByTx: async txHash => ({
        ready: true,
        body: {
          responses:
            txHash === txIndexed
              ? [{ surveyKey: KEY_LINKED, responseIndex: 0, role: 0, credential: cred, slot: 1 }]
              : [],
          fetchedAt: tip.time,
        },
      }),
    });
    await syncSurveys(deps(tessera, now));

    // Three viewers mid-flight: one whose tx Tessera has indexed, one whose
    // fresh tx it has not yet, one whose stale tx never landed.
    await recordLocalSurveyResponse(env.DB, {
      surveyRef: KEY_LINKED,
      userId: 'u-settle',
      txHash: txIndexed,
      credential: cred,
      now: now - 1_000,
    });
    await recordLocalSurveyResponse(env.DB, {
      surveyRef: KEY_LINKED,
      userId: 'u-wait',
      txHash: txWaiting,
      credential: cred,
      now: now - 1_000,
    });
    await recordLocalSurveyResponse(env.DB, {
      surveyRef: KEY_LINKED,
      userId: 'u-old',
      txHash: txDropped,
      credential: cred,
      now: now - (PENDING_VOTE_TTL_SEC + 60) * 1000,
    });

    const r = await syncSurveys(deps(tessera, now));
    expect(r.settled).toBe(1);
    // Ageing belongs to the reconcile step, not to the sync: it reads the
    // clock and nothing else, so it runs whether or not Tessera answered.
    expect(await reconcileSurveyResponses(env.DB, now)).toBe(1);
    // The indexed answer's row is gone (the on-chain record supersedes it);
    // the fresh one still reads "confirming"; the stale one invites a retry.
    expect(await getViewerSurveyResponse(env.DB, KEY_LINKED, 'u-settle')).toBeNull();
    expect((await getViewerSurveyResponse(env.DB, KEY_LINKED, 'u-wait'))?.status).toBe('pending');
    expect((await getViewerSurveyResponse(env.DB, KEY_LINKED, 'u-old'))?.status).toBe('failed');

    // Re-answering overwrites the failed row back to pending under a new tx.
    await recordLocalSurveyResponse(env.DB, {
      surveyRef: KEY_LINKED,
      userId: 'u-old',
      txHash: txWaiting,
      credential: cred,
      now,
    });
    expect((await getViewerSurveyResponse(env.DB, KEY_LINKED, 'u-old'))?.status).toBe('pending');
  });

  it('settles the answers queued behind a transaction whose lookup failed', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    const txBroken = '55'.repeat(32);
    const txGood = '66'.repeat(32);
    const cred = `key:${'aa'.repeat(28)}`;
    const tessera = fakeTessera({
      responsesByTx: async txHash => {
        if (txHash === txBroken) throw new TesseraHttpError('/api/responses', 500, '');
        return {
          ready: true,
          body: {
            responses: [
              { surveyKey: KEY_LINKED, responseIndex: 0, role: 0, credential: cred, slot: 1 },
            ],
            fetchedAt: tip.time,
          },
        };
      },
    });
    await syncSurveys(deps(tessera, now));

    // The failing lookup belongs to the older row, so the oldest-first poll
    // reaches it before the one that can settle.
    await recordLocalSurveyResponse(env.DB, {
      surveyRef: KEY_LINKED,
      userId: 'u-broken',
      txHash: txBroken,
      credential: cred,
      now: now - 2_000,
    });
    await recordLocalSurveyResponse(env.DB, {
      surveyRef: KEY_LINKED,
      userId: 'u-good',
      txHash: txGood,
      credential: cred,
      now: now - 1_000,
    });

    expect(await syncSurveys(deps(tessera, now))).toMatchObject({ settled: 1, failed: 1 });
    expect((await getViewerSurveyResponse(env.DB, KEY_LINKED, 'u-broken'))?.status).toBe('pending');
    expect(await getViewerSurveyResponse(env.DB, KEY_LINKED, 'u-good')).toBeNull();
  });

  it('settles a failed row whose transaction lands late, inside the poll window', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    const txFresh = '77'.repeat(32);
    const txLate = '88'.repeat(32);
    const txAncient = '99'.repeat(32);
    const cred = `key:${'aa'.repeat(28)}`;
    const asked: string[] = [];
    const tessera = fakeTessera({
      responsesByTx: async txHash => {
        asked.push(txHash);
        return {
          ready: true,
          body: {
            responses: [
              { surveyKey: KEY_LINKED, responseIndex: 0, role: 0, credential: cred, slot: 1 },
            ],
            fetchedAt: tip.time,
          },
        };
      },
    });
    await syncSurveys(deps(tessera, now));

    // Two answers the clock failed: one from two days ago, one from a month
    // ago. Then a fresh one, still pending.
    const record = (userId: string, txHash: string, at: number) =>
      recordLocalSurveyResponse(env.DB, {
        surveyRef: KEY_LINKED,
        userId,
        txHash,
        credential: cred,
        now: at,
      });
    await record('u-late', txLate, now - 2 * DAY_MS);
    await record('u-ancient', txAncient, now - 30 * DAY_MS);
    expect(await reconcileSurveyResponses(env.DB, now)).toBe(2);
    await record('u-fresh', txFresh, now - 1_000);

    // The poll order: pending first, then failed by age — and the ancient
    // row is past the window, so it is not polled at all.
    const polled = await getSettleableSurveyResponses(env.DB, 10, now - FAILED_POLL_WINDOW_MS);
    expect(polled.map(r => r.userId)).toEqual(['u-fresh', 'u-late']);

    // Both transactions turn out indexed: the late one settles too, so the
    // card stops inviting an answer the chain already has.
    expect(await syncSurveys(deps(tessera, now))).toMatchObject({ settled: 2, failed: 0 });
    expect(asked).toEqual([txFresh, txLate]);
    expect(await getViewerSurveyResponse(env.DB, KEY_LINKED, 'u-fresh')).toBeNull();
    expect(await getViewerSurveyResponse(env.DB, KEY_LINKED, 'u-late')).toBeNull();
    expect((await getViewerSurveyResponse(env.DB, KEY_LINKED, 'u-ancient'))?.status).toBe('failed');
  });

  it('leaves a re-answered row alone when its old transaction settles', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    const txOld = 'aa'.repeat(32);
    const txNew = 'bb'.repeat(32);
    const cred = `key:${'aa'.repeat(28)}`;
    const tessera = fakeTessera({
      responsesByTx: async txHash => {
        // The viewer answers again while the pass holds the old row: the
        // record API replaces it under the same (survey, user) key.
        if (txHash === txOld) {
          await recordLocalSurveyResponse(env.DB, {
            surveyRef: KEY_LINKED,
            userId: 'u-again',
            txHash: txNew,
            credential: cred,
            now,
          });
        }
        return {
          ready: true,
          body: {
            responses:
              txHash === txOld
                ? [{ surveyKey: KEY_LINKED, responseIndex: 0, role: 0, credential: cred, slot: 1 }]
                : [],
            fetchedAt: tip.time,
          },
        };
      },
    });
    await syncSurveys(deps(tessera, now));
    await recordLocalSurveyResponse(env.DB, {
      surveyRef: KEY_LINKED,
      userId: 'u-again',
      txHash: txOld,
      credential: cred,
      now: now - 1_000,
    });

    // The old transaction is indexed, but the row now claims the new one:
    // nothing to settle, and the new claim keeps confirming.
    expect((await syncSurveys(deps(tessera, now))).settled).toBe(0);
    expect(await getViewerSurveyResponse(env.DB, KEY_LINKED, 'u-again')).toMatchObject({
      txHash: txNew,
      status: 'pending',
    });
  });

  it('keeps a row pending when the indexed response is another credential or role', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    const tx = '44'.repeat(32);
    const mine = `key:${'aa'.repeat(28)}`;
    const theirs = `key:${'bb'.repeat(28)}`;
    // The transaction is indexed, and carries responses to this very survey —
    // but one is another DRep's credential and the other is the same wallet
    // answering in a non-DRep role. Neither is the answer the row claims.
    const responses = [
      { surveyKey: KEY_LINKED, responseIndex: 0, role: Role.DRep, credential: theirs, slot: 1 },
      { surveyKey: KEY_LINKED, responseIndex: 1, role: Role.SPO, credential: mine, slot: 1 },
    ];
    const tessera = fakeTessera({
      responsesByTx: async () => ({ ready: true, body: { responses, fetchedAt: tip.time } }),
    });
    await syncSurveys(deps(tessera, now));
    await recordLocalSurveyResponse(env.DB, {
      surveyRef: KEY_LINKED,
      userId: 'u-cred',
      txHash: tx,
      credential: mine,
      now: now - 1_000,
    });

    expect((await syncSurveys(deps(tessera, now))).settled).toBe(0);
    expect((await getViewerSurveyResponse(env.DB, KEY_LINKED, 'u-cred'))?.status).toBe('pending');

    // The account's own DRep response lands: the row settles.
    responses.push({
      surveyKey: KEY_LINKED,
      responseIndex: 2,
      role: Role.DRep,
      credential: mine,
      slot: 2,
    });
    expect((await syncSurveys(deps(tessera, now))).settled).toBe(1);
    expect(await getViewerSurveyResponse(env.DB, KEY_LINKED, 'u-cred')).toBeNull();
  });
});
