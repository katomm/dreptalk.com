import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { listDecidedOutcomeRows, countSubmittedSince, countActionsByStatus } from './hubOutcomes.js';

interface SeedOpts {
  title?: string | null;
  topicId?: string | null;
  status?: string;
  submittedEpoch?: number | null;
  decidedEpoch?: number | null;
  thresholdsJson?: string | null;
  drepYesPct?: number | null;
  spoYesPct?: number | null;
  spoYesPower?: number | null;
  spoNoPower?: number | null;
  spoAbstainPower?: number | null;
  spoAlwaysAbstainPower?: string | null;
  spoAlwaysNoConfidencePower?: string | null;
  spoNoSidePower?: string | null;
}

async function seedAction(id: string, type: string, opts: SeedOpts = {}) {
  await env.DB.prepare(
    `INSERT INTO governance_actions
       (id, type, title, topic_id, status, submitted_epoch, decided_epoch, thresholds_json,
        drep_yes_pct, spo_yes_pct, spo_yes_power, spo_no_power, spo_abstain_power,
        spo_always_abstain_power, spo_always_no_confidence_power, spo_no_side_power, created_at, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
  )
    .bind(
      id,
      type,
      opts.title ?? null,
      opts.topicId ?? null,
      opts.status ?? 'enacted',
      opts.submittedEpoch ?? null,
      opts.decidedEpoch ?? null,
      opts.thresholdsJson ?? null,
      opts.drepYesPct ?? null,
      opts.spoYesPct ?? null,
      opts.spoYesPower ?? null,
      opts.spoNoPower ?? null,
      opts.spoAbstainPower ?? null,
      opts.spoAlwaysAbstainPower ?? null,
      opts.spoAlwaysNoConfidencePower ?? null,
      opts.spoNoSidePower ?? null,
    )
    .run();
}

async function seedTopic(id: string, slug: string) {
  await env.DB.prepare(
    `INSERT INTO topics (id, category_slug, author_id, title, slug, last_post_at, created_at)
     VALUES (?, 'general', 'author1', 't', ?, 0, 0)`,
  )
    .bind(id, slug)
    .run();
}

describe('listDecidedOutcomeRows', () => {
  it('returns only actions with a non-null decided_epoch', async () => {
    await seedAction('ga_decided', 'InfoAction', { decidedEpoch: 600 });
    await seedAction('ga_open', 'InfoAction', { decidedEpoch: null, status: 'active' });

    const rows = await listDecidedOutcomeRows(env.DB);

    expect(rows.map((r) => r.gaId)).toEqual(['ga_decided']);
  });

  it('excludes a dropped action even when it carries a decided_epoch', async () => {
    await seedAction('ga_dropped', 'InfoAction', { status: 'dropped', decidedEpoch: 600 });
    await seedAction('ga_expired', 'InfoAction', { status: 'expired', decidedEpoch: 600 });

    const rows = await listDecidedOutcomeRows(env.DB);

    expect(rows.map((r) => r.gaId)).toEqual(['ga_expired']);
  });

  it('maps every field, including all SPO columns when set and when null', async () => {
    await seedTopic('t1', 'my-action-slug');
    await seedAction('ga_full', 'ParameterChange', {
      title: 'Full action',
      topicId: 't1',
      status: 'enacted',
      submittedEpoch: 590,
      decidedEpoch: 600,
      thresholdsJson: '{"drep":67,"spo":null,"cc":60}',
      drepYesPct: 72.5,
      spoYesPct: 55.1,
      spoYesPower: 1000,
      spoNoPower: 200,
      spoAbstainPower: 50,
      spoAlwaysAbstainPower: '9007199254740993',
      spoAlwaysNoConfidencePower: '12',
      spoNoSidePower: '250',
    });
    await seedAction('ga_nulls', 'InfoAction', {
      title: null,
      topicId: null,
      status: 'expired',
      submittedEpoch: null,
      decidedEpoch: 601,
      thresholdsJson: null,
      drepYesPct: null,
      spoYesPct: null,
      spoYesPower: null,
      spoNoPower: null,
      spoAbstainPower: null,
      spoAlwaysAbstainPower: null,
      spoAlwaysNoConfidencePower: null,
      spoNoSidePower: null,
    });

    const rows = await listDecidedOutcomeRows(env.DB);
    const full = rows.find((r) => r.gaId === 'ga_full');
    const nulls = rows.find((r) => r.gaId === 'ga_nulls');

    expect(full).toEqual({
      gaId: 'ga_full',
      title: 'Full action',
      topicSlug: 'my-action-slug',
      type: 'ParameterChange',
      status: 'enacted',
      submittedEpoch: 590,
      decidedEpoch: 600,
      thresholdsJson: '{"drep":67,"spo":null,"cc":60}',
      drepYesPct: 72.5,
      spoYesPct: 55.1,
      spoYesPower: 1000,
      spoNoPower: 200,
      spoAbstainPower: 50,
      spoAlwaysAbstainPower: '9007199254740993',
      spoAlwaysNoConfidencePower: '12',
      spoNoSidePower: '250',
    });
    expect(nulls).toEqual({
      gaId: 'ga_nulls',
      title: null,
      topicSlug: null,
      type: 'InfoAction',
      status: 'expired',
      submittedEpoch: null,
      decidedEpoch: 601,
      thresholdsJson: null,
      drepYesPct: null,
      spoYesPct: null,
      spoYesPower: null,
      spoNoPower: null,
      spoAbstainPower: null,
      spoAlwaysAbstainPower: null,
      spoAlwaysNoConfidencePower: null,
      spoNoSidePower: null,
    });
  });
});

describe('countSubmittedSince', () => {
  it('counts actions submitted at or after the given epoch, of any status', async () => {
    await seedAction('ga_below', 'InfoAction', { submittedEpoch: 599, status: 'active' });
    await seedAction('ga_equal', 'InfoAction', { submittedEpoch: 600, status: 'enacted' });
    await seedAction('ga_above', 'InfoAction', { submittedEpoch: 610, status: 'expired' });

    const count = await countSubmittedSince(env.DB, 600);

    expect(count).toBe(2);
  });
});

describe('countActionsByStatus', () => {
  it('groups all actions by status, omitting statuses with no rows', async () => {
    await seedAction('ga_s1', 'InfoAction', { status: 'active' });
    await seedAction('ga_s2', 'InfoAction', { status: 'active' });
    await seedAction('ga_s3', 'InfoAction', { status: 'enacted' });

    const counts = await countActionsByStatus(env.DB);

    expect(counts).toEqual({ active: 2, enacted: 1 });
    expect(counts.dropped).toBeUndefined();
  });
});
