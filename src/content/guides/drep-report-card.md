---
title: "Reading a DRep's governance record"
description: "What the participation percentile, rationale coverage, vote timing and long-term trend on a DRep profile actually measure, and where they come from."
cardLabel: "Governance record"
category: "Understanding governance"
order: 92
updated: 2026-09-02
faqs:
  - q: "Why does one DRep show percentiles and another none?"
    a: "Percentiles need a fair comparison basis. A DRep with fewer than five eligible actions, or one that is not currently active, has no cohort to be measured against, so the card shows its plain numbers without a percentile rather than one drawn from too small or too uneven a group."
  - q: "Is a low vote-timing day better?"
    a: "No. The median day describes when a DRep tends to vote, not how well. Voting late in a window can reflect waiting for discussion to develop, and voting early can reflect a firm existing position. Neither pattern is scored."
---

Every [DRep profile](/dreps/) carries a governance record card: how much of the governance a DRep has taken part in, whether its votes carry a published rationale, when in a voting window it tends to vote, and how its power and delegator count have moved over time. The card is informational. It describes patterns in a DRep's on-chain record, it does not grade the DRep or rank it against some ideal.

## Participation and its percentile

Participation counts the eligible actions a DRep voted on. An action is eligible for a DRep once it is concluded and at least one DRep cast a vote on it, counted from the epoch the DRep itself registered onward. Actions decided before a DRep existed are never held against it.

Where a percentile appears, it reads "Ahead of X% of N active DReps". X is the share of the comparison group with a strictly lower participation rate, N is the size of that group. The comparison group, the cohort, is every active DRep with at least five eligible actions since registration. The two predefined default options, always abstain and always no confidence, hold real voting weight but are not representatives, so they are excluded from the cohort. A DRep below the five-action floor, or one that is not active, gets no percentile at all rather than one computed against too small or too uneven a group.

Percentiles are recomputed several times a day from the same cohort, while the participation rate itself is always the DRep's current, live number. The two can shift independently between refreshes, a percentile a few hours old sitting next to a rate that updated moments ago.

## Rationale coverage

A vote can carry a rationale, a linked document explaining the decision. Coverage here follows the same anchor-presence definition as the [analytics page](/help/governance-analytics/): a vote counts as carrying a rationale when it has that link attached, not whether the linked document can actually be retrieved or whether its reasoning holds up. A DRep with no rationale on a vote is not judged as having reasoned any less, some DReps explain their votes elsewhere.

The rationale percentile uses the same active, five-eligible-action cohort as participation, with one more requirement: only DReps who cast at least one vote get a rationale percentile, since coverage is only meaningful once there is something to cover. A cohort member with zero votes still shows a participation row, just no rationale figures.

## Vote timing

Vote timing reports the median day after an action's submission that a DRep casts its vote, counted only over votes that carry both a submission and a vote timestamp. A vote whose timestamp predates the action's own submission is a data anomaly and is skipped as well. Where not every vote was usable, the card says how many of the total went into the median.

This number describes a style, not a quality. Earlier is not better. A DRep that tends to vote late in a window may be waiting for discussion to develop before committing, one that votes early may already hold a firm position from prior review. Both are legitimate ways to participate, and the card makes no attempt to rank one above the other.

## Power and delegator trend

The trend chart on a profile reaches all the way back to the start of the DRep era, epoch 508 on mainnet, so it shows a DRep's full history of delegated voting power rather than a recent window. Delegator counts on the same chart start later. They exist only from the epoch DRepTalk began observing them, so that line begins partway through the chart instead of implying a count that was never actually recorded. As more epochs pass, both lines simply get longer.

## For DRep owners

Signed-in DReps can access a [private detail page](/my-governance-record/) showing the complete data behind the governance record card. The page displays the full distributions underlying your participation and rationale percentiles, lists eligible actions you have not yet voted on, shows votes without a published rationale, and compares your voting timing pattern to the network median. The page is private to you, but every underlying fact is public blockchain data.

## Frequently asked questions

### Why does one DRep show percentiles and another none?

Percentiles need a fair comparison basis. A DRep with fewer than five eligible actions, or one that is not currently active, has no cohort to be measured against, so the card shows its plain numbers without a percentile rather than one drawn from too small or too uneven a group.

### Is a low vote-timing day better?

No. The median day describes when a DRep tends to vote, not how well. Voting late in a window can reflect waiting for discussion to develop, and voting early can reflect a firm existing position. Neither pattern is scored.
