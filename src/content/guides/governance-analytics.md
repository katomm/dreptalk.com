---
title: "Understanding the analytics page"
description: "What the governance analytics page shows, where its numbers come from, and how to read the per-epoch trends honestly."
cardLabel: "Analytics page"
category: "Understanding governance"
order: 90
faqs:
  - q: "Why do some charts start later than others?"
    a: "Each metric shows data from the first epoch it can be measured reliably. Voting power can be reconstructed from chain history, but delegator counts only exist from the point DRepTalk started observing them live, so that chart starts later instead of pretending older data exists."
  - q: "Why does the current epoch look provisional?"
    a: "An epoch's vote activity is only final once the epoch has ended. The page treats the running epoch as incomplete by design and finalizes its numbers right after the epoch rolls over."
  - q: "What is the difference between active and with voting power?"
    a: "Active follows the on-chain registration state. A DRep can be active with zero delegated stake, and stake can still sit with a DRep whose registration has lapsed. The activity section shows both layers separately."
  - q: "Why do some actions show no concentration numbers?"
    a: "The per-vote voting power for at least one vote on that action is not recorded. Concentration stats are computed only over complete data, a partial reading would understate how concentrated the vote really was."
  - q: "What counts as a changed vote?"
    a: "Only a re-vote whose final position differs from the voter's first recorded one. Re-votes that keep the position, for example to attach or update a rationale, are counted separately and never shown as changed votes."
  - q: "Could the largest DReps really decide an action on their own?"
    a: "The smallest-group numbers are arithmetic on the current delegated voting power: those DReps together hold enough weight to reach the threshold's share. Nothing suggests they coordinate, and in practice votes come from a much broader set, which the voting concentration and effective representation panels measure."
  - q: "Does a missing rationale mean a DRep voted carelessly?"
    a: "No. The rationale figures measure whether a vote carries a published explanation, nothing about its reasoning. Some DReps explain their votes in other places, and a vote without an attached rationale can be as considered as any other."
---

The [analytics page](/analytics/) tracks how healthy, representative and decentralized Cardano governance is, one epoch at a time. Everything on it comes from on-chain data, refreshed several times a day.

## The two layers

DRep statistics on DRepTalk always separate two things. The representative layer covers real registered DReps: their count, their combined voting power, and how concentrated that power is. The default delegation layer covers the two predefined options, always abstain and always no confidence, which hold real voting weight but are not representatives. The analytics page shows them side by side without ever mixing them, so a rise in default delegation never reads as a change in DRep concentration. If the two options are new to you, start with [what the default options do](/help/default-delegation-options/).

## Reading the trends

Every trend chart states the epoch its data starts in. That start is not cosmetic: it marks the first epoch the metric can be measured reliably, and the chart refuses to show anything earlier rather than guessing.

Changes between epochs are shown as net change. If a chart shows 2,000 more delegators than the epoch before, that is the balance of everyone who arrived and everyone who left. On-chain epoch aggregates cannot tell those two groups apart, so the page never claims inflow or outflow.

The "voted in the last 12 epochs" figure counts DReps with at least one on-chain vote in that window, including votes that were later changed. Twelve epochs is roughly two months, long enough that a quiet stretch between governance actions does not make the whole network look inactive.

## Voting concentration in practice

The effective-representation panel and the Positions tab of a governance action also read how concentrated the cast votes were. These numbers describe exercised power, the voting power that actually voted, not the distribution of all delegated power. The half-count says how few of the largest voters together cast at least half of the voted power. The action page adds the largest voter's share, the combined top-5 share, and, where the action has an approval threshold, how many of the largest voters together held as much power as the threshold required in yes votes. That reading is arithmetic on cast votes, it does not claim those voters coordinated or voted the same way.

These stats only appear when the voting power behind every single vote on the action is recorded. An action with incomplete per-vote power shows no concentration numbers at all rather than a misleading partial sum.

## Changed votes

