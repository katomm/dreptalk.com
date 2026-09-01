import { env } from 'cloudflare:test';
import { Role, type SurveyDefinition, type SurveyResponse } from 'cip-179';
import { hexToBytes, proofVerdictKey, type ResponseRecord, type SurveyRecord } from 'cip-179/domain';
import { toJsonSafe } from 'cip-179/tally';
import { describe, expect, it } from 'vitest';
import { resolveNetwork } from '../config/network.js';
import { buildInsertGovernanceAction } from '../db/governance.js';
import {
  getHeldSurveys,
  getLinkedSurveyForAction,
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
  type SurveyBundlePage,
  type SurveyPage,
  type SurveySet,
  TesseraHttpError,
  type TesseraTip,
} from '../tessera/client.js';
import { type SurveysSyncDeps, type SurveysTessera, syncSurveys } from './sync.js';

const TX_LINKED = 'a'.repeat(64);
const TX_SECOND = 'b'.repeat(64);
const TX_NON_DREP = 'c'.repeat(64);
const KEY_LINKED = `${TX_LINKED}:0`;
const KEY_SECOND = `${TX_SECOND}:0`;
const ACTION_ID = 'gov_action1linkedaction';
const ACTION_SECOND = 'gov_action1secondaction';

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
/** Mirrors the sync's AUDIT_RECHECK_MS / AUDIT_RETRY_BASE_MS. */
const DAY_MS = 24 * HOUR_MS;
const RETRY_MS = 5 * MIN_MS;
/** Mirrors the sync's UNAVAILABLE_TTL_MS. */
const ROLLBACK_TTL_MS = 4 * DAY_MS;

const LINKED_LINKS: SurveySet['govLinks'] = [
  { surveyKey: KEY_LINKED, actionId: ACTION_ID, endEpoch: 300, title: 'The linking action' },
];
const FINALIZED: SurveySet['finalState'] = {
  [KEY_LINKED]: { state: 'finalized', artifactHash: 'ab'.repeat(32) },
};

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
    finalState: {},
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
    // "Submitted, not indexed yet" — the backend's answer for any tx the
    // fake was not told about.
    responsesByTx: overrides.responsesByTx ?? (async () => ({ ready: true, value: [] })),
  };
}

function deps(tessera: SurveysTessera, now = 1_780_000_500_000): SurveysSyncDeps {
  return { db: env.DB, tessera, cfg: resolveNetwork('preprod'), now, rand: () => 'abcd1234' };
}

async function importLinkingAction(proposalId = ACTION_ID): Promise<void> {
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
    now: 1,
  }).run();
}

async function surveyRows(): Promise<
  {
    ref: string;
    topic_id: string;
    counted_dreps: number | null;
    final_state: string | null;
    audited_at: number | null;
    audit_due_at: number | null;
    audit_attempts: number;
    unavailable: number;
    unavailable_since: number | null;
    cancelled: number;
  }[]
