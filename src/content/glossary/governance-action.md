---
term: "Governance action"
description: "A governance action is an on-chain proposal in Cardano governance that DReps, SPOs, and the Constitutional Committee vote on within a fixed voting window."
group: "Governance action types"
order: 1
updated: 2026-07-14
---

A **governance action** is an on-chain proposal in Cardano's governance system. Anyone can submit one by locking a deposit; the action then enters a voting window measured in epochs, during which [DReps](/glossary/drep/), [SPOs](/glossary/spo/), and the [Constitutional Committee](/glossary/constitutional-committee/) cast their votes. Which of the three bodies vote, and what share of their [voting power](/glossary/voting-power/) must approve, depends on the action's type.

CIP-1694 defines seven types: [motion of no confidence](/glossary/motion-of-no-confidence/), [update the constitutional committee](/glossary/update-constitutional-committee/), [new constitution or guardrails script](/glossary/new-constitution/), [hard fork initiation](/glossary/hard-fork-initiation/), [protocol parameter change](/glossary/protocol-parameter-change/), [treasury withdrawal](/glossary/treasury-withdrawal/), and [info action](/glossary/info-action/).

An action that reaches its thresholds is ratified and then enacted by the ledger; one that does not is dropped when its window expires. Each action's current status and full voting record is tracked in the [governance actions feed](/c/governance-actions/), where every action also has its own discussion thread.

## Related

- [Cardano governance action types](/help/governance-action-types/)
- [Governance action statuses](/help/governance-statuses/)
- [Governance actions feed](/c/governance-actions/)