A DRep can re-vote on an action at any time while voting is open, and the analytics page tracks what those re-votes actually did. A re-vote only counts as a changed vote when the voter's final position differs from their first recorded one. Many re-votes keep the position and only update the attached rationale, and those are shown separately rather than inflated into change numbers. The panel also shows where changed votes moved, to yes, to no or to abstain, and which decided actions were reconsidered the most.

Only actions whose complete vote history has been swept from the chain are counted, and the panel says how many are still queued. The same honest split appears on each action's Votes tab.

## Vote rationales

Every on-chain vote can carry a metadata document explaining the decision, the rationale. The rationales panel measures how many DRep votes on decided actions carry that link, both as a share of votes and weighted by the voting power behind them. A linked document is not always retrievable, so these figures can read higher than the readable rationales on an action's own page. It also shows which decided actions were best and least covered, and how many rationales arrived only later, through a re-vote on the same action.

Coverage is a presence check, nothing more. A vote with a rationale is not automatically better reasoned than one without, and the panel makes no attempt to judge content. The power-weighted figure only counts actions where the voting power behind every single vote is recorded, and says how many actions that excludes.

## Concentration of delegated power

The lower part of the page looks at how concentrated the delegated voting power itself is, independent of who actually votes. The Gini coefficient summarizes how unevenly power is spread across DReps, from 0 for a perfectly even spread to values near 1 when a few DReps hold most of it. The top-10 share and the minimum-coalition counts make the same idea concrete: how much the ten largest DReps hold, and how few of the largest DReps together reach half or two thirds of all delegated power.

The smallest-group table applies the live approval thresholds to the current distribution: for each threshold it shows how few of the largest DReps together hold that share of the delegated power, and which action types the threshold gates. This is arithmetic on delegated power, not a claim that those DReps coordinate or vote at all. How the power that actually voted concentrates is a separate reading, described under voting concentration above.

## Where the numbers come from

DRepTalk records one row of governance aggregates per epoch, built from the same chain data that powers the rest of the site. Voting power snapshots come from the per-epoch stake distribution, vote counts from the on-chain votes themselves, and the concentration figures from the full distribution of delegated power across DReps, with the two default options excluded. The effective-representation panel measures each action against its decision epoch, while the tally bar on an action page uses the epoch of the latest tally, so the two can sit one epoch apart for the same action. The threshold marker on the full-stake bar maps the approval threshold onto the abstain-reduced representative stake, a deliberate simplification stated here so nobody mistakes it for a hand-computed break-even.

## Frequently asked questions

### Why do some charts start later than others?

Each metric shows data from the first epoch it can be measured reliably. Voting power can be reconstructed from chain history, but delegator counts only exist from the point DRepTalk started observing them live, so that chart starts later instead of pretending older data exists.

### Why does the current epoch look provisional?

An epoch's vote activity is only final once the epoch has ended. The page treats the running epoch as incomplete by design and finalizes its numbers right after the epoch rolls over.

### What is the difference between active and with voting power?

Active follows the on-chain registration state. A DRep can be active with zero delegated stake, and stake can still sit with a DRep whose registration has lapsed. The activity section shows both layers separately.

### Why do some actions show no concentration numbers?

The per-vote voting power for at least one vote on that action is not recorded. Concentration stats are computed only over complete data, a partial reading would understate how concentrated the vote really was.

### What counts as a changed vote?

Only a re-vote whose final position differs from the voter's first recorded one. Re-votes that keep the position, for example to attach or update a rationale, are counted separately and never shown as changed votes.

### Does a missing rationale mean a DRep voted carelessly?

No. The rationale figures measure whether a vote carries a published explanation, nothing about its reasoning. Some DReps explain their votes in other places, and a vote without an attached rationale can be as considered as any other.

### Could the largest DReps really decide an action on their own?

The smallest-group numbers are arithmetic on the current delegated voting power: those DReps together hold enough weight to reach the threshold's share. Nothing suggests they coordinate, and in practice votes come from a much broader set, which the voting concentration and effective representation panels measure.
