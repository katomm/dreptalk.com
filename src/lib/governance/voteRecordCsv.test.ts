import { describe, it, expect } from 'vitest';
import { buildVoteRecordCsv } from './voteRecordCsv.js';
import type { DrepVoteHistoryRow } from '@/lib/db/drepVotes.js';

const OPTS = { origin: 'https://dreptalk.com', voteShareBase: '/dreps/drep1abc/vote/' };

function row(overrides: Partial<DrepVoteHistoryRow> = {}): DrepVoteHistoryRow {
  return {
    ga_id: `${'a'.repeat(64)}#0`,
    vote: 'yes',
    title: 'Test action',
    type: 'TreasuryWithdrawals',
    status: 'enacted',
    decided_epoch: 657,
    submitted_epoch: 650,
    topic_slug: 'test-action',
    meta_url: null,
    block_time: 1_752_000_000,
    rationale_html: null,
    ...overrides,
  };
}

describe('buildVoteRecordCsv', () => {
  it('starts with the header row', () => {
    const csv = buildVoteRecordCsv([], OPTS);
    expect(csv).toBe('Epoch,Date,Type,Vote,Title,Rationale URL');
  });

  it('emits one CRLF-joined line per vote with a readable type and ISO date', () => {
    const csv = buildVoteRecordCsv([row()], OPTS);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('657,2025-07-08,Treasury Withdrawals,yes,Test action,');
  });

  it('links a stored rationale to its absolute on-site vote page', () => {
    const csv = buildVoteRecordCsv([row({ rationale_html: '<p>why</p>' })], OPTS);
    expect(csv).toContain('https://dreptalk.com/dreps/drep1abc/vote/test-action/');
  });

  it('falls back to the raw anchor url when no on-site page exists', () => {
    const csv = buildVoteRecordCsv(
      [row({ rationale_html: null, meta_url: 'https://example.com/anchor.json' })],
      OPTS,
    );
    expect(csv).toContain('https://example.com/anchor.json');
  });

  it('leaves epoch and date empty when unknown', () => {
    const csv = buildVoteRecordCsv([row({ decided_epoch: null, block_time: null })], OPTS);
    expect(csv.split('\r\n')[1]).toBe(',,Treasury Withdrawals,yes,Test action,');
  });

  it('quotes a title containing a comma', () => {
    const csv = buildVoteRecordCsv([row({ title: 'Bifrost, phase 1' })], OPTS);
    expect(csv).toContain('"Bifrost, phase 1"');
  });

  it('falls back to a shortened action id when the title is missing', () => {
    const csv = buildVoteRecordCsv([row({ title: null })], OPTS);
    // shortGovActionId renders a truncated id, never empty.
    const titleCol = csv.split('\r\n')[1].split(',')[4];
    expect(titleCol.length).toBeGreaterThan(0);
    expect(titleCol).not.toBe('Test action');
  });
});
