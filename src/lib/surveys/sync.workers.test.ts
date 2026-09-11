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
  getLinkedSurveyForAction,
  getSurveyByTopicId,
  getSurveyGovLinks,
  getSurveySyncState,
  getTopicSlugBySurveyRef,
  listSurveysWithTopics,
} from '../db/surveys.js';
import { MAX_LIST_PAGES, type SurveysSyncDeps, type SurveysTessera, syncSurveys } from './sync.js';

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
    });
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
      failed: 0,
    };
    // Before the bootstrap, and once a cursor is held.
    expect(
      await syncSurveys(deps(fakeTessera({ changesSince: async () => ({ ready: false }) }))),
    ).toEqual(empty);
    expect(await getSurveySyncState(env.DB)).toEqual({
      changesCursor: null,
      tesseraFetchedAt: null,
    });
    await importLinkingAction();
    await syncSurveys(deps(fakeTessera()));
    expect(
      await syncSurveys(deps(fakeTessera({ changes: async () => ({ ready: false }) }))),
    ).toEqual(empty);
    expect(await getSurveySyncState(env.DB)).toEqual({
      changesCursor: BOOT_CURSOR,
      tesseraFetchedAt: tip.time,
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
