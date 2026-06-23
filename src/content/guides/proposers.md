---
title: "Proposers"
description: "How DRepTalk identifies who proposed a governance action: a curated list of known organizations, with an identicon fallback for everyone else."
cardLabel: "Proposers"
category: "Understanding governance"
order: 4
---

Every governance action has a proposer, identified on-chain by the reward
(return) address that receives the action deposit back. DRepTalk shows that
proposer in two ways:

- **Known organizations** (such as Intersect, Input Output, the
  Cardano Foundation, and others that propose regularly) are shown with their
  name and logo. This is a list DRepTalk curates and maintains by matching the
  action's reward address; it is not an on-chain verification of identity.

- **Everyone else** is shown with a deterministic identicon
  generated from the reward address, plus the address itself. The same address
  always produces the same icon, so a recurring proposer is still recognizable
  even before it is added to the curated list.

The proposer shown is the on-chain submitter: the holder of the reward address
that posts and reclaims the action deposit. Some organizations, such as
Intersect, submit and administer many actions on behalf of various authors, so a
known label reflects who submitted an action, not necessarily who wrote it.

If you think a proposing organization should be on the known list, it can be
added over time.

## Related

- [Governance action statuses](/help/governance-statuses)
- [Governance action types](/help/governance-action-types)
- [Sorting governance actions](/help/sorting)
