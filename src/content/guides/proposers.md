---
title: "Proposers of Cardano governance actions"
description: "How DRepTalk shows who proposed a governance action: an experimental curated list on the overview, and the submitter plus the on-chain author list on the action page."
cardLabel: "Proposers"
category: "Understanding governance"
order: 4
updated: 2026-07-27
---

Every governance action has a proposer, identified on-chain by the reward
(return) address that receives the action deposit back. How that proposer is
shown depends on where you are looking.

## In the actions overview

The overview has one small slot per row, so it shows a single best label:

- **Known organizations** (such as Intersect, Eternl, Blink Labs,
  and others that propose regularly) are shown with their name and logo.
  This is a list DRepTalk curates and maintains by matching the action's
  reward address; it is not an on-chain verification of identity.

- **Actions whose metadata names authors** are shown with the first declared
  author's name. These names are self-declared in the action document and
  unverified.

- **Everyone else** is shown with a deterministic identicon
  generated from the reward address, plus the address itself. The same address
  always produces the same icon, so a recurring proposer is still recognizable
  even before it is added to the curated list.

The curated labeling is **experimental**. It is a convenience for recognizing
frequent submitters, kept deliberately small, and it may change as better
on-chain identity signals become available.

## On the action page

The action detail page does not collapse anything into one label. It shows the
two on-chain signals separately, exactly as they appear on the chain:

- The **Proposer** card shows the submitter: the holder of the reward address
  that posts and reclaims the action deposit (with the curated name when known,
  otherwise the identicon and address).

- The **Authors** card lists the names the action's own metadata document
  declares as authors. They are rendered verbatim, without logos or links,
  and without verification.

Submitter and authors can differ. Some organizations, such as Intersect, submit
and administer many actions on behalf of various authors, so a known label
reflects who submitted an action, not necessarily who wrote it.

The curated list is maintained in the open. You can see exactly which
organizations and addresses are recognized, and suggest additions, in
[config/proposers.ts](https://github.com/katomm/dreptalk.com/blob/main/config/proposers.ts)
on GitHub.

## Related

- [Governance action statuses](/help/governance-statuses/)
- [Governance action types](/help/governance-action-types/)
- [Sorting governance actions](/help/sorting/)
