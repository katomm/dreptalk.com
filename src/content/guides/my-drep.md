---
title: "Following your own DRep"
description: "What the private My DRep page shows delegators: the actions, rationales, vote changes and voting power of your DRep since your delegation, and what a default option meant on the decided actions."
cardLabel: "My DRep"
category: "Start here"
order: 7
faqs:
  - q: "Why does my page say the delegation start is still being looked up?"
    a: "The start comes from your latest delegation certificate on chain, which DRepTalk reads once per tracked account. A fresh link, or a delegation you just changed, is normally on record within a day. Until it is, the page shows no figures and no actions rather than counting from a date it cannot prove."
  - q: "Does the page show my stake address to anyone?"
    a: "No. Your stake address stays on the server. It appears in no link, no page URL and no part of the page you can view or share, and the page only ever renders your own delegation."
---

Once you have linked a stake wallet to your account, DRepTalk knows who your voting power sits with. The private [My DRep page](/my-drep/) uses that to answer one question: what has happened since you delegated. It is reachable from your start page and from your [account settings](/settings/account/), and only you can see it.

Every fact on the page is public blockchain data. Signing in does not unlock private information, it only tells DRepTalk which slice of the public record is yours.

## Where the starting point comes from

Every figure on the page counts from one epoch: the epoch of your latest vote-delegation certificate. That is the certificate that set your current delegation, so the page describes the arrangement you are in right now, not an older one.

Re-delegating restarts the clock, including a re-delegation to the same DRep. That is why the page says "since your latest delegation in epoch N" rather than "since you first delegated". The epoch is read once from the on-chain history of your account and refreshed daily for accounts that do not have it yet. Until it is on record, the page shows nothing that would count from it and says so.

## What the page shows for a DRep delegation

**Participation since then.** The decided governance actions your DRep could have voted on from your start epoch onward, and how many of them carry its vote. An action counts as decided once it was enacted, ratified, expired or closed, and it only enters the basis once at least one DRep voted on it. Actions decided before your start epoch are never counted against your DRep on your behalf.

**Rationale coverage since then.** How many of those votes carry a linked rationale document. Coverage counts the actions your DRep actually voted on, not every eligible action, and it measures whether a rationale is attached, not whether its reasoning convinces you.

**Vote changes since then.** How often your DRep replaced one of its own votes with a later one on the same action. Changing a vote while an action is still open is normal and allowed. The count is informational, a high number is not a fault and a zero is not a virtue.

**Actions without a vote.** The specific decided actions in the window that carry no vote from your DRep, each with its type, the epoch it was decided in and a link to the discussion. If your DRep has since ended its registration, the page says so above the list, because a retired DRep could not vote on what was decided afterwards.

**Voting power and delegators.** The recorded voting power and delegator headcount at your delegation and now, plus the change between the two. Both come from per-epoch snapshots. When no snapshot exists for your start epoch, whether because the history no longer reaches that far back or because that epoch was never captured, the column header names the earliest figure available instead of passing it off as the figure for your start. Where no snapshot exists for an epoch, the page says so instead of showing a zero, because no figure and a figure of zero are different statements. A change needs two different epochs, so when both columns read the same snapshot the change stays blank rather than reading as a steady zero.

If your DRep registered later than your delegation, the figures start at the registration epoch instead, and the page says so. Nothing exists to measure before a DRep exists, and starting there keeps these figures comparable with the public record on its profile.

Figures never appear without their basis. "3 of 4 decided actions since epoch 640" is the honest form, a bare percentage is not.

## What the page shows for a default option

If your voting power sits with always abstain or always no confidence, there is no DRep to follow, so the page shows what your standing choice did instead. It lists up to the ten most recent actions decided since your delegation started, and what your stake counted as on each one. Actions decided before you made that choice are left out, because your stake did not count as anything on them. The page states how many actions that basis actually holds, so a short window with fewer decided actions is not described as ten.

The starting point works the same way as for a DRep delegation: until the epoch of your latest delegation certificate is on record, the page lists nothing rather than labelling an effect it cannot place in time.

The rules come from the ledger, not from DRepTalk:

- **Always abstain** is counted as abstaining on every governance action. Your stake stays out of the yes and no sides and out of the threshold the action has to clear.
- **Always no confidence** is counted as yes on a motion of no confidence, because that motion is exactly the position the option expresses, and as no on every other action type.

There is nothing to cast and no rationale to read. The option applies itself, on every action, until you change it. [What the default delegation options do](/help/default-delegation-options/) covers both in more depth.

## Privacy

The page renders your own delegation and nothing else. Your stake address is used on the server to resolve who you delegated to and never leaves it: it is in no link, no URL and no part of the rendered page. The page is excluded from search engines, and pages served to a signed-in session are never stored in a shared cache.

Your DRep is not told that you are following its record, and the page reveals nothing about other delegators.

## Frequently asked questions

### Why does my page say the delegation start is still being looked up?

The start comes from your latest delegation certificate on chain, which DRepTalk reads once per tracked account. A fresh link, or a delegation you just changed, is normally on record within a day. Until it is, the page shows no figures and no actions rather than counting from a date it cannot prove.

### Does the page show my stake address to anyone?

No. Your stake address stays on the server. It appears in no link, no page URL and no part of the page you can view or share, and the page only ever renders your own delegation.
