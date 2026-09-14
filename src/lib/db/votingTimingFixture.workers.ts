// Shared seed for the voting-timing tests. Deliberately not a *.test.ts file:
// it is imported by several workers tests and contains no assertions.
//
// submitted_at is unix milliseconds, drep_votes.block_time is unix seconds.
// The voting window runs from submission to the window-end epoch, so the
// submission time is derived from the epoch grid rather than picked at random:
// an arbitrary timestamp far from the decided epoch makes the window so long
// that every vote falls in the first third, which would leave the middle, late
// and afterClose buckets untested.
import { env } from 'cloudflare:test';
import { epochStartUnix, type NetworkConfig } from '../config/network.js';
import { upsertVotes } from './drepVotes.js';

const DAY = 86_400;

/** The DRep whose own record view the equality test renders. */
export const FOCUS_DREP = 'drep_focus';

/** Action type the focus DRep votes on often enough for buildTimingDetail. */
export const FOCUS_TYPE = 'InfoAction';

async function seedAction(id: string, type: string, submittedSec: number, decidedEpoch: number) {
  await env.DB.prepare(
    `INSERT INTO governance_actions (id, type, title, status, decided_epoch, expiry_epoch, submitted_at, topic_id, created_at, last_synced_at)
     VALUES (?, ?, ?, 'enacted', ?, ?, ?, NULL, 0, 0)`,
  ).bind(id, type, id, decidedEpoch, decidedEpoch, submittedSec * 1000).run();
}

/**
 * Four InfoAction actions and two thin TreasuryWithdrawals actions, all decided.
 *
 * Shape the tests rely on, asserted by guards in the tests themselves rather
 * than trusted from this comment:
 * - InfoAction clears MIN_TYPE_TIMED_VOTES (20) for DRep and for SPO, so byType
 *   is non-empty and its SPO column is not null.
 * - TreasuryWithdrawals stays under the floor, so "stored but filtered in the
 *   view" is observable.
 * - FOCUS_DREP votes on all four InfoAction actions, above the three own votes
 *   buildTimingDetail needs before it emits a type comparison row. Without that
 *   the record equality test would compare two empty lists.
 * - Votes are spread across early, middle, late and past the window end.
 * - The number of actions with at least two timed DRep votes is even, so the
 *   even-length median branch is exercised.
 */
export async function seedVotingTimingFixture(cfg: NetworkConfig): Promise<void> {
  const decidedEpoch = 500;
  // An enacted action's window ends one epoch before decided_epoch, capped by
  // expiry_epoch, which seedAction sets equal to decided_epoch.
  const windowEndSec = epochStartUnix(decidedEpoch - 1, cfg);
  const submitted = epochStartUnix(decidedEpoch - 5, cfg);
  const windowDays = (windowEndSec - submitted) / DAY;

  /** A vote time at the given fraction of the action's voting window. */
  const atFraction = (f: number) => submitted + Math.round(f * windowDays * DAY);

  for (let a = 0; a < 4; a++) {
    const id = `ga_info_${a}`;
    await seedAction(id, FOCUS_TYPE, submitted, decidedEpoch);
    await upsertVotes(
      env.DB,
      id,
      [
        { voterRole: 'DRep', voterId: FOCUS_DREP, voterHex: null, vote: 'Yes', blockTime: atFraction(0.2) },
        ...[0.1, 0.25, 0.45, 0.6, 0.8, 1.2].map((f, n) => ({
          voterRole: 'DRep', voterId: `drep_${a}_${n}`, voterHex: null, vote: 'Yes',
          blockTime: atFraction(f),
        })),
        ...[0.15, 0.35, 0.5, 0.7, 0.9, 1.1].map((f, n) => ({
          voterRole: 'SPO', voterId: `pool_${a}_${n}`, voterHex: null, vote: 'Yes',
          blockTime: atFraction(f),
        })),
      ],
      1,
    );
  }

  for (let a = 0; a < 2; a++) {
    const id = `ga_thin_${a}`;
    await seedAction(id, 'TreasuryWithdrawals', submitted, decidedEpoch);
    await upsertVotes(
      env.DB,
      id,
      [0.2, 0.4, 0.6].map((f, n) => ({
        voterRole: 'DRep', voterId: `thin_${a}_${n}`, voterHex: null, vote: 'No',
        blockTime: atFraction(f),
      })),
      1,
    );
  }
}
