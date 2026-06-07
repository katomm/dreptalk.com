// Single source of truth for how often each on-chain value is refreshed. The
// public "Data freshness" page renders this table, and the README points at it,
// so the documented cadences can never drift from the actual behavior. On-chain
// values are synced on crons (lean and cheap): they are cached, not live, and
// every place they appear shows an explicit "as of" time.

export interface FreshnessRow {
  key: string;
  label: string;
  refresh: string;
  notes: string;
}

export const FRESHNESS: readonly FreshnessRow[] = [
  {
    key: 'posts',
    label: 'Forum posts and topics',
    refresh: 'Immediate',
    notes: 'Real forum activity is not delayed; anonymous views are edge-cached for about 30 seconds.',
  },
  {
    key: 'ga-discovery',
    label: 'Governance actions (new threads)',
    refresh: 'About every 15 minutes',
    notes: 'A discovery cron opens one thread per new on-chain action.',
  },
  {
    key: 'ga-tallies',
    label: 'Governance tallies and status (DRep, SPO, CC)',
    refresh: 'About every 15 minutes, active actions only',
    notes: 'Frozen once an action is ratified, enacted, expired, or dropped. Shown with an "as of" time.',
  },
  {
    key: 'vote-badges',
    label: 'Per-post vote badges',
    refresh: 'About hourly, active actions only',
    notes: 'Vote lists are larger and do not need 15-minute freshness.',
  },
  {
    key: 'drep-profiles',
    label: 'DRep profiles (name, bio, avatar) and status',
    refresh: 'About every 4 to 6 hours',
    notes: 'The drep-sync cron keeps every DRep profile current.',
  },
  {
    key: 'role-recheck',
    label: 'DRep role re-check (write access)',
    refresh: 'Daily',
    notes: 'Independent of the login session.',
  },
] as const;

// Cron expressions for the gov-sync worker, documented alongside the cadences.
export const CRON_GOVERNANCE = '*/15 * * * *';
export const CRON_DREP_SYNC = '0 */6 * * *';
