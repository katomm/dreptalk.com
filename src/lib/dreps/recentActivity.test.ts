import { describe, it, expect } from 'vitest';
import { buildRecentActivity } from './recentActivity.js';
import { resolveNetwork } from '../config/network.js';
import type { DrepVoteHistoryRow } from '../db/drepVotes.js';
import type { AuthorPost } from '../db/forum.js';

const cfg = resolveNetwork('preprod'); // epoch 4 starts 1655769600, 5-day epochs
const at = (epoch: number) => 1655769600 + (epoch - 4) * 5 * 24 * 60 * 60;

function voteRow(over: Partial<DrepVoteHistoryRow>): DrepVoteHistoryRow {
  return {
    ga_id: 'ga#0', vote: 'Yes', title: 'Some Action', type: 'InfoAction', status: 'enacted',
    decided_epoch: 500, submitted_epoch: 493, topic_slug: 'some-action', meta_url: null,
    block_time: at(500), rationale_html: null,
    ...over,
  };
}

function post(over: Partial<AuthorPost>): AuthorPost {
  return {
    id: 'p1', topic_id: 't1', topic_title: 'A Discussion', topic_slug: 'a-discussion',
    is_topic_start: 0, body_html: '<p>Hello there, this is a post body.</p>', created_at: at(501) * 1000,
    ...over,
  };
}

describe('buildRecentActivity', () => {
  it('merges votes, rationales, and posts newest-first', () => {
    const events = buildRecentActivity({
      votes: [voteRow({ block_time: at(500) })],
      posts: [post({ created_at: at(501) * 1000 })],
      voterId: 'drep1lucas',
      cfg,
    });
    expect(events.map((e) => e.kind)).toEqual(['discussion', 'vote']);
    expect(events[1]).toMatchObject({ kind: 'vote', vote: 'Yes', epoch: 500, href: '/t/some-action/' });
  });

  it('a vote with a rationale yields two events, vote first at the same timestamp', () => {
    const events = buildRecentActivity({
      votes: [voteRow({ rationale_html: '<p>Because reasons.</p>' })],
      posts: [],
      voterId: 'drep1lucas',
      cfg,
    });
    expect(events.map((e) => e.kind)).toEqual(['vote', 'rationale']);
    expect(events[0].ts).toBe(events[1].ts);
    expect(events[1]).toMatchObject({ href: '/t/some-action/?tab=positions#voter-drep1lucas' });
  });

  it('marks topic starts vs comments and builds post anchors', () => {
    const events = buildRecentActivity({
      votes: [],
      posts: [
        post({ id: 'p9', is_topic_start: 1, created_at: 5_000 }),
        post({ id: 'p10', is_topic_start: 0, created_at: 6_000 }),
      ],
      voterId: 'drep1lucas',
      cfg,
    });
    expect(events[0]).toMatchObject({ kind: 'discussion', started: false, href: '/t/a-discussion/#post-p10' });
    expect(events[1]).toMatchObject({ kind: 'discussion', started: true, href: '/t/a-discussion/#post-p9' });
  });

  it('keeps each vote+rationale pair adjacent when a multi-vote tx shares one block_time', () => {
    const t = at(500);
    const events = buildRecentActivity({
      votes: [
        voteRow({ ga_id: 'ga#a', title: 'Action A', topic_slug: 'action-a', block_time: t, rationale_html: '<p>a</p>' }),
        voteRow({ ga_id: 'ga#b', title: 'Action B', topic_slug: 'action-b', block_time: t, rationale_html: '<p>b</p>' }),
      ],
      posts: [],
      voterId: 'drep1lucas',
      cfg,
    });
    expect(events.map((e) => `${e.kind}:${e.key}`)).toEqual([
      'vote:ga#a', 'rationale:ga#a', 'vote:ga#b', 'rationale:ga#b',
    ]);
  });

  it('drops votes without a timestamp, applies the limit, and handles empty input', () => {
    const votes = [
      voteRow({ ga_id: 'ga#1', block_time: null }),
      voteRow({ ga_id: 'ga#2', block_time: at(490) }),
      voteRow({ ga_id: 'ga#3', block_time: at(491) }),
      voteRow({ ga_id: 'ga#4', block_time: at(492) }),
    ];
    const events = buildRecentActivity({ votes, posts: [], voterId: 'drep1x', cfg }, 2);
    expect(events).toHaveLength(2);
    expect(events.map((e) => (e.kind === 'vote' ? e.epoch : null))).toEqual([492, 491]);

    expect(buildRecentActivity({ votes: [], posts: [], voterId: 'drep1x', cfg })).toEqual([]);
  });
});
