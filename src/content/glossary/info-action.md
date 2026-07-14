---
term: "Info action"
description: "An info action is a non-binding Cardano governance action that records an on-chain opinion or signal without changing any ledger state."
group: "Governance action types"
order: 8
updated: 2026-07-14
---

An **info action** is a [governance action](/glossary/governance-action/) that records an opinion or signal on-chain without changing anything: no parameters move, no funds are withdrawn, and nothing is enacted. Votes are cast and tallied like on any other action, but there is no ratification threshold to clear; the action simply closes when its voting window ends.

Info actions are used to poll the governance bodies on questions that matter but have no direct ledger effect, such as endorsing a budget process or setting the net change limit shown in the [treasury overview](/treasury/). Because they never enact, their outcome is read from the recorded votes rather than from a status change; see [governance action statuses](/help/governance-statuses/) for how that is shown.

## Related

- [Cardano governance action types](/help/governance-action-types/)
- [Governance action statuses](/help/governance-statuses/)
