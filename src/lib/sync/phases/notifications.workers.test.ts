/// <reference types="@cloudflare/workers-types" />
// The notification phases share one invocation budget. A saturated
// fan-out must not leave web push or Telegram without work, each phase must stay
// inside its own allocation, and the run must stay inside NOTIFICATIONS_QUERY_BUDGET.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { resolveNetwork, epochStartMs, epochStartUnix, epochFromUnix } from '../../config/network.js';
import { countingDb } from '../queryBudget.js';
import {
  notificationPhases, NOTIFICATIONS_QUERY_BUDGET, FANOUT_QUERY_SHARE, DIGEST_QUERY_SHARE, type NotificationsSyncContext,
} from './notifications.js';
import { runPhases } from './registry.js';
import { buildJobInsert, listOpenJobs } from '../../db/fanoutJobs.js';
import { addChannel } from '../../db/notificationChannels.js';
import { setChannelCursor } from '../../db/__tests__/notificationSeed.js';

describe('notification phases under load', () => {
  it('each phase stays in its allocation and both dispatchers still send', async () => {
    // 60 followers: one page per job costs 7 queries (select, 5 insert chunks, step).
    // 80 open jobs need about 570 queries, far above the fan-out share of 300.
    for (let i = 0; i < 60; i++) {
      await env.DB.prepare(
        `INSERT INTO delegator_follows (user_id, stake_addr, resolution_status, delegation_type, drep_id, checked_at, delegation_set_at, refresh_attempted_at, refresh_error_at)
         VALUES (?, ?, 'resolved', 'drep', 'drepL', 1, 1, 1, NULL)`,
      ).bind(`f${i}`, `stake_f${i}`).run();
      await env.DB.prepare('INSERT INTO users (id, created_at, last_verified_at) VALUES (?, 0, 0)').bind(`f${i}`).run();
    }
    for (let j = 0; j < 80; j++) {
      await buildJobInsert(env.DB, {
        eventKey: `load:${j}`, eventType: 'delegator_drep_voted', subjectId: 'drepL',
        sourceTime: 10, payload: JSON.stringify({ gaId: `ga${j}`, vote: 'Yes', sourceTime: 10 }), createdAt: 10 + j,
      }).run();
    }
    for (let i = 0; i < 20; i++) {
      const w = await addChannel(env.DB, { userId: `f${i}`, channel: 'webpush', target: JSON.stringify({ endpoint: `https://push.example/l${i}`, keys: { p256dh: 'p', auth: 'a' } }), endpoint: `https://push.example/l${i}` });
      await setChannelCursor(env.DB, w, 0);
      const t = await addChannel(env.DB, { userId: `f${i}`, channel: 'telegram', target: `chat${i}`, endpoint: `telegram:chat${i}` });
      await setChannelCursor(env.DB, t, 0);
    }
    // The digest does real work in the same run: the votes cron finished inside the
    // current epoch and drepL cast a vote in the completed one.
    const cfg = { ...resolveNetwork('preprod'), siteOrigin: 'https://dreptalk.com' };
    const current = epochFromUnix(Math.floor(Date.now() / 1000), cfg);
    await env.DB.prepare(`INSERT INTO sync_runs (kind, started_at, finished_at, status, phases) VALUES ('votes', ?, ?, 'ok', ?)`)
      .bind(epochStartMs(current, cfg) + 1, epochStartMs(current, cfg) + 2,
            JSON.stringify([{ phase: 'votes', ok: true, ms: 1, items: 1, failed: 0 }])).run();
    await env.DB.prepare('INSERT INTO dreps (drep_id, status, last_synced_at, created_at) VALUES (?, ?, 0, 0)').bind('drepL', 'registered').run();
    await env.DB.prepare(`INSERT INTO governance_actions (id, type, status, title, created_at, last_synced_at) VALUES ('gaL', 'InfoAction', 'closed', 'L', 0, 0)`).run();
    await env.DB.prepare(`INSERT INTO drep_votes (ga_id, voter_role, voter_id, vote, synced_at, block_time) VALUES ('gaL', 'DRep', 'drepL', 'Yes', 0, ?)`)
      .bind(epochStartUnix(current - 1, cfg) + 10).run();
    const sent = { webpush: 0, telegram: 0 };
    const counted = countingDb(env.DB);
    const ctx: NotificationsSyncContext = {
      db: counted.db, meter: counted.meter, now: Date.now(),
      koios: {} as NotificationsSyncContext['koios'],
      cfg,
      vapid: { publicKey: 'pub', privateKey: 'priv', subject: 'https://dreptalk.com' },
      telegramBotToken: 'TOKEN',
      senders: {
        webpush: async () => { sent.webpush++; return { ok: true, status: 201 }; },
        telegram: async () => { sent.telegram++; return { ok: true, status: 200, description: '' }; },
      },
    };
    const spent: Record<string, number> = {};
    const budgetBefore: Record<string, number> = {};
    await runPhases(notificationPhases, ctx, async (name, fn) => {
      budgetBefore[name] = NOTIFICATIONS_QUERY_BUDGET - counted.meter.used();
      const before = counted.meter.used();
      await fn();
      spent[name] = counted.meter.used() - before;
    });
    expect(counted.meter.used()).toBeLessThanOrEqual(NOTIFICATIONS_QUERY_BUDGET);
    expect(spent['delegation-fanout']).toBeLessThanOrEqual(FANOUT_QUERY_SHARE);
    expect(spent['delegation-digest']).toBeLessThanOrEqual(DIGEST_QUERY_SHARE);
    expect(spent.webpush).toBeLessThanOrEqual(Math.floor(budgetBefore.webpush / 2));
    expect(spent.telegram).toBeLessThanOrEqual(budgetBefore.telegram);
    expect((await listOpenJobs(env.DB, 1000)).length).toBeGreaterThan(0); // the fan-out was cut off
    expect(sent.webpush).toBeGreaterThan(0);
    expect(sent.telegram).toBeGreaterThan(0);
    const digests = await env.DB.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE type = 'delegation_digest'`).first<{ n: number }>();
    expect(digests!.n).toBe(60); // every seeded follower of drepL
  });
});