> {
  const { results } = await env.DB.prepare(
    `SELECT ref, topic_id, counted_dreps, final_state, audited_at, audit_due_at, audit_attempts,
            unavailable, unavailable_since, cancelled
     FROM survey ORDER BY ref`,
  ).all<{
    ref: string;
    topic_id: string;
    counted_dreps: number | null;
    final_state: string | null;
    audited_at: number | null;
    audit_due_at: number | null;
    audit_attempts: number;
    unavailable: number;
    unavailable_since: number | null;
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
    let [row] = await surveyRows();
    expect(row.unavailable).toBe(1);
    expect(row.unavailable_since).toBe(1_780_000_500_000);

    // An incomplete answer proves nothing: no rollback, and no clearing either.
    const incomplete = fakeTessera({
      surveysByRefs: async () => ({
        ready: true,
        value: { ...setOf([], [], {}), incomplete: true },
      }),
    });
    expect((await syncSurveys(deps(incomplete))).rolledBack).toBe(0);
    expect((await surveyRows())[0].unavailable).toBe(1);

    // Still absent on a later run: the retirement clock keeps its first stamp.
    expect((await syncSurveys(deps(gone, 1_780_000_500_000 + HOUR_MS))).rolledBack).toBe(1);
    expect((await surveyRows())[0].unavailable_since).toBe(1_780_000_500_000);

    // The ref reappears in a complete answer: cleared, clock and all.
    await syncSurveys(deps(fakeTessera()));
    [row] = await surveyRows();
    expect(row.unavailable).toBe(0);
    expect(row.unavailable_since).toBeNull();
  });

  it('retires a survey unavailable past the rollback TTL from the refresh set', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    await syncSurveys(deps(fakeTessera(), now));
    const gone = fakeTessera({
      surveysByRefs: async () => ({ ready: true, value: setOf([], [], {}) }),
      // The rolled-back ref is outside Tessera's corpus: its bundle 404s,
      // which closes the audit schedule on the same terms.
      surveyBundle: async () => {
        throw new TesseraHttpError(404);
      },
    });
    await syncSurveys(deps(gone, now + HOUR_MS));
    // The re-audit due a day out meets the 404 and closes.
    expect(await syncSurveys(deps(gone, now + 25 * HOUR_MS))).toMatchObject({
      audited: 0,
      failed: 1,
    });

    // Within the TTL the ref is still asked about (the refs call runs and
    // reports it absent); past the TTL the row leaves the refresh set and the
    // run goes fully quiet — while the thread and row stay for the pages.
    expect((await syncSurveys(deps(gone, now + 2 * DAY_MS))).rolledBack).toBe(1);
    const guard = fakeTessera({
      surveysByRefs: async () => {
        throw new Error('a retired ref must not be refreshed');
      },
    });
    const after = await syncSurveys(deps(guard, now + HOUR_MS + ROLLBACK_TTL_MS + 1));
    expect(after).toMatchObject({ refreshed: 0, rolledBack: 0, audited: 0, failed: 0 });
    const [row] = await surveyRows();
    expect(row).toMatchObject({
      unavailable: 1,
      unavailable_since: now + HOUR_MS,
      audit_due_at: null,
      counted_dreps: 2,
    });
    expect(await listSurveysWithTopics(env.DB, { limit: 10, offset: 0 })).toHaveLength(1);
  });

  it('freezes a survey at any final state, and only "cancelled" reads as a cancellation', async () => {
    const first = surveyRecord(TX_LINKED, definition());
    const second = surveyRecord(TX_SECOND, definition({ title: 'Second survey' }));
    const links: SurveySet['govLinks'] = [
      { surveyKey: KEY_LINKED, actionId: ACTION_ID, endEpoch: 300, title: 'The linking action' },
      { surveyKey: KEY_SECOND, actionId: ACTION_SECOND, endEpoch: 300, title: 'The other action' },
    ];
    const counts = { [KEY_LINKED]: 3, [KEY_SECOND]: 1 };
    const open = setOf([first, second], links, counts);
    await importLinkingAction();
    await importLinkingAction(ACTION_SECOND);
    await syncSurveys(
      deps(
        fakeTessera({
          surveyList: async () => ({ ready: true, value: pageOf(open, 2) }),
          surveysByRefs: async () => ({ ready: true, value: open }),
        }),
      ),
    );
    expect((await getHeldSurveys(env.DB, 0)).map(h => h.ref).sort()).toEqual([KEY_LINKED, KEY_SECOND]);

    // The refresh answer declares both decided for good — one cancelled, one
    // finalized with an artifact. Only the cancelled one may surface as a
    // cancellation; both must freeze.
    const decided: SurveySet = {
      ...open,
      finalState: {
        [KEY_LINKED]: { state: 'cancelled', artifactHash: 'ab'.repeat(32) },
        [KEY_SECOND]: { state: 'finalized', artifactHash: 'cd'.repeat(32) },
      },
    };
    await syncSurveys(
      deps(
        fakeTessera({
          surveyList: async () => ({ ready: true, value: pageOf(open, 2) }),
          surveysByRefs: async () => ({ ready: true, value: decided }),
        }),
      ),
    );
    const { results } = await env.DB.prepare(
      'SELECT ref, cancelled, final_state FROM survey ORDER BY ref',
    ).all<{ ref: string; cancelled: number; final_state: string | null }>();
    expect(results).toEqual([
      { ref: KEY_LINKED, cancelled: 1, final_state: 'cancelled' },
      { ref: KEY_SECOND, cancelled: 0, final_state: 'finalized' },
    ]);
    expect(await getHeldSurveys(env.DB, 0)).toEqual([]);

    // Both frozen: the next run's refresh set is empty — the bounded working
    // set the finalState wire change buys.
    const r = await syncSurveys(
      deps(
        fakeTessera({
          surveyList: async () => ({ ready: true, value: pageOf(open, 2) }),
          surveysByRefs: async () => {
            throw new Error('a decided survey must not be refreshed');
          },
        }),
      ),
    );
    expect(r).toMatchObject({ refreshed: 0, failed: 0 });
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
    const notReady = fakeTessera({ surveyList: async () => ({ ready: false }) });
    const r = await syncSurveys(deps(notReady));
    expect(r).toEqual({
      notReady: true,
      admitted: 0,
      refreshed: 0,
      rolledBack: 0,
      audited: 0,
      settled: 0,
      agedFailed: 0,
      failed: 0,
    });
    expect((await getSurveySyncState(env.DB)).lastFullWalkAt).toBeNull();
  });

  it('stamps the full-walk state on a single-page run', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    await syncSurveys(deps(fakeTessera(), now));
    expect(await getSurveySyncState(env.DB)).toEqual({ linkedCount: 2, lastFullWalkAt: now });
  });

  it('re-arms a held survey a day out on success and re-audits it when due', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    expect((await syncSurveys(deps(fakeTessera(), now))).audited).toBe(1);
    let [row] = await surveyRows();
    expect(row).toMatchObject({ audited_at: now, audit_due_at: now + DAY_MS, audit_attempts: 0 });

    // Not due and nothing moved: no audit an hour later.
    expect((await syncSurveys(deps(fakeTessera(), now + HOUR_MS))).audited).toBe(0);

    // Once due, the survey is re-audited with no trigger firing — a proof
    // verdict can flip without the raw count moving.
    const nextDay = now + 25 * HOUR_MS;
    expect((await syncSurveys(deps(fakeTessera(), nextDay))).audited).toBe(1);
    [row] = await surveyRows();
    expect(row).toMatchObject({ audited_at: nextDay, audit_due_at: nextDay + DAY_MS });
  });

  it('audits once more when a final state arrives with the count unchanged, then closes', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    await syncSurveys(deps(fakeTessera(), now));
    expect((await surveyRows())[0].counted_dreps).toBe(2);

    // Tessera finalizes: the raw count has not moved, but a proof verdict now
    // rejects one of the two counted responses.
    const linked = surveyRecord(TX_LINKED, definition());
    const finalized = fakeTessera({
      surveysByRefs: async () => ({
        ready: true,
        value: { ...setOf([linked], LINKED_LINKS, { [KEY_LINKED]: 3 }), finalState: FINALIZED },
      }),
      surveyBundle: async () => ({
        ready: true,
        value: {
          ...bundleOf(linked, [response('aa'), response('bb')]),
          verdicts: { [proofVerdictKey(response('bb'))]: false },
        },
      }),
    });
    const later = now + RETRY_MS;
    expect((await syncSurveys(deps(finalized, later))).audited).toBe(1);
    const [row] = await surveyRows();
    expect(row).toMatchObject({
      final_state: 'finalized',
      counted_dreps: 1,
      audited_at: later,
      audit_due_at: null,
    });
  });

  it('keeps retrying a survey admitted already final until its audit lands', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    const linked = surveyRecord(TX_LINKED, definition());
    const finalPage: SurveyPage = {
      ...pageOf(setOf([linked], LINKED_LINKS, { [KEY_LINKED]: 3 }), 1),
      finalState: FINALIZED,
    };
    const listFinal = async () => ({ ready: true as const, value: finalPage });
    const failing = fakeTessera({
      surveyList: listFinal,
      surveyBundle: async () => {
        throw new TesseraHttpError(500);
      },
    });
    const working = fakeTessera({ surveyList: listFinal });

    // The admission-run audit fails: the failure is persisted on the row, not
    // forgotten with the in-memory queue.
    expect(await syncSurveys(deps(failing, now))).toMatchObject({
      admitted: 1,
      audited: 0,
      failed: 1,
    });
    let [row] = await surveyRows();
    expect(row).toMatchObject({
      final_state: 'finalized',
      counted_dreps: null,
      audited_at: null,
      audit_attempts: 1,
      audit_due_at: now + RETRY_MS,
    });

    // Backing off: not due one minute later.
    expect((await syncSurveys(deps(working, now + MIN_MS))).audited).toBe(0);

    // Due: the retry stores the audited final count and closes the schedule.
    expect((await syncSurveys(deps(working, now + 6 * MIN_MS))).audited).toBe(1);
    [row] = await surveyRows();
    expect(row).toMatchObject({ counted_dreps: 2, audit_due_at: null });
  });

  it('covers more than AUDIT_LIMIT due surveys across runs without re-auditing the done ones', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    const records = Array.from({ length: 25 }, (_, i) =>
      surveyRecord(String(i).padStart(2, '0').repeat(32), definition({ title: `Survey ${i}` })),
    );
    const links: SurveySet['govLinks'] = records.map(r => ({
      surveyKey: `${r.txHash}:0`,
      actionId: ACTION_ID,
      endEpoch: 300,
      title: 'The linking action',
    }));
    const counts = Object.fromEntries(records.map(r => [`${r.txHash}:0`, 1]));
    const set = setOf(records, links, counts);
    const byKey = new Map(records.map(r => [`${r.txHash}:0`, r]));
    const fake = fakeTessera({
      surveyList: async () => ({ ready: true, value: pageOf(set, 25) }),
      surveysByRefs: async () => ({ ready: true, value: set }),
      surveyBundle: async key => {
        const rec = byKey.get(key);
        if (!rec) throw new Error(`no record for ${key}`);
        return { ready: true, value: bundleOf(rec, []) };
      },
    });

    expect(await syncSurveys(deps(fake, now))).toMatchObject({ admitted: 25, audited: 20 });
    // The next run audits exactly the five left over — the twenty done ones
    // are scheduled a day out, not first in line again.
    expect(await syncSurveys(deps(fake, now + RETRY_MS))).toMatchObject({
      admitted: 0,
      audited: 5,
      failed: 0,
    });
    const done = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM survey WHERE counted_dreps IS NOT NULL',
    ).first<{ n: number }>();
    expect(done?.n).toBe(25);
  });

  it('a not-ready bundle marks no progress: the row stays due, uncharged', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    const notReadyBundle = fakeTessera({ surveyBundle: async () => ({ ready: false }) });
    expect(await syncSurveys(deps(notReadyBundle, now))).toMatchObject({ audited: 0, failed: 0 });
    const [row] = await surveyRows();
    // Losing the snapshot is not the survey's failure: no backoff charged.
    expect(row).toMatchObject({ audit_due_at: now, audit_attempts: 0 });
    expect((await syncSurveys(deps(fakeTessera(), now + 1_000))).audited).toBe(1);
  });

  it('treats a bundle 404 as terminal, but a refresh trigger can revive the schedule', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    await syncSurveys(deps(fakeTessera(), now));

    const linked = surveyRecord(TX_LINKED, definition());
    const gone404 = fakeTessera({
      // The moved count schedules a re-audit; the bundle route answers 404.
      surveysByRefs: async () => ({
        ready: true,
        value: setOf([linked], LINKED_LINKS, { [KEY_LINKED]: 4 }),
      }),
      surveyBundle: async () => {
        throw new TesseraHttpError(404);
      },
    });
    expect(await syncSurveys(deps(gone404, now + HOUR_MS))).toMatchObject({
      audited: 0,
      failed: 1,
    });
    let [row] = await surveyRows();
    // Terminal on the first answer — no backoff ladder — and a held row keeps
    // its last audited count.
    expect(row).toMatchObject({ audit_due_at: null, counted_dreps: 2 });

    // The ref is back in the corpus and its count moved again: the refresh
    // trigger re-arms the schedule and the audit succeeds.
    const back = fakeTessera({
      surveysByRefs: async () => ({
        ready: true,
        value: setOf([linked], LINKED_LINKS, { [KEY_LINKED]: 5 }),
      }),
    });
    expect((await syncSurveys(deps(back, now + 2 * HOUR_MS))).audited).toBe(1);
    [row] = await surveyRows();
    expect(row.counted_dreps).toBe(2);
  });

  it('a decided survey concedes after exhausted retries and clears its count; a held one never concedes', async () => {
    await importLinkingAction();
    const now = 1_780_000_500_000;
    await syncSurveys(deps(fakeTessera(), now));

    const linked = surveyRecord(TX_LINKED, definition());
    const failing = (finalState: SurveySet['finalState']) =>
      fakeTessera({
        surveysByRefs: async () => ({
          ready: true,
          value: { ...setOf([linked], LINKED_LINKS, { [KEY_LINKED]: 3 }), finalState },
        }),
        surveyBundle: async () => {
          throw new TesseraHttpError(500);
        },
      });

    // Held at the top of the ladder: the next failure keeps backing off at the
    // cap instead of conceding — a held row exits by finalizing or rolling
    // back, never by exhaustion.
    await env.DB.prepare('UPDATE survey SET audit_attempts = 7, audit_due_at = ?').bind(now).run();
    await syncSurveys(deps(failing({}), now));
    let [row] = await surveyRows();
    expect(row).toMatchObject({
      audit_attempts: 8,
      audit_due_at: now + Math.min(RETRY_MS * 2 ** 7, DAY_MS),
      counted_dreps: 2,
    });

    // Finalization arrives while the bundle route is down: the trigger resets
    // the ladder and records the post-final audit debt.
    await syncSurveys(deps(failing(FINALIZED), now));
    [row] = await surveyRows();
    expect(row).toMatchObject({ final_state: 'finalized', audit_attempts: 1, counted_dreps: 2 });

    // Fast-forward to the last rung: the next failure concedes — schedule
    // closed, and the never-confirmed count cleared rather than frozen.
    await env.DB.prepare('UPDATE survey SET audit_attempts = 7, audit_due_at = ?').bind(now).run();
    await syncSurveys(deps(failing(FINALIZED), now));
    [row] = await surveyRows();
    expect(row).toMatchObject({ audit_due_at: null, counted_dreps: null });

    // Closed means closed: a later healthy run audits nothing.
    expect((await syncSurveys(deps(fakeTessera(), now + DAY_MS))).audited).toBe(0);
    expect((await surveyRows())[0].counted_dreps).toBeNull();
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
        value:
          txHash === txIndexed
            ? [{ surveyKey: KEY_LINKED, responseIndex: 0, role: 0, credential: cred, slot: 1 }]
            : [],
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
    expect(r.agedFailed).toBe(1);
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
      responsesByTx: async () => ({ ready: true, value: responses }),
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
