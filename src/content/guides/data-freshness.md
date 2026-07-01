---
title: "Data freshness"
description: "How often DRepTalk refreshes Cardano on-chain values: governance tallies, DRep profiles, and vote badges. Cached, not live."
cardLabel: "Data freshness"
category: "About DRepTalk"
order: 4
---

DRepTalk reads on-chain data (governance tallies and status, DRep profiles, vote badges)
on a schedule, not on every page load. That keeps the platform fast and cheap to run.
It also means these values are **cached, not live**: each one is shown with an
explicit "as of" time, and we never claim it is live. Forum posts themselves
are never delayed. Here is how often each thing updates.

<!-- This table is one of two hand-maintained copies of the cadences; the other
is the FRESHNESS array in src/lib/freshness.ts (rendered by /debug/sync). Keep
both in sync when a cadence changes. freshness.table.test.ts fails CI if the rows
below no longer match FRESHNESS (label, refresh, and notes columns, in order). -->

| Data | Refresh | Notes |
|------|---------|-------|
| Forum posts and topics | Immediate | Real forum activity is not delayed; anonymous views are edge-cached for about 30 seconds. |
| Governance actions (new threads) | About every 15 minutes | A discovery cron opens one thread per new on-chain action. |
| Governance tallies and status (DRep, SPO, CC) | About every 15 minutes, active actions only | Frozen once an action is ratified, enacted, expired, or dropped. Shown with an "as of" time. |
| Per-post vote badges | About every 20 minutes, active actions only | Vote lists are larger than the tallies but still refresh on a short cycle. |
| DRep profiles (name, bio, avatar) and status | About every 4 to 6 hours | The drep-sync cron keeps every DRep profile current. |
| DRep role re-check (write access) | Daily | Independent of the login session. |

## Which vote rationales appear

On a governance action's Positions tab we show the on-chain rationales attached to
votes. Each rationale is a separate document the DRep links from their vote, often
hosted on IPFS or their own server, so reading one means fetching an external file.
To keep the page fast and reliable we surface the rationales behind the largest
share of the voting weight first, and widen coverage from there over time. A
rationale that is not shown here yet is in no way diminished: it stays permanently
recorded on-chain, fully valid, and you can open it directly from the vote's
on-chain link.

## Related

- [Governance action statuses](/help/governance-statuses)
- [Sorting governance actions](/help/sorting)
- [Open source](/help/open-source)
