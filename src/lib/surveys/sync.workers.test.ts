import { env } from 'cloudflare:test';
import { Role, type SurveyDefinition, type SurveyResponse } from 'cip-179';
import { hexToBytes, type ResponseRecord, type SurveyRecord } from 'cip-179/domain';
import { toJsonSafe } from 'cip-179/tally';
import { describe, expect, it } from 'vitest';
import { resolveNetwork } from '../config/network.js';
import { buildInsertGovernanceAction } from '../db/governance.js';
import {
  getHeldSurveys,
  getSurveyByTopicId,
  getSurveySyncState,
  getTopicSlugBySurveyRef,
  listSurveysWithTopics,
} from '../db/surveys.js';
import type { SurveyBundlePage, SurveyPage, SurveySet, TesseraTip } from '../tessera/client.js';
import { type SurveysSyncDeps, type SurveysTessera, syncSurveys } from './sync.js';

const TX_LINKED = 'a'.repeat(64);
const TX_NON_DREP = 'c'.repeat(64);
const KEY_LINKED = `${TX_LINKED}:0`;
const ACTION_ID = 'gov_action1linkedaction';

const tip: TesseraTip = {
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

function response(credHex: string, role = 0, slot = tip.slot - 5_000): ResponseRecord {
  const resp: SurveyResponse = {
    specVersion: 5,
    surveyRef: { txId: hexToBytes(TX_LINKED), index: 0 },
    role: role as SurveyResponse['role'],
    credential: { type: 'key', keyHash: hexToBytes(credHex.repeat(28)) },
    answers: {
      type: 'public',
      answers: [{ type: 'singleChoice', questionIndex: 0, optionIndex: 0 }],
    },
  };
  return {
    txHash: 'd'.repeat(62) + credHex,
    slot,
    epochNo: tip.epoch - 1,
    responseIndex: 0,
    response: resp,
  };
}

function setOf(
  records: SurveyRecord[],
  govLinks: SurveySet['govLinks'],
  counts: Record<string, number>,
): SurveySet {
  return {
    surveys: records.map(r => toJsonSafe(r)),
    cancellations: [],
    govLinks,
    tip,
    responseCounts: counts,
    finalizedCancelled: [],
    fetchedAt: tip.time,
  };
}

function pageOf(set: SurveySet, linked: number): SurveyPage {
  return {
    ...set,
    counts: { all: linked, linked, active: linked, sealed: 0, public: linked, mine: 0 },
    nextCursor: null,
  };
}

function bundleOf(record: SurveyRecord, responses: ResponseRecord[]): SurveyBundlePage {
  return {
    survey: toJsonSafe(record),
    responses: responses.map(r => toJsonSafe(r)),
    cancellations: [],
    govLinks: [],
    tip,
    verdicts: {},
    nextCursor: null,
    fetchedAt: tip.time,
  };
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
          surveyKey: `${TX_NON_DREP}:0`,
          actionId: ACTION_ID,
          endEpoch: 300,
          title: 'The linking action',
        },
      ],
      { [KEY_LINKED]: 3, [`${TX_NON_DREP}:0`]: 1 },
    ),
    2,
  );
  return {
    surveyList: overrides.surveyList ?? (async () => ({ ready: true, value: page })),
    surveysByRefs:
      overrides.surveysByRefs ??
      (async () => ({
        ready: true,
        value: setOf([linked], page.govLinks.slice(0, 1), { [KEY_LINKED]: 3 }),
      })),
    surveyBundle:
      overrides.surveyBundle ??
      (async () => ({
        ready: true,
        // Three raw responses: two distinct DRep credentials (one of them
        // answering twice — latest wins) — the audited DRep count is 2, not
        // the list's raw 3.
        value: bundleOf(linked, [
          response('aa'),
          response('bb'),
          { ...response('aa', 0, tip.slot - 4_000), txHash: 'e'.repeat(64) },
        ]),
      })),
  };
}

function deps(tessera: SurveysTessera, now = 1_780_000_500_000): SurveysSyncDeps {
  return { db: env.DB, tessera, cfg: resolveNetwork('preprod'), now, rand: () => 'abcd1234' };
}

async function importLinkingAction(): Promise<void> {
  await buildInsertGovernanceAction(env.DB, {
    id: `${'f'.repeat(64)}#0`,
    proposalId: ACTION_ID,
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
    topicId: 'topic-of-the-action',
    now: 1,
  }).run();
}

async function surveyRows(): Promise<
  {
    ref: string;
    topic_id: string;
    counted_dreps: number | null;
    unavailable: number;
    cancelled: number;
  }[]
