---
title: "Sorting governance actions"
description: "What the Trending, New, Closing Soon, and Recently Ratified sorts order by on the governance actions list."
cardLabel: "Sorting governance actions"
category: "Understanding governance"
order: 3
---

The governance actions list can be ordered four ways, chosen with the tabs above the
list. New is the default, showing the most recently submitted actions first so you can
catch up on what has just appeared on-chain.

**New:** Newest submission first, by the epoch the action was proposed on-chain. Every action is included.

**Trending:** Where discussion and voting are happening now. Recent replies and ongoing votes lift an action; the score halves for every week without activity, so a busy old action does not sit at the top forever. Decided actions sink to the bottom.

**Closing Soon:** Soonest to close first, by the expiry epoch. Only actions whose voting is still open are listed; decided ones drop out.

**Recently Ratified:** Most recently decided first (enacted, expired, dropped, or closed). Useful for catching up on outcomes.

## How Trending is scored

Each action gets a score from two parts. Engagement counts forum replies plus the
number of on-chain votes cast, with the vote count damped so a few thousand votes do
not drown out everything else. Recency measures how long since the last activity and
halves every week. Decided actions are scored far lower so they settle at the bottom.
An action with no comments yet still has a recency score based on its submission time,
so it orders by when it was proposed on-chain.

## Related

- [Governance action statuses](/help/governance-statuses)
- [Proposers](/help/proposers)
- [Governance action types](/help/governance-action-types)
