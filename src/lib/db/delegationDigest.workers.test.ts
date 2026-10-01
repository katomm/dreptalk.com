// src/lib/db/delegationDigest.workers.test.ts
/// <reference types="@cloudflare/workers-types" />
// Delegator epoch digest, run in real workerd via vitest-pool-workers.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { resolveNetwork, epochStartUnix, epochStartMs } from '../config/network.js';
import { allowance, countingDb } from '../sync/queryBudget.js';
import {
  digestReady,
  listFollowedDreps,
  buildDrepSummaries,
  sendDigests,
  runDelegationDigest,
} from './delegationDigest.js';
import { parseDelegationDigestPayload } from '../notifications/delegationDigest.js';

const db = () => env.DB as D1Database;
const cfg = resolveNetwork('preprod');
const EPOCH = 300; // the completed epoch under test
const inEpoch = (offsetSec: number) => epochStartUnix(EPOCH, cfg) + offsetSec;
const nowInNext = epochStartUnix(EPOCH + 1, cfg) + 3600;
const roomy = () => allowance(countingDb(db()).meter, 400);

let seq = 0;
async function seedFollower(drepId: string, opts: { status?: string } = {}) {
  const id = `dg_user_${String(++seq).padStart(4, '0')}`;
  await db().prepare('INSERT INTO users (id, status, created_at, last_verified_at) VALUES (?, ?, 0, 0)')
    .bind(id, opts.status ?? 'active').run();
  await db().prepare(
    `INSERT INTO delegator_follows (user_id, stake_addr, resolution_status, delegation_type, drep_id, checked_at, delegation_set_at, refresh_attempted_at)
     VALUES (?, ?, 'resolved', 'drep', ?, 1, 1, 1)`,
  ).bind(id, `stake_${id}`, drepId).run();
  return id;
}
async function seedDrep(drepId: string, status = 'registered') {
  await db().prepare('INSERT INTO dreps (drep_id, status, last_synced_at, created_at) VALUES (?, ?, 0, 0)')
    .bind(drepId, status).run();
}
async function seedAction(id: string, status: string, title: string) {
  await db().prepare(
    `INSERT INTO governance_actions (id, type, status, title, created_at, last_synced_at) VALUES (?, 'InfoAction', ?, ?, 0, 0)`,
  ).bind(id, status, title).run();
}
async function seedVote(
  drepId: string, gaId: string, blockTime: number | null,
  opts: { meta?: string | null; localStatus?: string | null } = {},
) {
  await db().prepare(
    `INSERT INTO drep_votes (ga_id, voter_role, voter_id, vote, synced_at, block_time, meta_url, local_status)
     VALUES (?, 'DRep', ?, 'Yes', 0, ?, ?, ?)`,
  ).bind(gaId, drepId, blockTime, opts.meta ?? null, opts.localStatus ?? null).run();
}
async function seedHistory(drepId: string, gaId: string, blockTime: number, meta: string | null = null) {
  await db().prepare(
    `INSERT INTO drep_vote_history (ga_id, voter_id, voter_role, vote, meta_url, block_time, superseded_at)
     VALUES (?, ?, 'DRep', 'No', ?, ?, 0)`,
  ).bind(gaId, drepId, meta, blockTime).run();
}
async function markVoteRun(startedAtMs: number, votesPhase: { ok: boolean; failed: number } | null = { ok: true, failed: 0 }, finished = true) {
  const phases = votesPhase ? JSON.stringify([{ phase: 'votes', ok: votesPhase.ok, ms: 1, items: 1, failed: votesPhase.failed }]) : null;
  await db().prepare(`INSERT INTO sync_runs (kind, started_at, finished_at, status, phases) VALUES ('votes', ?, ?, ?, ?)`)
    .bind(startedAtMs, finished ? startedAtMs + 1000 : null, finished ? 'partial' : 'running', phases).run();
}
async function digestsFor(userId: string) {
  return (await db().prepare(`SELECT event_key, payload FROM notifications WHERE recipient_id = ? AND type = 'delegation_digest'`)
    .bind(userId).all<{ event_key: string; payload: string }>()).results;
}
async function summaryOf(drepId: string) {
  const row = await db().prepare('SELECT payload, reportable FROM delegation_digest_dreps WHERE epoch = ? AND drep_id = ?')
    .bind(EPOCH, drepId).first<{ payload: string; reportable: number }>();
  return row ? { ...parseDelegationDigestPayload(row.payload)!, reportable: row.reportable } : null;
}

