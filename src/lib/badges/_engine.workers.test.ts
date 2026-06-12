// Integration tests for the badge awarding engine against the migrated D1
// schema: seeding real rows, running the set-based pass, and asserting the
// monotonic award semantics (idempotent re-runs, tier upgrades, no revocation).
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { resolveNetwork, epochStartUnix, epochFromUnix } from '../config/network.js';
import { awardBadges, longestConsecutiveRun, longestCoveredSpan } from './engine.js';
import { getSubjectAwards } from '../db/badgeAwards.js';

const cfg = resolveNetwork('mainnet');
const NOW = Date.now();
// Mid-epoch timestamp (ms): keeps seeded posts away from real epoch boundaries
// so the boundary-rider assertions cannot flake on the wall clock.
const MID_EPOCH = (epochStartUnix(epochFromUnix(Math.floor(NOW / 1000), cfg), cfg) + 216_000) * 1000;

function run() {
  return awardBadges({ db: env.DB, cfg, now: Date.now() });
}

async function awardsOf(subjectType: 'drep' | 'spo' | 'cc' | 'proposer' | 'user', subjectId: string) {
  const rows = await getSubjectAwards(env.DB, subjectType, subjectId);
  return new Map(rows.map((r) => [r.badgeId, r]));
}

async function seedAction(
  id: string,
  extra: Partial<{
    type: string;
    status: string;
    decided_epoch: number;
    submitted_epoch: number;
    expiry_epoch: number;
    return_address: string;
    topic_id: string;
    drep_yes_pct: number;
    drep_no_pct: number;
  }> = {},
) {
  await env.DB
    .prepare(
      `INSERT INTO governance_actions
         (id, type, anchor_status, status, decided_epoch, submitted_epoch, expiry_epoch,
          return_address, topic_id, drep_yes_pct, drep_no_pct, created_at, last_synced_at)
       VALUES (?, ?, 'no-anchor', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      extra.type ?? 'InfoAction',
      extra.status ?? 'active',
      extra.decided_epoch ?? null,
      extra.submitted_epoch ?? null,
      extra.expiry_epoch ?? null,
      extra.return_address ?? null,
      extra.topic_id ?? null,
      extra.drep_yes_pct ?? null,
      extra.drep_no_pct ?? null,
      NOW,
      NOW,
    )
    .run();
}

async function seedVote(
  gaId: string,
  voterId: string,
  extra: Partial<{ role: string; vote: string; meta_url: string; block_time: number }> = {},
) {
  await env.DB
    .prepare(
      `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, meta_url, block_time, synced_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .bind(gaId, extra.role ?? 'DRep', voterId, extra.vote ?? 'Yes', extra.meta_url ?? null, extra.block_time ?? null, NOW)
    .run();
}

async function seedUser(id: string, extra: Partial<{ drep_id: string; flags: number[] }> = {}) {
  const [d, s, c, p] = extra.flags ?? [0, 0, 0, 0];
  await env.DB
    .prepare(
      `INSERT INTO users (id, drep_id, is_drep, is_spo, is_cc, is_proposer, created_at, last_verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, extra.drep_id ?? null, d, s, c, p, NOW, NOW)
    .run();
}

async function seedTopic(id: string, authorId: string, extra: Partial<{ source: string; post_count: number }> = {}) {
  await env.DB
    .prepare(
      `INSERT INTO topics (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at)
       VALUES (?, 'general', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, authorId, extra.source ?? 'user', `t ${id}`, `slug-${id}`, extra.post_count ?? 0, NOW, NOW)
    .run();
}

async function seedPost(
  id: string,
  topicId: string,
  authorId: string,
  extra: Partial<{ up_count: number; created_at: number }> = {},
) {
  await env.DB
    .prepare(
      `INSERT INTO posts (id, topic_id, author_id, body_md, body_html, up_count, created_at)
       VALUES (?, ?, ?, 'b', '<p>b</p>', ?, ?)`,
    )
    .bind(id, topicId, authorId, extra.up_count ?? 0, extra.created_at ?? MID_EPOCH)
    .run();
}

async function seedDrep(
  drepId: string,
  extra: Partial<{ registered_epoch: number; active: number; name: string; bio: string; image_url: string; links: string }> = {},
) {
  await env.DB
    .prepare(
      `INSERT INTO dreps (drep_id, status, active, registered_epoch, name, bio, image_url, links, last_synced_at, created_at)
       VALUES (?, 'registered', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      drepId,
      extra.active ?? 1,
      extra.registered_epoch ?? null,
      extra.name ?? null,
      extra.bio ?? null,
      extra.image_url ?? null,
      extra.links ?? null,
      NOW,
      NOW,
    )
    .run();
}

describe('streak helpers', () => {
  it('finds the longest consecutive epoch run', () => {
    expect(longestConsecutiveRun([])).toBe(0);
    expect(longestConsecutiveRun([5])).toBe(1);
    expect(longestConsecutiveRun([1, 2, 3, 7, 8])).toBe(3);
    expect(longestConsecutiveRun([8, 7, 3, 2, 1, 2])).toBe(3);
  });

  it('finds the longest covered span, bridging decision-free epochs', () => {
    const totals = new Map([
      [10, 2],
      [12, 1],
      [15, 1],
      [16, 1],
    ]);
    // Epoch 12 missed: spans are 10..10 and 15..16.
    const votedA = new Map([
      [10, 2],
      [15, 1],
      [16, 1],
    ]);
    expect(longestCoveredSpan([10, 12, 15, 16], totals, votedA)).toBe(2);
    // Everything covered: span runs 10..16 across the gap epochs.
    const votedB = new Map([
      [10, 2],
      [12, 1],
      [15, 1],
      [16, 1],
    ]);
    expect(longestCoveredSpan([10, 12, 15, 16], totals, votedB)).toBe(7);
    // Partial epoch breaks the run.
    const votedC = new Map([
      [10, 1],
      [12, 1],
      [15, 1],
      [16, 1],
    ]);
    expect(longestCoveredSpan([10, 12, 15, 16], totals, votedC)).toBe(5);
  });
});

describe('badge engine', () => {
  it('awards vote count and rationale badges and stays idempotent', async () => {
    for (let i = 0; i < 10; i++) {
      await seedAction(`ga-${i}`);
      await seedVote(`ga-${i}`, 'drep1', { meta_url: i < 10 ? `https://r/${i}` : undefined });
    }
    const first = await run();
    expect(first.written).toBeGreaterThan(0);

    const awards = await awardsOf('drep', 'drep1');
    expect(awards.get('first-vote')?.tier).toBe(0);
    expect(awards.get('active-voice')?.tier).toBe(1);
    expect(awards.get('shows-the-work')?.tier).toBe(1);

    const second = await run();
    expect(second.written).toBe(0);
  });

  it('upgrades tiers monotonically and never revokes', async () => {
    for (let i = 0; i < 10; i++) {
      await seedAction(`ga-${i}`);
      await seedVote(`ga-${i}`, 'drep1');
    }
    await run();
    const before = (await awardsOf('drep', 'drep1')).get('active-voice');
    expect(before?.tier).toBe(1);
    expect(before?.upgradedAt).toBeNull();

    for (let i = 10; i < 50; i++) {
      await seedAction(`ga-${i}`);
      await seedVote(`ga-${i}`, 'drep1');
    }
    await run();
    const after = (await awardsOf('drep', 'drep1')).get('active-voice');
    expect(after?.tier).toBe(2);
    expect(after?.awardedAt).toBe(before?.awardedAt);
    expect(after?.upgradedAt).not.toBeNull();

    await env.DB.prepare('DELETE FROM drep_votes').run();
    await run();
    expect((await awardsOf('drep', 'drep1')).get('active-voice')?.tier).toBe(2);
  });

  it('awards type coverage and event badges per role', async () => {
    const types = [
      'InfoAction',
      'TreasuryWithdrawals',
      'ParameterChange',
      'HardForkInitiation',
      'NoConfidence',
      'NewCommittee',
      'NewConstitution',
    ];
    for (const [i, type] of types.entries()) {
      await seedAction(`ga-${i}`, { type });
      await seedVote(`ga-${i}`, 'drep1');
    }
    await seedVote('ga-3', 'pool1', { role: 'SPO' });
    await run();

    const drep = await awardsOf('drep', 'drep1');
    expect(drep.has('full-spectrum')).toBe(true);
    expect(drep.has('constitution-voter')).toBe(true);
    expect(drep.has('hard-fork-voter')).toBe(true);
    expect(drep.has('steady-hand')).toBe(true);

    const spo = await awardsOf('spo', 'pool1');
    expect(spo.has('hard-fork-ready')).toBe(true);
    expect(spo.has('pool-voice')).toBe(false); // bronze needs 3 SPO votes
  });

  it('awards timing badges from the vote block_time', async () => {
    await seedAction('ga-early', { submitted_epoch: 540, expiry_epoch: 547 });
    await seedAction('ga-late', { submitted_epoch: 540, expiry_epoch: 547 });
    await seedVote('ga-early', 'drep1', { block_time: epochStartUnix(540, cfg) + 100 });
    await seedVote('ga-late', 'drep2', { block_time: epochStartUnix(547, cfg) + 100 });
    await run();

    expect((await awardsOf('drep', 'drep1')).has('early-bird')).toBe(true);
    expect((await awardsOf('drep', 'drep1')).has('buzzer-beater')).toBe(false);
    expect((await awardsOf('drep', 'drep2')).has('buzzer-beater')).toBe(true);
    expect((await awardsOf('drep', 'drep2')).has('early-bird')).toBe(false);
  });

  it('awards lone voice only on the minority side of decided actions', async () => {
    await seedAction('ga-1', { status: 'ratified', drep_yes_pct: 95, drep_no_pct: 4 });
    await seedVote('ga-1', 'minority', { vote: 'No' });
    await seedVote('ga-1', 'majority', { vote: 'Yes' });
    await run();

    expect((await awardsOf('drep', 'minority')).has('lone-voice')).toBe(true);
    expect((await awardsOf('drep', 'majority')).has('lone-voice')).toBe(false);
  });

  it('awards proposer badges keyed by return address', async () => {
    for (let i = 0; i < 5; i++) {
      await seedAction(`ga-${i}`, { return_address: 'stake1propose', status: i === 0 ? 'enacted' : 'active' });
    }
    await run();
    const awards = await awardsOf('proposer', 'stake1propose');
    expect(awards.has('proposer')).toBe(true);
    expect(awards.has('serial-proposer')).toBe(true);
    expect(awards.has('enacted')).toBe(true);
  });

  it('awards DRep registry badges', async () => {
    const currentEpoch = epochFromUnix(Math.floor(Date.now() / 1000), cfg);
    await seedDrep('drep-genesis', { registered_epoch: 510 });
    await seedDrep('drep-vet', { registered_epoch: currentEpoch - 80, active: 1 });
    await seedDrep('drep-id', {
      registered_epoch: currentEpoch - 5,
      name: 'Ada',
      bio: 'bio',
      image_url: 'https://img',
      links: '[{"uri":"https://x"}]',
    });
    await run();

    expect((await awardsOf('drep', 'drep-genesis')).has('genesis-drep')).toBe(true);
    expect((await awardsOf('drep', 'drep-vet')).has('veteran')).toBe(true);
    expect((await awardsOf('drep', 'drep-vet')).has('genesis-drep')).toBe(false);
    expect((await awardsOf('drep', 'drep-id')).has('identified')).toBe(true);
    expect((await awardsOf('drep', 'drep-genesis')).has('identified')).toBe(false);
  });

  it('awards the iron streak from fully covered eligible epochs', async () => {
    await seedDrep('drep1', { registered_epoch: 500 });
    for (let e = 500; e < 506; e++) {
      await seedAction(`ga-${e}`, { decided_epoch: e, status: 'ratified' });
      await seedVote(`ga-${e}`, 'drep1');
    }
    // A missed eligible epoch later does not erase the earlier 6-epoch span.
    await seedAction('ga-miss', { decided_epoch: 507, status: 'ratified' });
    await seedVote('ga-miss', 'other-drep');
    await run();

    expect((await awardsOf('drep', 'drep1')).get('iron-streak')?.tier).toBe(1);
    expect((await awardsOf('drep', 'other-drep')).has('iron-streak')).toBe(false);
  });

  it('awards forum badges from posts and topics', async () => {
    await seedUser('u1');
    await seedUser('u2');
    await seedTopic('t1', 'u1');
    for (let i = 0; i < 10; i++) {
      await seedPost(`p-u1-${i}`, 't1', 'u1', { up_count: i === 0 ? 10 : 0 });
    }
    for (let i = 0; i < 5; i++) {
      await seedPost(`p-u2-${i}`, 't1', 'u2');
    }
    await run();

    const u1 = await awardsOf('user', 'u1');
    expect(u1.has('hello-governance')).toBe(true);
    expect(u1.has('opening-move')).toBe(true);
    expect(u1.get('regular')?.tier).toBe(1);
    expect(u1.get('well-said')?.tier).toBe(1);
    expect(u1.has('crowd-favorite')).toBe(true);
    expect(u1.has('sparked-a-debate')).toBe(true);

    const u2 = await awardsOf('user', 'u2');
    expect(u2.has('hello-governance')).toBe(true);
    expect(u2.has('opening-move')).toBe(false);
    expect(u2.has('sparked-a-debate')).toBe(false);
  });

  it('awards hidden forum badges: necromancer, century thread, boundary rider, triple crown', async () => {
    await seedUser('u1', { flags: [1, 1, 0, 1] });
    await seedUser('u2');
    await seedTopic('t-old', 'u2');
    await seedPost('p-first', 't-old', 'u2', { created_at: MID_EPOCH - 70 * 86_400_000 });
    await seedPost('p-revive', 't-old', 'u1', { created_at: MID_EPOCH });
    await seedTopic('t-big', 'u2', { post_count: 100 });
    await seedPost('p-big', 't-big', 'u2');
    await seedTopic('t-edge', 'u2');
    await seedPost('p-edge', 't-edge', 'u2', { created_at: (epochStartUnix(540, cfg) + 60) * 1000 });
    await run();

    expect((await awardsOf('user', 'u1')).has('necromancer')).toBe(true);
    expect((await awardsOf('user', 'u1')).has('triple-crown')).toBe(true);
    expect((await awardsOf('user', 'u2')).has('necromancer')).toBe(false);
    expect((await awardsOf('user', 'u2')).has('century-thread')).toBe(true);
    expect((await awardsOf('user', 'u2')).has('boundary-rider')).toBe(true);
    expect((await awardsOf('user', 'u1')).has('boundary-rider')).toBe(false);
  });

  it('awards crossover badges to the linked DRep identity', async () => {
    await seedUser('u1', { drep_id: 'drep1' });
    for (let i = 0; i < 5; i++) {
      await seedTopic(`t-${i}`, 'gov-sync', { source: 'governance' });
      await seedAction(`ga-${i}`, { topic_id: `t-${i}` });
      await seedPost(`p-${i}`, `t-${i}`, 'u1', { created_at: MID_EPOCH - 1000 });
      await seedVote(`ga-${i}`, 'drep1', { meta_url: `https://r/${i}` });
    }
    await run();

    const awards = await awardsOf('drep', 'drep1');
    expect(awards.get('says-and-does')?.tier).toBe(1);
    expect(awards.has('open-book')).toBe(false); // needs 10 actions with rationale
  });

  it('awards the collector once every visible forum badge is earned', async () => {
    await seedUser('u1');
    // Pre-seed everything except hello-governance, which one post then earns.
    const preEarned = ['opening-move', 'regular', 'well-said', 'crowd-favorite', 'sparked-a-debate', 'forum-streak', 'on-the-record'];
    for (const badgeId of preEarned) {
      await env.DB
        .prepare(
          `INSERT INTO badge_awards (subject_type, subject_id, badge_id, tier, awarded_at) VALUES ('user', 'u1', ?, 1, ?)`,
        )
        .bind(badgeId, NOW)
        .run();
    }
    await seedTopic('t1', 'u1');
    await seedPost('p1', 't1', 'u1');
    await run();

    const awards = await awardsOf('user', 'u1');
    expect(awards.has('hello-governance')).toBe(true);
    expect(awards.has('collector')).toBe(true);
  });
});