> {
  const { results } = await env.DB.prepare(
    'SELECT ref, topic_id, counted_dreps, unavailable, cancelled FROM survey ORDER BY ref',
  ).all<{
    ref: string;
    topic_id: string;
    counted_dreps: number | null;
    unavailable: number;
    cancelled: number;
  }>();
  return results;
}

describe('syncSurveys', () => {
  it('admits only the DRep-eligible linked survey, opens its thread, audits its DRep count', async () => {
    await importLinkingAction();

    const r = await syncSurveys(deps(fakeTessera()));
    expect(r).toMatchObject({ notReady: false, admitted: 1, failed: 0 });

    // Exactly one row: the linked non-DRep survey is not admitted, and the
    // standalone survey never appears in the linked list at all.
    const rows = await surveyRows();
    expect(rows.map(s => s.ref)).toEqual([KEY_LINKED]);
    // The card number is the audited DRep count (2 distinct credentials after
    // latest-wins), not the list's raw responseCount of 3.
    expect(rows[0].counted_dreps).toBe(2);

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

    const links = await env.DB.prepare('SELECT action_id FROM survey_gov_link WHERE survey_ref = ?')
      .bind(KEY_LINKED)
      .all<{ action_id: string }>();
    expect(links.results.map(l => l.action_id)).toEqual([ACTION_ID]);

    // Second run: nothing new, nothing duplicated.
    const r2 = await syncSurveys(deps(fakeTessera()));
    expect(r2).toMatchObject({ admitted: 0, failed: 0 });
    expect((await surveyRows()).length).toBe(1);
    const topics = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM topics WHERE source = 'survey'",
    ).first<{ n: number }>();
    expect(topics?.n).toBe(1);
  });

  it('does not admit a linked DRep survey whose action DRepTalk has not imported', async () => {
    const r = await syncSurveys(deps(fakeTessera()));
    expect(r.admitted).toBe(0);
    expect((await surveyRows()).length).toBe(0);
  });

  it('rolls a held survey back when a complete answer omits it, and clears it on reappearance', async () => {
    await importLinkingAction();
    await syncSurveys(deps(fakeTessera()));

    // The refresh answers complete (no `incomplete`) and empty: rolled back.
    const gone = fakeTessera({
      surveysByRefs: async () => ({ ready: true, value: setOf([], [], {}) }),
    });
    const r = await syncSurveys(deps(gone));
    expect(r.rolledBack).toBe(1);
    expect((await surveyRows())[0].unavailable).toBe(1);

    // An incomplete answer proves nothing: no rollback, and no clearing either.
    const incomplete = fakeTessera({
      surveysByRefs: async () => ({
        ready: true,
        value: { ...setOf([], [], {}), incomplete: true },
      }),
    });
    expect((await syncSurveys(deps(incomplete))).rolledBack).toBe(0);
    expect((await surveyRows())[0].unavailable).toBe(1);

    // The ref reappears in a complete answer: cleared.
    await syncSurveys(deps(fakeTessera()));
    expect((await surveyRows())[0].unavailable).toBe(0);
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
  });

  it('skips the run without recording an error while the backend has no snapshot', async () => {
    const notReady = fakeTessera({ surveyList: async () => ({ ready: false }) });
    const r = await syncSurveys(deps(notReady));
    expect(r).toEqual({
      notReady: true,
      admitted: 0,
      refreshed: 0,
      rolledBack: 0,
      audited: 0,
      failed: 0,
    });
    expect((await getSurveySyncState(env.DB)).lastFullWalkAt).toBeNull();
  });

  it('stamps the full-walk state on a single-page run and re-audits on the daily backstop', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    await syncSurveys(deps(fakeTessera(), now));
    const state = await getSurveySyncState(env.DB);
    expect(state).toMatchObject({ linkedCount: 2, lastFullWalkAt: now, lastAuditAt: now });

    // Within the backstop and with nothing changed, no re-audit runs.
    const later = now + 60 * 60 * 1000;
    expect((await syncSurveys(deps(fakeTessera(), later))).audited).toBe(0);

    // Past the backstop the held survey is re-audited even though nothing moved
    // (a proof verdict can flip without the raw count changing).
    const nextDay = now + 25 * 60 * 60 * 1000;
    expect((await syncSurveys(deps(fakeTessera(), nextDay))).audited).toBe(1);
    expect((await getSurveySyncState(env.DB)).lastAuditAt).toBe(nextDay);
    expect((await getHeldSurveys(env.DB))[0].countedDreps).toBe(2);
  });
});
