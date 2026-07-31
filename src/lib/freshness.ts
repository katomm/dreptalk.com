// How often each on-chain value is refreshed. On-chain values are synced on
// crons (lean and cheap): they are cached, not live, and every place they
// appear shows an explicit "as of" time.
//
// The cadences live in TWO hand-maintained places that must stay in sync:
//   1. The FRESHNESS array below (rendered by /debug/sync).
//   2. The markdown table in src/content/guides/data-freshness.md (the public
//      /help/data-freshness page).
// Editing one means editing the other. freshness.table.test.ts is a drift guard:
// it reads the markdown table and fails CI if it no longer matches FRESHNESS, so
// the two copies cannot silently diverge.

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
    refresh: 'About every 20 minutes, active actions only',
    notes: 'Vote lists are larger than the tallies but still refresh on a short cycle.',
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
// These MUST match the `crons` array in workers/gov-sync/wrangler.toml: the worker
// dispatches on event.cron against these constants, so a mismatch is caught in the
// first scheduled log after a deploy (the run falls through to the default branch).
export const CRON_GOVERNANCE = '*/5 * * * *'; // discovery + notification dispatch every 5 min; heavy tallies gated to every 15 (minute % 15)
export const CRON_VOTE_SYNC = '*/20 * * * *'; // per-post vote lists (every 20 min, active only)
export const CRON_DREP_SYNC = '0 */6 * * *'; // DRep profile sync

// Matches one cron field against a value: '*', '*/n', or a plain number. This
// covers exactly the subset of cron syntax the CRON_* constants use; anything
// fancier (lists, ranges) is not supported and yields null from nextCronRunMs.
function cronFieldMatches(field: string, value: number): boolean {
  if (field === '*') return true;
  const step = /^\*\/(\d+)$/.exec(field);
  if (step) return value % Number(step[1]) === 0;
  return /^\d+$/.test(field) && Number(field) === value;
}

/**
 * Next UTC fire time (ms) for one of the CRON_* expressions, strictly after
 * nowMs. Day/month/weekday fields must be '*'. Scans minute steps, bounded to
 * 48h, which comfortably covers the longest supported cadence.
 */
export function nextCronRunMs(cron: string, nowMs: number): number | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5 || parts.slice(2).some((p) => p !== '*')) return null;
  const [minute, hour] = parts;
  const start = Math.floor(nowMs / 60_000) * 60_000 + 60_000;
  for (let t = start; t <= nowMs + 48 * 3_600_000; t += 60_000) {
    const d = new Date(t);
    if (cronFieldMatches(minute, d.getUTCMinutes()) && cronFieldMatches(hour, d.getUTCHours())) {
      return t;
    }
  }
  return null;
}