describe('delegation digest', () => {
it('is ready only after a clean vote phase inside the current epoch', async () => {
  const current = EPOCH + 1;
  await markVoteRun(epochStartMs(EPOCH, cfg) + 1000); // clean, but in the reported epoch
  expect(await digestReady(db(), current, cfg)).toBe(false);
  await markVoteRun(epochStartMs(current, cfg) + 1000, { ok: true, failed: 2 }); // failed actions
  await markVoteRun(epochStartMs(current, cfg) + 2000, { ok: false, failed: 0 }); // phase threw
  await markVoteRun(epochStartMs(current, cfg) + 3000, { ok: true, failed: 0 }, false); // still running
  await markVoteRun(epochStartMs(current, cfg) + 4000, null); // no phase record
  expect(await digestReady(db(), current, cfg)).toBe(false);
  await markVoteRun(epochStartMs(current, cfg) + 5000); // clean, status partial from another phase
  expect(await digestReady(db(), current, cfg)).toBe(true);
});

it('counts confirmed and superseded votes inside the epoch once per action', async () => {
  await seedDrep('drepA');
  await seedFollower('drepA');
  await seedAction('ga1', 'closed', 'First');
  await seedAction('ga2', 'active', 'Second');
  await seedAction('ga3', 'active', 'Next epoch');
  await seedAction('ga4', 'active', 'Previous epoch');
  await seedAction('ga5', 'active', 'Untimed');
  await seedAction('ga6', 'pending', 'Pending local');
  await seedAction('ga7', 'active', 'Re-voted');
  await seedVote('drepA', 'ga1', inEpoch(100), { meta: 'https://r/1' });
  await seedVote('drepA', 'ga2', inEpoch(200));
  await seedVote('drepA', 'ga3', epochStartUnix(EPOCH + 1, cfg)); // next epoch, excluded
  await seedVote('drepA', 'ga4', inEpoch(-10)); // previous epoch, excluded
  await seedVote('drepA', 'ga5', null); // no block time, excluded
  await seedVote('drepA', 'ga6', inEpoch(250), { localStatus: 'pending' }); // unconfirmed, excluded
  // Voted in the epoch with a rationale, changed in the next epoch before the build.
  await seedHistory('drepA', 'ga7', inEpoch(300), 'https://r/7');
  await seedVote('drepA', 'ga7', epochStartUnix(EPOCH + 1, cfg) + 60);
  const r = await buildDrepSummaries(db(), EPOCH, cfg, await listFollowedDreps(db()));
  expect(r).toEqual({ dreps: 1, reportable: 1 });
  const p = await summaryOf('drepA');
  expect(p!.votes).toBe(3); // ga1, ga2, ga7
  expect(p!.withRationale).toBe(2); // ga1, ga7
  expect(p!.titles).toEqual(['Re-voted', 'Second', 'First']);
  // Open: ga2..ga7 = 6. Confirmed current votes on open actions: ga2, ga3, ga4, ga5, ga7 = 5.
  // The pending local vote on ga6 does not count as voted.
  expect(p!.openUnvoted).toBe(1);
});

it('never reports open actions for a DRep that is not registered', async () => {
  await seedDrep('drepGone', 'deregistered');
  await seedFollower('drepGone');
  await seedAction('gaOpen', 'active', 'Open');
  await buildDrepSummaries(db(), EPOCH, cfg, await listFollowedDreps(db()));
  const p = await summaryOf('drepGone');
  expect(p!.reportable).toBe(0);
  expect(p!.openUnvoted).toBeNull();
});

it('marks an epoch without anything to report as done at build time', async () => {
  await seedDrep('drepQuiet');
  await seedFollower('drepQuiet');
  await markVoteRun(epochStartMs(EPOCH + 1, cfg) + 1000);
  const first = await runDelegationDigest(db(), cfg, nowInNext, { budget: roomy(), recipients: 10 });
  expect(first.state).toBe('done');
  const counted = countingDb(db());
  const again = await runDelegationDigest(counted.db, cfg, nowInNext, { budget: allowance(counted.meter, 400), recipients: 10 });
  expect(again.state).toBe('done');
  expect(counted.meter.used()).toBe(1); // steady state: one query per run
});

it('pages through followers, skips silent DReps and marks the epoch done at the end', async () => {
  await seedDrep('drepQuiet2');
  await seedDrep('drepBusy');
  const quiet = [await seedFollower('drepQuiet2'), await seedFollower('drepQuiet2')];
  const busy: string[] = [];
  for (let i = 0; i < 5; i++) busy.push(await seedFollower('drepBusy'));
  await seedAction('gaB', 'closed', 'Busy vote');
  await seedVote('drepBusy', 'gaB', inEpoch(50));
  await markVoteRun(epochStartMs(EPOCH + 1, cfg) + 1000);
  const states: string[] = [];
  let total = 0;
  for (let run = 0; run < 4; run++) {
    const r = await runDelegationDigest(db(), cfg, nowInNext, { budget: roomy(), recipients: 2 });
    states.push(r.state);
    total += r.inserted;
  }
  expect(total).toBe(5);
  expect(states).toEqual(['sending', 'sending', 'done', 'done']);
  for (const u of busy) {
    const rows = await digestsFor(u);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_key).toBe(`delegation_digest:${u}:${EPOCH}`);
  }
  for (const q of quiet) expect(await digestsFor(q)).toHaveLength(0);
});

it('survives two runs at once without duplicates', async () => {
  await seedDrep('drepC');
  const users = [await seedFollower('drepC'), await seedFollower('drepC'), await seedFollower('drepC')];
  await seedAction('gaC', 'closed', 'C');
  await seedVote('drepC', 'gaC', inEpoch(10));
  await markVoteRun(epochStartMs(EPOCH + 1, cfg) + 1000);
  await Promise.all([
    runDelegationDigest(db(), cfg, nowInNext, { budget: roomy(), recipients: 10 }),
    runDelegationDigest(db(), cfg, nowInNext, { budget: roomy(), recipients: 10 }),
  ]);
  await runDelegationDigest(db(), cfg, nowInNext, { budget: roomy(), recipients: 10 });
  for (const u of users) expect(await digestsFor(u)).toHaveLength(1);
  const n = await db().prepare('SELECT COUNT(*) AS n FROM delegation_digest_dreps WHERE epoch = ?').bind(EPOCH).first<{ n: number }>();
  expect(n!.n).toBe(1);
});

it('skips accounts that are not active', async () => {
  await seedDrep('drepE');
  const u = await seedFollower('drepE', { status: 'disabled' });
  await seedAction('gaE', 'closed', 'E');
  await seedVote('drepE', 'gaE', inEpoch(10));
  await buildDrepSummaries(db(), EPOCH, cfg, await listFollowedDreps(db()));
  expect(await sendDigests(db(), EPOCH, 10)).toBe(0);
  expect(await digestsFor(u)).toHaveLength(0);
});

it('defers a build that does not fit the allowance and stays inside it', async () => {
  for (let i = 0; i < 5; i++) { await seedDrep(`drepF${i}`); await seedFollower(`drepF${i}`); }
  await markVoteRun(epochStartMs(EPOCH + 1, cfg) + 1000);
  const counted = countingDb(db());
  const tight = await runDelegationDigest(counted.db, cfg, nowInNext, { budget: allowance(counted.meter, 4), recipients: 10 });
  expect(tight.state).toBe('deferred');
  expect(counted.meter.used()).toBeLessThanOrEqual(4);
  const before = counted.meter.used();
  const ok = await runDelegationDigest(counted.db, cfg, nowInNext, { budget: allowance(counted.meter, 400), recipients: 10 });
  expect(['built', 'sending', 'done']).toContain(ok.state);
  expect(counted.meter.used() - before).toBeLessThanOrEqual(400);
});

it('waits while no clean vote run finished in the new epoch', async () => {
  await seedDrep('drepW');
  await seedFollower('drepW');
  const r = await runDelegationDigest(db(), cfg, nowInNext, { budget: roomy(), recipients: 10 });
  expect(r).toEqual({ epoch: EPOCH, state: 'waiting', inserted: 0 });
});
});
