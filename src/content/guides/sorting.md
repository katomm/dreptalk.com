---
title: "Sorting Cardano governance actions"
description: "What the Newest, Oldest, Trending, Closing soonest, and Recently decided sorts order by on the Cardano governance actions list, and how the status and type filters narrow it."
cardLabel: "Sorting governance actions"
category: "Understanding governance"
order: 4
updated: 2026-09-02
---

The [governance actions list](/c/governance-actions/) has three controls above
it. A status segment narrows the list to **All**, **Open**, or **Decided**
actions. A **Type** dropdown narrows it to one action type, or **All types**.
A **Sort** dropdown orders whatever is left. Filters narrow the set, the sort
only orders it, so any combination works.

The sort offers five orders. Newest is the default, showing the most recently
submitted actions first so you can catch up on what has just appeared on-chain.

**Newest:** Newest submission first, by the on-chain submission time. Every action is included.

**Oldest:** The reverse of Newest, oldest submission first.

**Trending:** Where discussion and voting are happening now. Recent replies and ongoing votes lift an action, and the score halves for every week without activity, so a busy old action does not sit at the top forever. Decided actions sink to the bottom.

**Closing soonest:** Soonest to close first, by the expiry epoch. Only actions whose voting is still open are listed, decided ones drop out.

**Recently decided:** Most recently decided first (enacted, expired, dropped, or closed), by the decision epoch. Useful for catching up on outcomes.

## How Trending is scored

Each action gets a score from two parts. Engagement counts forum replies, each
weighted three times, plus the number of on-chain votes cast, with the vote
count damped on a logarithmic scale so a few thousand votes do not drown out
everything else. Recency measures how long since the last activity and halves
every seven days. Decided actions are scored far lower so they settle at the
bottom. An action with no comments yet still has a recency score based on its
submission time, so it orders by when it was proposed on-chain.

## Related

- [Governance action statuses](/help/governance-statuses/)
- [Proposers](/help/proposers/)
- [Governance action types](/help/governance-action-types/)
