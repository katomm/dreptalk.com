import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getVotableActionsForViewer } from './votableActions.js';

async function seedAction(
  id: string,
  opts: { status?: string; expiryEpoch?: number | null; submittedEpoch?: number | null; submittedAt?: number | null },
) {
  await env.DB.prepare(
    `INSERT INTO governance_actions
       (id, type, title, status, expiry_epoch, submitted_epoch, submitted_at, topic_id, created_at, last_synced_at)
     VALUES (?, 'InfoAction', ?, ?, ?, ?, ?, NULL, 0, 0)`,
  )
    .bind(id, id, opts.status ?? 'active', opts.expiryEpoch ?? null, opts.submittedEpoch ?? null, opts.submittedAt ?? null)
    .run();
}

describe('getVotableActionsForViewer', () => {
  it('returns active actions only, soonest expiry first, with submitted fields', async () => {
    await seedAction('v-late', { expiryEpoch: 410, submittedEpoch: 400, submittedAt: 2000 });
    await seedAction('v-soon', { expiryEpoch: 405, submittedEpoch: 401, submittedAt: 3000 });
    await seedAction('v-done', { status: 'enacted', expiryEpoch: 400, submittedEpoch: 399, submittedAt: 1000 });

    const rows = await getVotableActionsForViewer(env.DB, 'drepNobody');

    expect(rows.map((r) => r.id)).toEqual(['v-soon', 'v-late']);
    expect(rows[0]).toMatchObject({ submitted_epoch: 401, submitted_at: 3000 });
    expect(rows[1]).toMatchObject({ submitted_epoch: 400, submitted_at: 2000 });
  });
});
