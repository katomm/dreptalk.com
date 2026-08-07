import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { getActionCcVoteRows } from './committee.js';
import { getActionRationaleStatuses, countActionRationales } from './actionRationale.js';

const db = () => env.DB;

describe('CC positions queries', () => {
  it('returns CC vote rows and rationale statuses, and excludes CC from the DRep/SPO rationale count', async () => {
    await db().prepare(`INSERT INTO governance_actions (id, type, anchor_status, status, created_at, last_synced_at) VALUES ('ga1','InfoAction','ok','open',0,0)`).run();
    await db().prepare(
      `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, meta_url, block_time, synced_at)
       VALUES ('ga1','ConstitutionalCommittee','cc1','HOT1','Yes','https://a',10,0),
              ('ga1','ConstitutionalCommittee','cc2','hot2','No',NULL,20,0),
              ('ga1','DRep','drep1',NULL,'Yes',NULL,5,0)`,
    ).run();
    await db().prepare(
      `INSERT INTO action_rationale (ga_id, voter_id, body_html, body_text, source, anchor_url, status, attempts, created_at, fetched_at)
       VALUES ('ga1','cc1','<p>hi</p>','hi','onchain','https://a','ok',1,0,0),
              ('ga1','drep1','<p>d</p>','d','onchain',NULL,'ok',1,0,0)`,
    ).run();

    expect(await getActionCcVoteRows(db(), 'ga1')).toEqual([
      { voterId: 'cc1', hotKeyHex: 'hot1', vote: 'Yes', blockTime: 10, metaUrl: 'https://a' },
      { voterId: 'cc2', hotKeyHex: 'hot2', vote: 'No', blockTime: 20, metaUrl: null },
    ]);
    const statuses = await getActionRationaleStatuses(db(), 'ga1');
    expect(statuses.get('cc1')).toEqual({ bodyHtml: '<p>hi</p>', status: 'ok' });
    // Sidebar count excludes the CC rationale, counts only the DRep one.
    expect(await countActionRationales(db(), 'ga1')).toBe(1);
  });
});
