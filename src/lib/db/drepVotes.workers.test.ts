import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertVotes, getDrepVotingHistory, countDrepVotes, recordLocalVote, getViewerVote, markStalePendingVotesFailed, getActionSpoVoters, countActionSpoVoters, getVotesByGaId, buildVoteUpsertStatements, classifyVoteJobs, getVoteTrendRows, listDrepVotePowers, listDrepVotePowersByAction } from './drepVotes.js';
import { loadExistingVotes } from './voteHistory.js';
import { addChannel, getPrefs, getPendingCounts } from './notificationChannels.js';
import { resolvePendingLead } from '../notifications/pendingLead.js';
import { createTopic } from './forum.js';
import { upsertActionRationale } from './actionRationale.js';
import { upsertVoteRationalePost } from './voteRationalePost.js';

async function seedAction(id: string, title: string, decidedEpoch: number) {
  await env.DB.prepare(
    `INSERT INTO governance_actions (id, type, title, status, decided_epoch, submitted_epoch, topic_id, created_at, last_synced_at)
     VALUES (?, 'InfoAction', ?, 'enacted', ?, ?, NULL, 0, 0)`,
  ).bind(id, title, decidedEpoch, decidedEpoch - 7).run();
}

describe('getDrepVotingHistory + countDrepVotes', () => {
  it('returns a DRep votes joined to action context, newest action first', async () => {
    await seedAction('ga1', 'Action One', 500);
    await seedAction('ga2', 'Action Two', 520);
    await upsertVotes(env.DB, 'ga1', [{ voterRole: 'DRep', voterId: 'drepX', voterHex: null, vote: 'Yes' }], 1);
    await upsertVotes(env.DB, 'ga2', [{ voterRole: 'DRep', voterId: 'drepX', voterHex: null, vote: 'No' }], 1);
    await upsertVotes(env.DB, 'ga1', [{ voterRole: 'DRep', voterId: 'drepOther', voterHex: null, vote: 'Yes' }], 1);

    const history = await getDrepVotingHistory(env.DB, 'drepX', { limit: 10 });
    // No block_time on these votes, so ordering falls back to the action's decided epoch.
    expect(history.map((h) => h.ga_id)).toEqual(['ga2', 'ga1']);
    expect(history[0].vote).toBe('No');
    expect(history[0].title).toBe('Action Two');
    expect(history[0].decided_epoch).toBe(520);
    expect(history[0].submitted_epoch).toBe(513);

    expect(await countDrepVotes(env.DB, 'drepX')).toBe(2);
    expect(await countDrepVotes(env.DB, 'drepOther')).toBe(1);
  });

  it('orders by the vote time so a freshly changed vote on an open action leads', async () => {
    // A long-decided action the DRep voted on ages ago.
    await seedAction('gaDecided', 'Decided Action', 500);
    await upsertVotes(env.DB, 'gaDecided', [
      { voterRole: 'DRep', voterId: 'drepRev', voterHex: null, vote: 'No', blockTime: 1_000 },
    ], 1);
    // An action still open for voting (decided_epoch NULL) the DRep just re-voted on.
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, decided_epoch, topic_id, created_at, last_synced_at)
       VALUES ('gaOpen', 'InfoAction', 'Open Action', 'voting', NULL, NULL, 0, 0)`,
    ).run();
    await upsertVotes(env.DB, 'gaOpen', [
      { voterRole: 'DRep', voterId: 'drepRev', voterHex: null, vote: 'Yes', blockTime: 2_000 },
    ], 1);

    // The most recent vote must lead; an open action must not sink below decided ones.
    const history = await getDrepVotingHistory(env.DB, 'drepRev', { limit: 10 });
    expect(history.map((h) => h.ga_id)).toEqual(['gaOpen', 'gaDecided']);
  });

  it('upsertVotes persists the vote anchor hash', async () => {
    const gaId = `${'a'.repeat(64)}#0`;
    await upsertVotes(env.DB, gaId, [{
      voterRole: 'DRep', voterId: 'drep1power', voterHex: null, vote: 'yes',
      metaUrl: 'https://example.org/r.json', metaHash: 'ff'.repeat(32), blockTime: 1_700_000_000,
    }], 1_700_000_100);
    const row = await env.DB
      .prepare(`SELECT meta_hash FROM drep_votes WHERE ga_id = ? AND voter_id = ?`)
      .bind(gaId, 'drep1power').first<{ meta_hash: string }>();
    expect(row?.meta_hash).toBe('ff'.repeat(32));
  });

  it('upsertVotes persists the rationale anchor (meta_url)', async () => {
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, decided_epoch, topic_id, created_at, last_synced_at)
       VALUES ('m1', 'InfoAction', 'M1', 'enacted', 500, NULL, 0, 0)`,
    ).run();
    await upsertVotes(env.DB, 'm1', [
      { voterRole: 'DRep', voterId: 'drepM', voterHex: null, vote: 'Yes', metaUrl: 'ipfs://rationale' },
    ], 1);
    const row = await env.DB.prepare('SELECT meta_url FROM drep_votes WHERE ga_id = ? AND voter_id = ?')
      .bind('m1', 'drepM').first<{ meta_url: string | null }>();
    expect(row?.meta_url).toBe('ipfs://rationale');
  });

  describe('confirmedOnly', () => {
    it('excludes optimistic pending AND failed votes, keeping only on-chain confirmed rows', async () => {
      await seedAction('gaConfirmed', 'Confirmed Action', 500);
      await seedAction('gaPending', 'Pending Action', 501);
      await seedAction('gaFailed', 'Failed Action', 502);

      // Confirmed: an authoritative upsert (local_status NULL).
      await upsertVotes(env.DB, 'gaConfirmed', [
        { voterRole: 'DRep', voterId: 'drepConf', voterHex: null, vote: 'Yes', blockTime: 1000 },
      ], 1);
      // Optimistic self-cast never yet reconciled by the sync.
      await recordLocalVote(env.DB, { gaId: 'gaPending', drepId: 'drepConf', voterHex: null, vote: 'yes', metaUrl: null, txHash: 'txp', now: 2000 });
      // A self-cast reconciled as failed.
      await env.DB.prepare(
        `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, block_time, synced_at, local_status)
         VALUES ('gaFailed', 'DRep', 'drepConf', NULL, 'No', 3000, 1, 'failed')`,
      ).run();

      const confirmedOnly = await getDrepVotingHistory(env.DB, 'drepConf', { confirmedOnly: true });
      expect(confirmedOnly.map((h) => h.ga_id)).toEqual(['gaConfirmed']);

      const all = await getDrepVotingHistory(env.DB, 'drepConf');
      expect(all.map((h) => h.ga_id).sort()).toEqual(['gaConfirmed', 'gaPending']);
    });
  });
});

it('lists only SPO voters for an action, newest first', async () => {
  await env.DB.prepare(
    `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, block_time, synced_at, local_status)
     VALUES ('gaX','SPO','pool1old','h1','Yes',100,1,'onchain'),
            ('gaX','SPO','pool1new','h2','No',200,1,'onchain'),
            ('gaX','DRep','drep1','h3','Yes',150,1,'onchain')`,
  ).run();
  const voters = await getActionSpoVoters(env.DB, 'gaX');
  expect(voters.map((v) => v.voter_id)).toEqual(['pool1new', 'pool1old']);
  expect(await countActionSpoVoters(env.DB, 'gaX')).toBe(2);
});

describe('upsertVotes delegator fan-out jobs', () => {
  // upsertVotes' `now` is unix milliseconds (drives synced_at); the job's
  // source_time / created_at are seconds.
  const NOW_MS = 1_700_000_000_000;

  async function allJobs() {
    return (
      await env.DB.prepare('SELECT * FROM notification_fanout_jobs ORDER BY event_key').all<{
        event_key: string; event_type: string; subject_id: string; source_time: number; payload: string;
      }>()
    ).results;
  }
  async function jobsFor(subjectId: string) {
    return (
      await env.DB
        .prepare('SELECT * FROM notification_fanout_jobs WHERE subject_id = ? ORDER BY event_key')
        .bind(subjectId)
        .all<{ event_key: string; event_type: string; subject_id: string; source_time: number; payload: string }>()
    ).results;
  }

  // Proxies a D1Database so the delegator fan-out job INSERT is swapped for a
  // statement that fails at execution (an unknown table). The failure is intrinsic
  // to the job statement, so it aborts whichever batch upsertVotes places the job
  // in: with the correct single-batch composition that is the same batch as the
  // vote/archive, so all of them roll back. Everything else forwards to the real DB.
  function poisonJobInsert(db: D1Database): D1Database {
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (sql: string) =>
            sql.includes('INTO notification_fanout_jobs')
              ? // 7 placeholders, matching buildJobInsert's bind arity, so bind
                // succeeds and the failure surfaces at batch execution, not at bind.
                target.prepare('INSERT INTO __no_such_fanout_table__ (a, b, c, d, e, f, g) VALUES (?, ?, ?, ?, ?, ?, ?)')
              : target.prepare(sql);
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  it('(a) a new followed-DRep vote emits a `voted` job with the exact event_key', async () => {
    await seedAction('gaVote', 'Vote Action', 500);
    await upsertVotes(
      env.DB,
      'gaVote',
      [{ voterRole: 'DRep', voterId: 'drepF', voterHex: null, vote: 'Yes', blockTime: 1_700_000_100 }],
      NOW_MS,
      { followedDrepIds: new Set(['drepF']) },
    );
    const jobs = await allJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].event_key).toBe('drep-vote:drepF:gaVote:1700000100');
    expect(jobs[0].event_type).toBe('delegator_drep_voted');
    expect(jobs[0].subject_id).toBe('drepF');
    expect(jobs[0].source_time).toBe(1_700_000_100);
    const payload = JSON.parse(jobs[0].payload);
    expect(payload).toMatchObject({ sourceTime: 1_700_000_100, gaId: 'gaVote', title: 'Vote Action', vote: 'Yes' });
    expect(payload.sourceTimeApprox).toBeUndefined();
  });

  it('(a2) a followed-DRep vote with no block_time falls back to the observed second and flags it approximate', async () => {
    await seedAction('gaApprox', 'Approx Action', 500);
    await upsertVotes(
      env.DB,
      'gaApprox',
      [{ voterRole: 'DRep', voterId: 'drepF', voterHex: null, vote: 'Yes' }],
      NOW_MS,
      { followedDrepIds: new Set(['drepF']) },
    );
    const observedSec = Math.floor(NOW_MS / 1000);
    const jobs = await jobsFor('drepF');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].event_key).toBe(`drep-vote:drepF:gaApprox:${observedSec}`);
    expect(jobs[0].source_time).toBe(observedSec);
    expect(JSON.parse(jobs[0].payload).sourceTimeApprox).toBe(true);
  });

  it('(b) a pending self-cast confirmed by the authoritative vote emits a `voted` job', async () => {
    await seedAction('gaB', 'B', 500);
    await recordLocalVote(env.DB, { gaId: 'gaB', drepId: 'drepF', voterHex: null, vote: 'yes', metaUrl: null, txHash: 'tx', now: 1000 });
    await upsertVotes(
      env.DB,
      'gaB',
      [{ voterRole: 'DRep', voterId: 'drepF', voterHex: null, vote: 'yes', blockTime: 2000 }],
      NOW_MS,
      { followedDrepIds: new Set(['drepF']) },
    );
    const jobs = await jobsFor('drepF');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].event_type).toBe('delegator_drep_voted');
    expect(jobs[0].event_key).toBe('drep-vote:drepF:gaB:2000');
  });

  it('(c) an authoritative vote change with a newer block_time emits a `re_voted` job', async () => {
    await seedAction('gaC', 'C', 500);
    // Establish the authoritative baseline row (no opts, so no job).
    await upsertVotes(env.DB, 'gaC', [{ voterRole: 'DRep', voterId: 'drepF', voterHex: null, vote: 'No', blockTime: 1000 }], NOW_MS);
    await upsertVotes(
      env.DB,
      'gaC',
      [{ voterRole: 'DRep', voterId: 'drepF', voterHex: null, vote: 'Yes', blockTime: 2000 }],
      NOW_MS + 1000,
      { followedDrepIds: new Set(['drepF']) },
    );
    const jobs = await jobsFor('drepF');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].event_type).toBe('delegator_drep_re_voted');
    expect(jobs[0].event_key).toBe('drep-revote:drepF:gaC:2000');
    // The payload carries the NEW choice, so the notification can name it.
    expect(JSON.parse(jobs[0].payload).vote).toBe('Yes');
  });

  it('(d) an anchor-only change (same vote) emits NO job', async () => {
    await seedAction('gaD', 'D', 500);
    await upsertVotes(env.DB, 'gaD', [{ voterRole: 'DRep', voterId: 'drepF', voterHex: null, vote: 'Yes', metaUrl: 'ipfs://a', blockTime: 1000 }], NOW_MS);
    await upsertVotes(
      env.DB,
      'gaD',
      [{ voterRole: 'DRep', voterId: 'drepF', voterHex: null, vote: 'Yes', metaUrl: 'ipfs://b', blockTime: 2000 }],
      NOW_MS + 1000,
      { followedDrepIds: new Set(['drepF']) },
    );
    expect(await jobsFor('drepF')).toHaveLength(0);
  });

  it('(e) a DRep not in the follower set emits NO job', async () => {
    await seedAction('gaE', 'E', 500);
    await upsertVotes(
      env.DB,
      'gaE',
      [{ voterRole: 'DRep', voterId: 'drepOut', voterHex: null, vote: 'Yes', blockTime: 1000 }],
      NOW_MS,
      { followedDrepIds: new Set(['drepF']) },
    );
    expect(await allJobs()).toHaveLength(0);
  });

  it('(f) without followedDrepIds opts, upsertVotes emits NO job (backward compatible)', async () => {
    await seedAction('gaG', 'G', 500);
    await upsertVotes(env.DB, 'gaG', [{ voterRole: 'DRep', voterId: 'drepF', voterHex: null, vote: 'Yes', blockTime: 1000 }], NOW_MS);
    expect(await allJobs()).toHaveLength(0);
  });

  // Builder-level check: the combined batch is atomic and the classifier does emit
  // a job for a followed DRep. This proves the pieces compose; the two integration
  // tests below prove upsertVotes ITSELF puts them in one batch (the real guard).
  it('atomicity (builders): a failing statement in a hand-built combined batch leaves neither the vote row nor the job', async () => {
    await seedAction('gaAtom', 'Atom', 500);
    const votes = [{ voterRole: 'DRep', voterId: 'drepF', voterHex: null, vote: 'Yes', blockTime: 1000 }];
    const existing = await loadExistingVotes(env.DB, 'gaAtom');
    const voteStmts = buildVoteUpsertStatements(env.DB, 'gaAtom', votes, NOW_MS);
    const jobStmts = classifyVoteJobs(env.DB, 'gaAtom', votes, existing, new Set(['drepF']), NOW_MS, 'Atom');
    expect(jobStmts).toHaveLength(1);
    // A statement that violates a NOT NULL constraint aborts the whole batch transaction.
    const failing = env.DB.prepare("INSERT INTO notification_fanout_jobs (event_key) VALUES ('boom')");
    await expect(env.DB.batch([...voteStmts, ...jobStmts, failing])).rejects.toThrow();

    const voteCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM drep_votes WHERE ga_id = ?').bind('gaAtom').first<{ n: number }>();
    expect(voteCount?.n).toBe(0);
    expect(await allJobs()).toHaveLength(0);
  });

  // Drives upsertVotes itself and forces a failure that travels with the JOB
  // statement (the job INSERT is swapped for one that fails at execution). Because
  // production folds vote + job into ONE batch, that batch rolls back both. If a
  // regression split them into two batches, the vote's batch would commit before
  // the job's batch failed, so the vote would persist and the vote-absent assertion
  // below would FAIL. This is the actual regression guard.
  it('(atomicity) upsertVotes composes a new vote and its job in one batch: a job failure rolls back the vote too', async () => {
    await seedAction('gaAtomFn', 'AtomFn', 500);
    await expect(
      upsertVotes(
        poisonJobInsert(env.DB),
        'gaAtomFn',
        [{ voterRole: 'DRep', voterId: 'drepF', voterHex: null, vote: 'Yes', blockTime: 1000 }],
        NOW_MS,
        { followedDrepIds: new Set(['drepF']) },
      ),
    ).rejects.toThrow();

    // Both the vote row and the job must be absent: the whole chunk rolled back.
    const voteCount = await env.DB
      .prepare('SELECT COUNT(*) AS n FROM drep_votes WHERE ga_id = ?')
      .bind('gaAtomFn')
      .first<{ n: number }>();
    expect(voteCount?.n).toBe(0);
    expect(await jobsFor('drepF')).toHaveLength(0);
  });

  // Superseding path: a pre-existing authoritative vote is re-voted (newer block_time),
  // which makes upsertVotes emit a history archive + the updated vote upsert + a
  // `re_voted` job, all in one batch. Under the forced job failure, ALL of history,
  // the vote update, and the job must roll back, and the pre-existing row must keep
  // its old value. A two-batch regression would commit the archive + updated vote
  // before the job batch failed, failing these assertions.
  it('(atomicity) upsertVotes composes a re-vote archive, updated vote, and job in one batch: a job failure rolls back all three', async () => {
    await seedAction('gaAtomRe', 'AtomRe', 500);
    // Pre-existing older authoritative row (no opts, so no job) the re-vote supersedes.
    await upsertVotes(env.DB, 'gaAtomRe', [{ voterRole: 'DRep', voterId: 'drepF', voterHex: null, vote: 'No', blockTime: 1000 }], NOW_MS);

    await expect(
      upsertVotes(
        poisonJobInsert(env.DB),
        'gaAtomRe',
        [{ voterRole: 'DRep', voterId: 'drepF', voterHex: null, vote: 'Yes', blockTime: 2000 }],
        NOW_MS + 1000,
        { followedDrepIds: new Set(['drepF']) },
      ),
    ).rejects.toThrow();

    // No archive row was written.
    const historyCount = await env.DB
      .prepare('SELECT COUNT(*) AS n FROM drep_vote_history WHERE ga_id = ? AND voter_id = ?')
      .bind('gaAtomRe', 'drepF')
      .first<{ n: number }>();
    expect(historyCount?.n).toBe(0);
    // No job was written.
    expect(await jobsFor('drepF')).toHaveLength(0);
    // The pre-existing vote is untouched: still the old value at the old block_time.
    const row = await env.DB
      .prepare('SELECT vote, block_time FROM drep_votes WHERE ga_id = ? AND voter_id = ?')
      .bind('gaAtomRe', 'drepF')
      .first<{ vote: string; block_time: number }>();
    expect(row?.vote).toBe('No');
    expect(row?.block_time).toBe(1000);
  });
});

describe('local vote record + reconcile', () => {
  const gaId = `${'b'.repeat(64)}#0`;
  const drepId = `drep1${'a'.repeat(50)}`;

  it('records a pending vote and reads it back', async () => {
    await recordLocalVote(env.DB, { gaId, drepId, voterHex: null, vote: 'yes', metaUrl: null, txHash: 'tx1', now: 1000 });
    const v = await getViewerVote(env.DB, gaId, drepId);
    expect(v?.vote).toBe('yes');
    expect(v?.local_status).toBe('pending');
    expect(v?.tx_hash).toBe('tx1');
  });

  it('authoritative upsert clears the pending marker', async () => {
    await recordLocalVote(env.DB, { gaId, drepId, voterHex: null, vote: 'yes', metaUrl: null, txHash: 'tx1', now: 1000 });
    await upsertVotes(env.DB, gaId, [{ voterRole: 'DRep', voterId: drepId, voterHex: null, vote: 'yes' }], 2000);
    const v = await getViewerVote(env.DB, gaId, drepId);
    expect(v?.local_status).toBeNull();
  });

  it('marks stale pending votes failed', async () => {
    await recordLocalVote(env.DB, { gaId, drepId, voterHex: null, vote: 'no', metaUrl: null, txHash: 'tx2', now: 1000 });
    const n = await markStalePendingVotesFailed(env.DB, 5000, 6000); // cutoff after synced_at=1000
    expect(n).toBe(1);
    const v = await getViewerVote(env.DB, gaId, drepId);
    expect(v?.local_status).toBe('failed');
  });

  it('hides a reconciled failed vote from public reads but keeps it for the viewer', async () => {
    await seedAction('gaFail', 'Fail Action', 600);
    await recordLocalVote(env.DB, { gaId: 'gaFail', drepId: 'drepFail', voterHex: null, vote: 'yes', metaUrl: null, txHash: 'txf', now: 1000 });
    // Optimistic (pending) vote is visible everywhere.
    expect((await getVotesByGaId(env.DB, 'gaFail')).has('drepFail')).toBe(true);
    expect(await countDrepVotes(env.DB, 'drepFail')).toBe(1);

    await markStalePendingVotesFailed(env.DB, 5000, 6000);

    // Gone from every public read once reconciled to failed...
    expect((await getVotesByGaId(env.DB, 'gaFail')).has('drepFail')).toBe(false);
    expect(await countDrepVotes(env.DB, 'drepFail')).toBe(0);
    expect((await getDrepVotingHistory(env.DB, 'drepFail')).length).toBe(0);
    // ...but the voter still sees their own failed attempt (drives the retry UI).
    expect((await getViewerVote(env.DB, 'gaFail', 'drepFail'))?.local_status).toBe('failed');
  });

  it('reaps the optimistic rationale and cross-post when a vote fails', async () => {
    const { topic } = await createTopic(env.DB, {
      categorySlug: 'governance', authorId: 'sys', title: 'Reap Action',
      bodyMd: 'x', bodyHtml: '<p>x</p>', source: 'governance', now: 1, rand: 'reap',
    });
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, decided_epoch, topic_id, created_at, last_synced_at)
       VALUES ('gaReap', 'InfoAction', 'Reap', 'enacted', 600, ?, 0, 0)`,
    ).bind(topic.id).run();
    await env.DB.prepare(`INSERT INTO users (id, drep_id, created_at, last_verified_at) VALUES ('userReap', 'drepReap', 0, 0)`).run();
    // Artifacts vote/record writes optimistically.
    await upsertActionRationale(env.DB, {
      gaId: 'gaReap', voterId: 'drepReap', bodyHtml: '<p>r</p>', source: 'dreptalk',
      anchorUrl: null, status: 'ok', createdAt: 1000, now: 1000,
    });
    await upsertVoteRationalePost(env.DB, { topicId: topic.id, authorId: 'userReap', vote: 'yes', bodyMd: 'r', bodyHtml: '<p>r</p>', now: 1000 });
    await recordLocalVote(env.DB, { gaId: 'gaReap', drepId: 'drepReap', voterHex: null, vote: 'yes', metaUrl: null, txHash: 'txr', now: 1000 });

    const before = (await env.DB.prepare('SELECT post_count FROM topics WHERE id = ?').bind(topic.id).first<{ post_count: number }>())?.post_count ?? 0;

    await markStalePendingVotesFailed(env.DB, 5000, 6000);

    const rat = await env.DB.prepare(`SELECT COUNT(*) AS n FROM action_rationale WHERE ga_id = 'gaReap' AND voter_id = 'drepReap'`).first<{ n: number }>();
    expect(rat?.n).toBe(0); // dreptalk rationale deleted
    const post = await env.DB.prepare(`SELECT deleted, deleted_at FROM posts WHERE topic_id = ? AND author_id = 'userReap' AND source = 'vote_rationale'`).bind(topic.id).first<{ deleted: number; deleted_at: number }>();
    expect(post?.deleted).toBe(1); // cross-post soft-deleted
    expect(post?.deleted_at).toBe(6000); // stamped with the reconcile's own clock, not the sweep cutoff
    const after = (await env.DB.prepare('SELECT post_count FROM topics WHERE id = ?').bind(topic.id).first<{ post_count: number }>())?.post_count ?? 0;
    expect(after).toBe(before - 1); // topic count kept in step
  });
});

describe('upsertVotes voted_power', () => {
  it('does not null a stored voted_power when a later sync omits it', async () => {
    const ga = 'gaid_test_power';
    await upsertVotes(env.DB, ga, [
      { voterRole: 'DRep', voterId: 'drep1', voterHex: null, vote: 'Yes', blockTime: 100, votedPower: 500 },
    ], 1);
    // A later sync of the same vote without a resolved power.
    await upsertVotes(env.DB, ga, [
      { voterRole: 'DRep', voterId: 'drep1', voterHex: null, vote: 'Yes', blockTime: 100, votedPower: null },
    ], 2);
    const row = await env.DB
      .prepare('SELECT voted_power FROM drep_votes WHERE ga_id = ? AND voter_id = ?')
      .bind(ga, 'drep1')
      .first<{ voted_power: number | null }>();
    expect(row?.voted_power).toBe(500);
  });

  it('updates voted_power when a new value is provided', async () => {
    const ga = 'gaid_test_power2';
    await upsertVotes(env.DB, ga, [{ voterRole: 'SPO', voterId: 'pool1', voterHex: null, vote: 'Yes', blockTime: 100, votedPower: 10 }], 1);
    await upsertVotes(env.DB, ga, [{ voterRole: 'SPO', voterId: 'pool1', voterHex: null, vote: 'Yes', blockTime: 100, votedPower: 20 }], 2);
    const row = await env.DB.prepare('SELECT voted_power FROM drep_votes WHERE ga_id = ? AND voter_id = ?').bind(ga, 'pool1').first<{ voted_power: number }>();
    expect(row?.voted_power).toBe(20);
  });
});

describe('getVoteTrendRows', () => {
  it('returns DRep+SPO rows with a block_time, oldest first, excluding CC', async () => {
    const ga = 'gaid_trend_read';
    await upsertVotes(env.DB, ga, [
      { voterRole: 'DRep', voterId: 'd1', voterHex: null, vote: 'Yes', blockTime: 300, votedPower: 9 },
      { voterRole: 'DRep', voterId: 'd2', voterHex: null, vote: 'No', blockTime: 100, votedPower: 4 },
      { voterRole: 'SPO', voterId: 'p1', voterHex: null, vote: 'Yes', blockTime: 200, votedPower: 7 },
      { voterRole: 'ConstitutionalCommittee', voterId: 'c1', voterHex: 'h1', vote: 'Yes', blockTime: 150, votedPower: null },
    ], 1);
    const rows = await getVoteTrendRows(env.DB, ga);
    expect(rows.map((r) => r.voter_id)).toEqual(['d2', 'p1', 'd1']); // 100, 200, 300; CC excluded
  });
});

describe('rationale-ready notification', () => {
  async function seedDrepUser(id: string, drepId: string, status = 'active') {
    await env.DB.prepare(
      `INSERT INTO users (id, drep_id, is_drep, role, status, created_at, last_verified_at, notif_seen_at)
       VALUES (?, ?, 1, 'drep', ?, 0, 0, 0)`,
    ).bind(id, drepId, status).run();
  }

  async function rationaleReadyRows(recipientId: string) {
    const { results } = await env.DB.prepare(
      `SELECT recipient_id, type, event_key, payload, created_at FROM notifications
       WHERE type = 'rationale_ready' AND recipient_id = ?`,
    ).bind(recipientId).all<{ recipient_id: string; type: string; event_key: string; payload: string; created_at: number }>();
    return results;
  }

  it('notifies the DRep account when its pending self-cast with a rationale confirms on chain', async () => {
    await seedAction('gaRR1', 'Rationale Action', 600);
    await seedDrepUser('userRR1', 'drepRR1');
    await recordLocalVote(env.DB, { gaId: 'gaRR1', drepId: 'drepRR1', voterHex: null, vote: 'Yes', metaUrl: 'https://host/r.json', txHash: 'tx1', now: 1_000 });
    await upsertVotes(env.DB, 'gaRR1', [
      { voterRole: 'DRep', voterId: 'drepRR1', voterHex: null, vote: 'Yes', metaUrl: 'https://host/r.json', blockTime: 2_000 },
    ], 5_000, { notifyRationaleReady: true });

    const rows = await rationaleReadyRows('userRR1');
    expect(rows).toHaveLength(1);
    expect(rows[0].event_key).toBe('rationale_ready:drepRR1:gaRR1:2000');
    expect(rows[0].created_at).toBe(5_000);
    expect(JSON.parse(rows[0].payload)).toMatchObject({
      sourceTime: 2_000, gaId: 'gaRR1', drepId: 'drepRR1', title: 'Rationale Action', vote: 'Yes',
    });
  });

  it('also fires for a pending row already marked failed that confirms late', async () => {
    await seedAction('gaRR2', 'Late Action', 600);
    await seedDrepUser('userRR2', 'drepRR2');
    await recordLocalVote(env.DB, { gaId: 'gaRR2', drepId: 'drepRR2', voterHex: null, vote: 'No', metaUrl: 'https://host/r2.json', txHash: 'tx2', now: 1_000 });
    await markStalePendingVotesFailed(env.DB, 2_000, 2_000_000);
    await upsertVotes(env.DB, 'gaRR2', [
      { voterRole: 'DRep', voterId: 'drepRR2', voterHex: null, vote: 'No', metaUrl: 'https://host/r2.json', blockTime: 3_000 },
    ], 5_000, { notifyRationaleReady: true });

    expect(await rationaleReadyRows('userRR2')).toHaveLength(1);
  });

  it('does not fire without the option (sync backfill path)', async () => {
    await seedAction('gaRR3', 'Backfill Action', 600);
    await seedDrepUser('userRR3', 'drepRR3');
    await recordLocalVote(env.DB, { gaId: 'gaRR3', drepId: 'drepRR3', voterHex: null, vote: 'Yes', metaUrl: 'https://host/r3.json', txHash: 'tx3', now: 1_000 });
    await upsertVotes(env.DB, 'gaRR3', [
      { voterRole: 'DRep', voterId: 'drepRR3', voterHex: null, vote: 'Yes', metaUrl: 'https://host/r3.json', blockTime: 2_000 },
    ], 5_000);

    expect(await rationaleReadyRows('userRR3')).toHaveLength(0);
  });

  it('does not fire when the confirmed vote carries no rationale anchor', async () => {
    await seedAction('gaRR4', 'Anchorless Action', 600);
    await seedDrepUser('userRR4', 'drepRR4');
    await recordLocalVote(env.DB, { gaId: 'gaRR4', drepId: 'drepRR4', voterHex: null, vote: 'Yes', metaUrl: null, txHash: 'tx4', now: 1_000 });
    await upsertVotes(env.DB, 'gaRR4', [
      { voterRole: 'DRep', voterId: 'drepRR4', voterHex: null, vote: 'Yes', blockTime: 2_000 },
    ], 5_000, { notifyRationaleReady: true });

    expect(await rationaleReadyRows('userRR4')).toHaveLength(0);
  });

  it('does not fire for a vote that was not cast through the site (no pending row)', async () => {
    await seedAction('gaRR5', 'External Action', 600);
    await seedDrepUser('userRR5', 'drepRR5');
    await upsertVotes(env.DB, 'gaRR5', [
      { voterRole: 'DRep', voterId: 'drepRR5', voterHex: null, vote: 'Yes', metaUrl: 'https://elsewhere/r.json', blockTime: 2_000 },
    ], 5_000, { notifyRationaleReady: true });

    expect(await rationaleReadyRows('userRR5')).toHaveLength(0);
  });

  it('does not fire again when the same confirmation re-syncs (event_key conflict)', async () => {
    await seedAction('gaRR6', 'Rerun Action', 600);
    await seedDrepUser('userRR6', 'drepRR6');
    await env.DB.prepare(
      `INSERT INTO notifications (id, recipient_id, type, event_key, payload, created_at)
       VALUES ('nRR6', 'userRR6', 'rationale_ready', 'rationale_ready:drepRR6:gaRR6:2000', '{}', 1)`,
    ).run();
    await recordLocalVote(env.DB, { gaId: 'gaRR6', drepId: 'drepRR6', voterHex: null, vote: 'Yes', metaUrl: 'https://host/r6.json', txHash: 'tx6', now: 1_000 });
    await upsertVotes(env.DB, 'gaRR6', [
      { voterRole: 'DRep', voterId: 'drepRR6', voterHex: null, vote: 'Yes', metaUrl: 'https://host/r6.json', blockTime: 2_000 },
    ], 5_000, { notifyRationaleReady: true });

    expect(await rationaleReadyRows('userRR6')).toHaveLength(1);
  });

  it('feeds counts and a deep-linked lead to the dispatcher', async () => {
    await env.DB.prepare(
      `INSERT INTO topics (id, category_slug, author_id, source, title, slug, deleted, last_post_at, created_at)
       VALUES ('tRR8', 'governance', 'gov-sync', 'governance', 'Rationale Lead Action', 'rationale-lead-action', 0, 0, 0)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, decided_epoch, topic_id, created_at, last_synced_at)
       VALUES ('gaRR8', 'InfoAction', 'Rationale Lead Action', 'voting', NULL, 'tRR8', 0, 0)`,
    ).run();
    await seedDrepUser('userRR8', 'drepRR8');
    const channelId = await addChannel(env.DB, { userId: 'userRR8', channel: 'webpush', target: '{}', endpoint: 'https://push.example/rr8', now: 1_000 });
    await recordLocalVote(env.DB, { gaId: 'gaRR8', drepId: 'drepRR8', voterHex: null, vote: 'Yes', metaUrl: 'https://host/r8.json', txHash: 'tx8', now: 1_000 });
    await upsertVotes(env.DB, 'gaRR8', [
      { voterRole: 'DRep', voterId: 'drepRR8', voterHex: null, vote: 'Yes', metaUrl: 'https://host/r8.json', blockTime: 2_000 },
    ], 5_000, { notifyRationaleReady: true });

    const row = (await env.DB.prepare('SELECT * FROM notification_channels WHERE id = ?').bind(channelId).first()) as never;
    const prefs = await getPrefs(env.DB, 'userRR8', 'webpush');
    const counts = await getPendingCounts(env.DB, row, prefs);
    expect(counts.rationaleReady).toBe(1);

    const lead = await resolvePendingLead(env.DB, row, prefs);
    expect(lead).toEqual({
      title: 'Rationale Lead Action',
      body: 'Your rationale is ready to share',
      href: '/dreps/drepRR8/vote/rationale-lead-action/',
    });
  });

  it('is a no-op when no active DRep account matches the voter', async () => {
    await seedAction('gaRR7', 'Unowned Action', 600);
    await seedDrepUser('userRR7', 'drepRR7', 'disabled');
    await recordLocalVote(env.DB, { gaId: 'gaRR7', drepId: 'drepRR7', voterHex: null, vote: 'Yes', metaUrl: 'https://host/r7.json', txHash: 'tx7', now: 1_000 });
    await upsertVotes(env.DB, 'gaRR7', [
      { voterRole: 'DRep', voterId: 'drepRR7', voterHex: null, vote: 'Yes', metaUrl: 'https://host/r7.json', blockTime: 2_000 },
    ], 5_000, { notifyRationaleReady: true });

    expect(await rationaleReadyRows('userRR7')).toHaveLength(0);
  });
});

describe('listDrepVotePowers', () => {
  it('returns only live DRep vote powers including NULLs', async () => {
    const db = env.DB;
    // Same-action rows: two DRep votes (one power missing), one SPO vote,
    // one locally failed DRep vote that liveVoteSql must exclude.
    await upsertVotes(db, 'ga_conc#0', [
      { voterRole: 'DRep', voterId: 'drep_a', voterHex: null, vote: 'Yes', votedPower: 100 },
      { voterRole: 'DRep', voterId: 'drep_b', voterHex: null, vote: 'No' },
      { voterRole: 'SPO', voterId: 'pool_x', voterHex: null, vote: 'Yes', votedPower: 999 },
      { voterRole: 'DRep', voterId: 'drep_c', voterHex: null, vote: 'Abstain', votedPower: 50 },
    ], 1);
    await db.prepare(`UPDATE drep_votes SET local_status = 'failed' WHERE ga_id = 'ga_conc#0' AND voter_id = 'drep_a'`).run();
    const powers = await listDrepVotePowers(db, 'ga_conc#0');
    expect(powers).toHaveLength(2);
    expect(powers).toContain(50);
    expect(powers).toContain(null);
  });
});

describe('listDrepVotePowersByAction', () => {
  it('groups powers by action id and returns an empty map for no ids', async () => {
    const db = env.DB;
    await upsertVotes(db, 'ga_batch_a#0', [
      { voterRole: 'DRep', voterId: 'drep_a', voterHex: null, vote: 'Yes', votedPower: 10 },
      { voterRole: 'DRep', voterId: 'drep_b', voterHex: null, vote: 'No', votedPower: 20 },
    ], 1);
    await upsertVotes(db, 'ga_batch_b#0', [
      { voterRole: 'DRep', voterId: 'drep_a', voterHex: null, vote: 'Yes', votedPower: 30 },
    ], 1);
    const map = await listDrepVotePowersByAction(db, ['ga_batch_a#0', 'ga_batch_b#0', 'ga_absent#0']);
    expect(map.get('ga_batch_a#0')).toHaveLength(2);
    expect(map.get('ga_batch_b#0')).toEqual([30]);
    expect(map.has('ga_absent#0')).toBe(false);
    expect((await listDrepVotePowersByAction(db, [])).size).toBe(0);
  });
});
