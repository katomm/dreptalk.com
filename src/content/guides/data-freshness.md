---
title: "Data freshness"
description: "How often DRepTalk refreshes Cardano on-chain values: governance tallies, DRep profiles, and vote badges. Cached, not live."
cardLabel: "Data freshness"
category: "About DRepTalk"
order: 7
updated: 2026-09-18
---

DRepTalk reads on-chain data (governance tallies and status, DRep profiles, vote badges)
on a schedule, not on every page load. That keeps the platform fast and cheap to run.
It also means these values are **cached, not live**: each one is shown with an
explicit "as of" time, and we never claim it is live. Forum posts themselves
are never delayed. Here is how often each thing updates.

| Data | Refresh | Notes |
|------|---------|-------|
| Forum posts and topics | Immediate | Real forum activity is not delayed. Signed-out visitors may see a page up to a minute old, and for ten minutes after that a cached copy is served while a fresh one renders. |
| Governance actions (new threads) | About every 5 minutes | A discovery cron opens one thread per new on-chain action. |
| CIP-179 surveys (definitions and response counts) | About every 5 minutes | Mirrored from the Tessera index on the discovery cron, on both mainnet and preprod. A submitted answer is counted once the index has confirmed its transaction, usually under ten minutes. |
| Governance tallies and status (DRep, SPO, CC) | About every 15 minutes, active actions only | Frozen once an action is ratified, enacted, expired, dropped, or closed. Shown with an "as of" time. |
| Per-post vote badges | About every 20 minutes, active actions only | Vote lists are larger than the tallies but still refresh on a short cycle. |
| DRep profiles (name, bio, avatar) and status | Every 6 hours | The drep-sync cron keeps every DRep profile current. |
| DRep role re-check (write access) | Every 6 hours (with the DRep sync) | Every post is checked against the synced DRep status, independent of the login session. |

## Which vote rationales appear

On a governance action's Votes tab we show the on-chain rationales attached to
votes. Each rationale is a separate document the DRep links from their vote, often
hosted on IPFS or their own server, so reading one means fetching an external file.
DRepTalk fetches these documents for voters with at least 10,000 ada of voting
weight, new votes first. A document that cannot be read is retried over the
following days, and until it can be read the vote shows **Rationale
unavailable**. A rationale written on DRepTalk is stored directly, whatever the
voting power. A rationale that is not shown here is in no way diminished: it stays permanently
recorded on-chain, fully valid, and you can open it directly from the vote's
on-chain link.

Rationales come in two on-chain shapes: a single free-text comment, and a
structured form that splits the reasoning into a summary, a full statement, and a
conclusion. We render both, so an institutional DRep who files the structured form
reads the same as anyone else.

A vote can also be cast after an action has already passed its threshold and gone
to ratification. It is still a valid on-chain vote, and we show it with its
rationale, but its weight was not part of the frozen tally, so on the Votes tab
we mark it "not counted" and strike its weight through.

## Related

- [Governance action statuses](/help/governance-statuses/)
- [Sorting governance actions](/help/sorting/)
- [Open source](/help/open-source/)
