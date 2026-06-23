---
title: "Cardano governance action statuses explained"
description: "What each Cardano governance action status label means: active, ratified, enacted, expired, dropped, closed, and syncing."
cardLabel: "Governance action statuses"
category: "Understanding governance"
order: 2
---

Each governance action carries a status label derived from its on-chain lifecycle.
The labels differ by action type: enactable actions can be ratified and enacted, while
info actions only signal and never enact. All values are synced on a schedule and shown
with an "as of" time (see [data freshness](/help/data-freshness)).

## While we are catching up

Our own sync state, not on-chain.

**Syncing:** We have found the action on-chain but have not yet synced its current status and tallies.

## Enactable actions

Treasury withdrawals, parameter changes, new constitution, new committee, hard-fork initiation.

**Active:** Voting is open; the action has not been decided yet.

**Ratified:** Reached the required approval thresholds and is queued for enactment. Brief; you will usually see Enacted instead.

**Enacted:** Ratified and applied on-chain. The successful end state.

**Expired:** The voting window ended without ratification, the action ran out of time.

**Dropped:** Removed from the proposal set without expiring, for example when a competing action of the same type was enacted, making this one moot.

## Info actions

Signalling only, no on-chain effect.

**Active:** Voting is open.

**Closed:** The voting window ended. Info actions have no on-chain effect and can never be ratified or enacted, so they simply close.

## Related

- [Data freshness](/help/data-freshness)
- [Sorting governance actions](/help/sorting)
- [Governance action types](/help/governance-action-types)
