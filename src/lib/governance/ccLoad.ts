// Database reads behind the committee pages and their share cards. The /cc/
// index and /og/cc.png share loadCcOverview, a profile and /og/cc/:hex.png share
// loadCcMemberProfile, so a card can never show other numbers than its page.
import { consideredCcActions } from '../analytics/ccParticipation.js';
import { getCcRationaleStates, type CcRationaleStates } from '../db/actionRationale.js';
import { getAllCcMemberNames } from '../db/ccMemberName.js';
import { getCommitteeTimeline, listDecidedCcActions, listDecidedCcVoteRows, listOpenCcVoteRows } from '../db/committee.js';
import { getProtocolParams } from '../db/protocolParams.js';
import { buildCcNameIndex } from './ccNames.js';
import { buildCcFacts, buildCcTimeline, type CcFacts, type CcTimeline } from './ccOverview.js';
import { buildCcIndex, buildCcMemberProfile, countReadableRationales, currentCcStanding, type CcIndexRow, type CcMemberProfileView } from './ccProfile.js';

/** committee_max_term_length from the stored epoch params JSON. */
function maxTermLength(rawJson: string | null): number | null {
  if (rawJson == null) return null;
  try {
    const v = (JSON.parse(rawJson) as Record<string, unknown>).committee_max_term_length;
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

export interface CcOverviewData {
  rows: CcIndexRow[];
  facts: CcFacts;
  timeline: CcTimeline | null;
}

export async function loadCcOverview(db: D1Database): Promise<CcOverviewData> {
  const [params, actions, votesByAction, timeline, nameRows] = await Promise.all([
    getProtocolParams(db),
    listDecidedCcActions(db),
    listDecidedCcVoteRows(db),
    getCommitteeTimeline(db),
    getAllCcMemberNames(db),
  ]);
  const currentEpoch = params?.epoch ?? null;
  const { members, hotToCold } = timeline;
  const { considered } = consideredCcActions({ actions, votesByAction, members, hotToCold, currentEpoch });
  const rows = buildCcIndex({ considered, members, hotToCold, nameIndex: buildCcNameIndex(nameRows, hotToCold), currentEpoch });
  const facts = buildCcFacts({
    rows,
    members,
    minSize: params?.committeeMinSize ?? null,
    threshold: params?.ccThreshold ?? null,
    maxTermEpochs: maxTermLength(params?.rawJson ?? null),
  });
  return { rows, facts, timeline: buildCcTimeline(rows, members, currentEpoch) };
}

export interface CcMemberProfileData {
  profile: CcMemberProfileView;
  states: CcRationaleStates;
  /** Counted votes with a readable rationale. */
  readable: number;
}

/** Null for a cold key the committee timeline does not know. Open ballots are read only when asked for and the seat is Active. */
export async function loadCcMemberProfile(
  db: D1Database,
  coldKeyHex: string,
  opts: { openVotes: boolean },
): Promise<CcMemberProfileData | null> {
  // The timeline decides whether the key exists, so an unknown key skips the heavy reads.
  const [timeline, params] = await Promise.all([getCommitteeTimeline(db), getProtocolParams(db)]);
  const { members, hotToCold } = timeline;
  if (!members.some((m) => m.coldKeyHex === coldKeyHex)) return null;
  const currentEpoch = params?.epoch ?? null;
  const wantOpen = opts.openVotes && currentCcStanding(members, coldKeyHex, currentEpoch) === 'Active';
  const [actions, votesByAction, nameRows, openVotes] = await Promise.all([
    listDecidedCcActions(db),
    listDecidedCcVoteRows(db),
    getAllCcMemberNames(db),
    wantOpen ? listOpenCcVoteRows(db) : Promise.resolve([]),
  ]);
  const { considered } = consideredCcActions({ actions, votesByAction, members, hotToCold, currentEpoch });
  const profile = buildCcMemberProfile({
    coldKeyHex,
    considered,
    members,
    hotToCold,
    nameIndex: buildCcNameIndex(nameRows, hotToCold),
    currentEpoch,
    openVotes,
  });
  if (!profile) return null;
  const pairs = [...profile.record, ...profile.uncounted].flatMap((r) => (r.vote ? [{ gaId: r.gaId, voterId: r.vote.voterId }] : []));
  const states = await getCcRationaleStates(db, pairs);
  return { profile, states, readable: countReadableRationales(profile.record, states) };
}
