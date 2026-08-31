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
---

The [analytics page](/analytics/) tracks how healthy, representative and decentralized Cardano governance is, one epoch at a time. Everything on it comes from on-chain data, refreshed several times a day.

## The two layers

DRep statistics on DRepTalk always separate two things. The representative layer covers real registered DReps: their count, their combined voting power, and how concentrated that power is. The default delegation layer covers the two predefined options, always abstain and always no confidence, which hold real voting weight but are not representatives. The analytics page shows them side by side without ever mixing them, so a rise in default delegation never reads as a change in DRep concentration. If the two options are new to you, start with [what the default options do](/help/default-delegation-options/).

## Reading the trends

Every trend chart states the epoch its data starts in. That start is not cosmetic: it marks the first epoch the metric can be measured reliably, and the chart refuses to show anything earlier rather than guessing.

Changes between epochs are shown as net change. If a chart shows 2,000 more delegators than the epoch before, that is the balance of everyone who arrived and everyone who left. On-chain epoch aggregates cannot tell those two groups apart, so the page never claims inflow or outflow.

The "voted in the last 12 epochs" figure counts DReps with at least one on-chain vote in that window, including votes that were later changed. Twelve epochs is roughly two months, long enough that a quiet stretch between governance actions does not make the whole network look inactive.

## Where the numbers come from

DRepTalk records one row of governance aggregates per epoch, built from the same chain data that powers the rest of the site. Voting power snapshots come from the per-epoch stake distribution, vote counts from the on-chain votes themselves, and the concentration figures from the full distribution of delegated power across DReps, with the two default options excluded.

## Frequently asked questions

### Why do some charts start later than others?

Each metric shows data from the first epoch it can be measured reliably. Voting power can be reconstructed from chain history, but delegator counts only exist from the point DRepTalk started observing them live, so that chart starts later instead of pretending older data exists.

### Why does the current epoch look provisional?

An epoch's vote activity is only final once the epoch has ended. The page treats the running epoch as incomplete by design and finalizes its numbers right after the epoch rolls over.

### What is the difference between active and with voting power?

Active follows the on-chain registration state. A DRep can be active with zero delegated stake, and stake can still sit with a DRep whose registration has lapsed. The activity section shows both layers separately.
