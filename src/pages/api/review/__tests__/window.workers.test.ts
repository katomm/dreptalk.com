// The window data pack: how a window of epochs is turned into the one JSON
// document a review edition is written from. Every assertion here is a
// semantic the published numbers depend on, so a change that breaks one is a
// change to what an edition means, not a test detail.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { buildWindowPack } from '@/lib/review/pack';
import { resolveNetwork, epochStartUnix } from '@/lib/config/network';
import { GET } from '../window/[range].json';

const cfg = resolveNetwork('mainnet');
const t = (epoch: number, offset = 100) => epochStartUnix(epoch, cfg) + offset;

async function seedAction(id: string, type: string, status: string, f: { submitted: number; ratified?: number | null; enacted?: number | null; decided?: number | null; expiry?: number | null; payload?: string | null; drepYesPct?: number | null }) {
  await env.DB.prepare(
    `INSERT INTO governance_actions (id, type, title, status, submitted_epoch, ratified_epoch, enacted_epoch, decided_epoch, expiry_epoch, onchain_payload, drep_yes_pct, thresholds_json, topic_id, created_at, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{"drep":67,"spo":51,"cc":66.7,"ccBelowMinSize":false,"v":2}', NULL, 0, 0)`,
  ).bind(id, type, `T ${id}`, status, f.submitted, f.ratified ?? null, f.enacted ?? null, f.decided ?? null, f.expiry ?? null, f.payload ?? null, f.drepYesPct ?? null).run();
}

const W = '0'.repeat(63);
const ids = { ratifiedIn: `${W}1#0`, closing: `${W}2#0`, open: `${W}3#0`, older: `${W}4#0`, withdrawal: `${W}5#0` };

