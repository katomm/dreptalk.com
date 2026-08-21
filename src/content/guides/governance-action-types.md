---
title: "Cardano governance action types explained"
description: "The kinds of on-chain governance actions on Cardano, what each one does, and which bodies (DReps, SPOs, the Constitutional Committee) vote on them."
cardLabel: "Governance action types"
category: "Understanding governance"
order: 2
updated: 2026-06-23
---

On Cardano, governance is exercised through **governance actions**: on-chain proposals that the community votes on. There are seven distinct action types defined in CIP-1694 (the Conway era governance rules), each with its own purpose and its own set of voters.

## Motion of no confidence

A motion of no confidence declares that the community no longer trusts the current constitutional committee and wishes to replace it. This action is voted on by **SPOs and DReps**; the constitutional committee does not vote, since the action is specifically a challenge to its legitimacy. If ratified, the committee is dissolved.

## Update the constitutional committee or its threshold

This action adds or removes members of the constitutional committee, or changes the signing threshold required for the committee to approve a governance action. It is voted on by **SPOs and DReps**.

## New constitution or guardrails script

This action adopts a new constitution document or updates the on-chain guardrails script that constrains which protocol parameters are allowed to change and to what values. It is voted on by **DReps and the constitutional committee**.

## Hard fork initiation

A hard fork initiation moves the network to a new protocol major version, introducing breaking changes to the ledger rules. All three voting bodies take part: **SPOs, DReps, and the constitutional committee** must all approve it before the upgrade proceeds.

## Protocol parameter changes

This action adjusts one or more on-chain protocol parameters, such as transaction fees, block sizes, or economic constants. It is voted on by **DReps and the constitutional committee**. For parameters classified as security-relevant, **SPOs** also have a vote.

## Treasury withdrawals

A treasury withdrawal moves ada from the on-chain treasury to a specified stake address, funding project proposals or grants. It is voted on by **DReps and the constitutional committee**.

## Info action

An info action records an on-chain opinion or signal without changing any ledger state. It is non-binding: no parameters change, no funds move, and there is no ratification threshold to clear. Votes are recorded and tallied on-chain, but the action closes at the end of its voting window with no enacted effect.

## Who votes

Three bodies participate in Cardano on-chain governance:

- **DReps (Delegated Representatives):** Ada holders delegate their voting power to DReps, who cast votes on governance actions on their behalf. DReps vote on almost every action type.
- **SPOs (Stake Pool Operators):** SPOs vote to represent the interests of the network's block producers. They are required for no-confidence motions, constitutional committee changes, and hard forks. They also co-vote on security-relevant protocol parameter changes. How a pool casts its vote is covered in [Voting as an SPO](/help/voting-as-an-spo/).
- **The Constitutional Committee:** A group of elected representatives who verify that proposed actions conform to the Cardano constitution. They vote on most action types, with two exceptions: no-confidence motions (where they have a conflict of interest) and updates to the constitutional committee or its threshold (where they are themselves the subject of the action).

Which combination of bodies must approve a given action, and what share of each body's stake or seats is required, are both governed by **protocol parameters**. Those thresholds can change over time; the exact current values are not stated here. For the lifecycle of a specific action after voting closes, see [Governance action statuses](/help/governance-statuses/). You can browse all live governance actions in the [governance actions feed](/c/governance-actions/).

## Related

- [Governance action statuses](/help/governance-statuses/)
- [Writing a vote rationale](/help/writing-a-vote-rationale/)