describe('buildWindowPack', () => {
  it('groups actions into events, closingAtBoundary and open by lifecycle epochs', async () => {
    await seedAction(ids.ratifiedIn, 'InfoAction', 'closed', { submitted: 645, decided: 651, expiry: 651 });
    await seedAction(ids.closing, 'NewCommittee', 'active', { submitted: 646, expiry: 653, drepYesPct: 69.85 });
    await seedAction(ids.open, 'TreasuryWithdrawals', 'active', { submitted: 649, expiry: 656 });
    await seedAction(ids.older, 'InfoAction', 'closed', { submitted: 600, decided: 607, expiry: 607 });
    // Expired AFTER the window: open during it, even though its status is terminal today.
    await seedAction(`${W}6#0`, 'TreasuryWithdrawals', 'expired', { submitted: 627, decided: 634, expiry: 634 });
    const pack = await buildWindowPack(env.DB, cfg, 628, 630);
    expect(pack.actions.open.map((a) => a.id)).toEqual([`${W}6#0`]);
    const later = await buildWindowPack(env.DB, cfg, 650, 652);
    expect(later.actions.events.map((a) => a.id)).toEqual([ids.ratifiedIn]);
    expect(later.actions.closingAtBoundary.map((a) => a.id)).toEqual([ids.closing]);
    expect(later.actions.open.map((a) => a.id)).toEqual([ids.open]);
    expect(later.actions.events[0].eventsInWindow).toEqual([{ kind: 'closed', epoch: 651 }]);
  });

  it('compares only earlier actions and, for parameter changes, only the same parameters', async () => {
    const pc = (id: string, submitted: number, key: string, status = 'enacted') =>
      seedAction(id, 'ParameterChange', status, { submitted, decided: submitted + 6, enacted: submitted + 6, expiry: submitted + 7, payload: JSON.stringify({ tag: 'ParameterChange', contents: [null, { [key]: 1 }, null] }) });
    await pc(`${W}7#0`, 646, 'minPoolCost', 'active');
    await pc(`${W}8#0`, 606, 'minPoolCost');
    await pc(`${W}9#0`, 633, 'costModels');
    await pc(`${W}a#0`, 660, 'minPoolCost');
    const pack = await buildWindowPack(env.DB, cfg, 650, 652);
    expect(pack.actions.comparisons.map((a) => a.id)).toEqual([`${W}8#0`]);
  });

  it('sums withdrawal amounts and keeps ratifiedEpoch null when unknown', async () => {
    const payload = JSON.stringify({ tag: 'TreasuryWithdrawals', contents: [[[{ network: 'Mainnet', credential: { scriptHash: 'aa' } }, 120000000000000], [{ network: 'Mainnet', credential: { scriptHash: 'bb' } }, 5000000]], null] });
    await seedAction(ids.withdrawal, 'TreasuryWithdrawals', 'enacted', { submitted: 642, enacted: 650, decided: 650, expiry: 649, payload });
    const pack = await buildWindowPack(env.DB, cfg, 650, 652);
    const a = pack.actions.events[0];
    expect(a.withdrawalAda).toBe(120_000_005);
    expect(a.ratifiedEpoch).toBeNull();
    expect(a.eventsInWindow).toEqual([{ kind: 'enacted', epoch: 650 }]);
    expect(pack.treasury.largestSingle[0]).toMatchObject({ id: ids.withdrawal, ada: 120_000_005 });
  });

  it('ignores withdrawals enacted after the window in records and totals', async () => {
    const payload = (ada: number) => JSON.stringify({ tag: 'TreasuryWithdrawals', contents: [[[{ network: 'Mainnet', credential: { scriptHash: 'aa' } }, ada * 1_000_000]], null] });
    await seedAction(ids.withdrawal, 'TreasuryWithdrawals', 'enacted', { submitted: 620, enacted: 629, decided: 629, expiry: 628, payload: payload(5_000_000) });
    await seedAction(`${W}b#0`, 'TreasuryWithdrawals', 'enacted', { submitted: 628, enacted: 634, decided: 634, expiry: 633, payload: payload(120_000_000) });
    const pack = await buildWindowPack(env.DB, cfg, 628, 630);
    expect(pack.treasury.largestSingle.map((w) => w.id)).toEqual([ids.withdrawal]);
    expect(pack.treasury.totalEnactedAda).toBe(5_000_000);
  });

  it('counts votes cast with superseded votes and final voters once per range', async () => {
    await seedAction(ids.closing, 'NewCommittee', 'active', { submitted: 646, expiry: 653 });
    await env.DB.prepare(`INSERT INTO drep_votes (ga_id, voter_role, voter_id, vote, synced_at, block_time) VALUES (?, 'DRep', 'drepA', 'Yes', 0, ?), (?, 'DRep', 'drepB', 'No', 0, ?)`)
      .bind(ids.closing, t(651), ids.closing, t(650)).run();
    await env.DB.prepare(`INSERT INTO drep_vote_history (ga_id, voter_id, voter_role, vote, block_time, superseded_at) VALUES (?, 'drepA', 'DRep', 'No', ?, 0)`)
      .bind(ids.closing, t(650)).run();
    const pack = await buildWindowPack(env.DB, cfg, 650, 652);
    const e650 = pack.votesByEpoch.find((r) => r.epoch === 650 && r.role === 'DRep');
    const e651 = pack.votesByEpoch.find((r) => r.epoch === 651 && r.role === 'DRep');
    expect(e650).toMatchObject({ votesCast: 2, finalVoters: 1 });
    expect(e651).toMatchObject({ votesCast: 1, finalVoters: 1 });
    expect(pack.voteTimeline[ids.closing].find((r) => r.epoch === 651)?.byCount).toEqual({ yes: 1, no: 0, abstain: 0 });
  });

  it('counts a voter active in several epochs once in the window totals', async () => {
    await seedAction(ids.closing, 'NewCommittee', 'active', { submitted: 646, expiry: 653 });
    await seedAction(ids.open, 'TreasuryWithdrawals', 'active', { submitted: 649, expiry: 656 });
    // drepA's surviving ballots fall in two epochs of the window, drepB voted
    // once, and one superseded ballot adds a vote without a voter.
    await env.DB.prepare(
      `INSERT INTO drep_votes (ga_id, voter_role, voter_id, vote, synced_at, block_time) VALUES
        (?, 'DRep', 'drepA', 'Yes', 0, ?), (?, 'DRep', 'drepA', 'No', 0, ?),
        (?, 'DRep', 'drepB', 'Yes', 0, ?), (?, 'SPO', 'poolA', 'Yes', 0, ?)`,
    ).bind(ids.closing, t(650), ids.open, t(652), ids.closing, t(651), ids.closing, t(651)).run();
    await env.DB.prepare(`INSERT INTO drep_vote_history (ga_id, voter_id, voter_role, vote, block_time, superseded_at) VALUES (?, 'drepA', 'DRep', 'Abstain', ?, 0)`)
      .bind(ids.closing, t(650)).run();
    // A vote before the window must not enter the totals.
    await env.DB.prepare(`INSERT INTO drep_votes (ga_id, voter_role, voter_id, vote, synced_at, block_time) VALUES (?, 'DRep', 'drepEarly', 'Yes', 0, ?)`)
      .bind(ids.closing, t(648)).run();
    const pack = await buildWindowPack(env.DB, cfg, 650, 652);
    expect(pack.windowTotals).toEqual({ votesCast: 5, finalDrepVoters: 2, finalSpoVoters: 1 });
    // The per-epoch rows would count drepA twice, which is exactly what the
    // window totals must not do.
    const drepRows = pack.votesByEpoch.filter((r) => r.role === 'DRep' && r.epoch >= 650);
    expect(drepRows.reduce((a, r) => a + r.finalVoters, 0)).toBe(3);
  });

  it('selects committee members active at epochTo with the inclusive version_to', async () => {
    // A migration seeds the real committee timeline and the per-test reset
    // restores it, so clear it to assert on these three rows alone.
    await env.DB.prepare('DELETE FROM committee_member').run();
    await env.DB.prepare(`INSERT INTO committee_member (cold_key_hex, version_from, version_to, term_expiration, authorized_from, resigned_at) VALUES ('c1', 581, 601, 653, 581, NULL), ('c2', 602, NULL, 653, 602, NULL), ('c3', 602, NULL, 726, 602, 640)`).run();
    const pack = await buildWindowPack(env.DB, cfg, 599, 601);
    expect(pack.committee.members.map((m) => m.coldKeyHex)).toEqual(['c1']);
    const later = await buildWindowPack(env.DB, cfg, 650, 652);
    expect(later.committee.members.map((m) => m.coldKeyHex)).toEqual(['c2']);
    expect(later.committee.endingWithin12).toBe(1);
  });

  it('does not report a later parameter snapshot as the historical committee minimum', async () => {
    await env.DB.prepare(`INSERT INTO protocol_params (id, epoch, committee_min_size, synced_at) VALUES (1, 652, 5, 0)`).run();
    const older = await buildWindowPack(env.DB, cfg, 640, 642);
    expect(older.committee.minSize).toMatchObject({ value: null, observedAtEpoch: null });
    const current = await buildWindowPack(env.DB, cfg, 650, 652);
    expect(current.committee.minSize).toMatchObject({ value: 5, observedAtEpoch: 652 });
  });

  it('marks power history as not covered and yields null power outside coverage', async () => {
    await env.DB.prepare(`INSERT INTO drep_voting_power_history (drep_id, epoch, amount) VALUES ('drepA', 651, '1000000'), ('drepA', 652, '2000000')`).run();
    const pack = await buildWindowPack(env.DB, cfg, 650, 652);
    expect(pack.powerHistory.coverage).toEqual({ from: 651, to: 652 });
    expect(pack.powerHistory.covered).toBe(false);
    // Coverage starts after the epoch a drop would compare from, so there are no
    // drops and no range to name either.
    expect(pack.powerHistory.drops).toBeNull();
    expect(pack.powerHistory.dropsRange).toBeNull();
    const older = await buildWindowPack(env.DB, cfg, 640, 642);
    expect(older.topDreps).toEqual([]);
  });

  it('reports a drep with no row at the window end as the largest power drop', async () => {
    // drepBig deregistered between 649 and 652: no row at 652 at all, not merely
    // a zero one. The largest drop must still name it, with toAda 0.
    await env.DB.prepare(
      `INSERT INTO drep_voting_power_history (drep_id, epoch, amount) VALUES
        ('drepBig', 649, '90000000000000'),
        ('drepSmall', 649, '50000000000'), ('drepSmall', 652, '40000000000')`,
    ).run();
    await env.DB.prepare(`INSERT INTO dreps (drep_id, status, last_synced_at, created_at) VALUES ('drepBig', 'deregistered', 0, 0)`).run();
    const pack = await buildWindowPack(env.DB, cfg, 650, 652);
    expect(pack.powerHistory.drops?.[0]).toMatchObject({ drepId: 'drepBig', toAda: 0, deregistered: true });
    // The drops compare the epoch before the window with its last epoch, and an
    // edition may only name that span from this field, never from the rows.
    expect(pack.powerHistory.dropsRange).toEqual({ from: 649, to: 652 });
  });

  it('excludes votes cast after the window from voteTimeline and spo', async () => {
    await seedAction(ids.closing, 'NewCommittee', 'active', { submitted: 646, expiry: 653 });
    await env.DB.prepare(
      `INSERT INTO drep_votes (ga_id, voter_role, voter_id, vote, synced_at, block_time) VALUES
        (?, 'DRep', 'drepInWindow', 'Yes', 0, ?), (?, 'DRep', 'drepAfter', 'No', 0, ?), (?, 'SPO', 'poolAfter', 'Yes', 0, ?)`,
    ).bind(ids.closing, t(651), ids.closing, t(653), ids.closing, t(653)).run();
    const pack = await buildWindowPack(env.DB, cfg, 650, 652);
    expect(pack.voteTimeline[ids.closing].find((r) => r.epoch === 653)).toBeUndefined();
    expect(pack.voteTimeline[ids.closing].find((r) => r.epoch === 651)?.byCount).toEqual({ yes: 1, no: 0, abstain: 0 });
    expect(pack.spo[ids.closing]).toEqual({ yes: 0, no: 0, abstain: 0 });
  });

  it('reads vote timelines for more voters than one statement can bind', async () => {
    await seedAction(ids.closing, 'NewCommittee', 'active', { submitted: 646, expiry: 653 });
    const stmts = Array.from({ length: 120 }, (_, i) =>
      env.DB.prepare(`INSERT INTO drep_votes (ga_id, voter_role, voter_id, vote, synced_at, block_time) VALUES (?, 'DRep', ?, 'Yes', 0, ?)`).bind(ids.closing, `drep${i}`, t(651, i)),
    );
    for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
    const pack = await buildWindowPack(env.DB, cfg, 650, 652);
    expect(pack.voteTimeline[ids.closing].find((r) => r.epoch === 651)?.byCount.yes).toBe(120);
    expect(pack.votesByEpoch.find((r) => r.epoch === 651 && r.role === 'DRep')?.finalVoters).toBe(120);
  });

  it('limits records on flagged series to the longest complete run', async () => {
    const insert = (epoch: number, rv: number, complete: 0 | 1) => env.DB.prepare(
      `INSERT INTO governance_epoch_stats (epoch, total_drep_power, powered_drep_count, recently_voting_drep_count, gini, top10_share_pct, min_coalition_50, min_coalition_67, votes_cast, vote_data_complete, computed_at)
       VALUES (?, '1', 1, ?, 0, 0, 1, 1, 1, ?, 0)`).bind(epoch, rv, complete).run();
    await insert(645, 250, 1); await insert(646, 300, 0); await insert(647, 320, 1); await insert(648, 310, 1); await insert(649, 300, 1); await insert(650, 290, 1); await insert(651, 286, 1); await insert(652, 283, 1);
    const pack = await buildWindowPack(env.DB, cfg, 650, 652);
    const rec = pack.records.find((r) => r.metric === 'recentlyVotingDrepCount');
    expect(rec).toMatchObject({ rangeFrom: 647, rangeTo: 652, endValue: 283, lastEpochAtOrBelow: null });
  });
});

describe('GET /api/review/window/[range].json', () => {
  it('rejects an invalid or unclosed window before touching D1', async () => {
    const bad = await GET({ params: { range: '650-660' }, request: new Request('https://dreptalk.com/api/review/window/650-660.json'), locals: {} } as never);
    expect(bad.status).toBe(400);
    const future = await GET({ params: { range: '9000-9002' }, request: new Request('https://dreptalk.com/api/review/window/9000-9002.json'), locals: {} } as never);
    expect(future.status).toBe(400);
  });

  it('rejects a window that starts below the first epoch of the stats series', async () => {
    const res = await GET({ params: { range: '2-4' }, request: new Request('https://dreptalk.com/api/review/window/2-4.json'), locals: {} } as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'window must start at epoch 508 or later' });
  });

  it('is mainnet only and answers 404 on another network before touching D1', async () => {
    const holder = env as unknown as Record<string, string | undefined>;
    const before = holder.CARDANO_NETWORK;
    holder.CARDANO_NETWORK = 'preprod';
    try {
      const res = await GET({ params: { range: '650-652' }, request: new Request('https://dreptalk.com/api/review/window/650-652.json'), locals: {} } as never);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'governance review is mainnet only' });
    } finally {
      holder.CARDANO_NETWORK = before;
    }
  });
});
