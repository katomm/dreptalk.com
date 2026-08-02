---
title: "Understanding a governance action page"
description: "A tour of a Cardano governance action page on DRepTalk: the Overview, Discussion, Votes, On-chain Data, and History tabs, the voting information sidebar, and why some rationales in the discussion are frozen."
cardLabel: "Reading a governance action"
category: "Understanding governance"
order: 1
updated: 2026-08-02
faqs:
  - q: "Who can post in a governance action's discussion?"
    a: "Reading is public, no sign-in needed. Posting requires signing in with an on-chain governance identity: DReps, proposers and their co-proposers, SPOs, and Constitutional Committee members. Delegator sign-ins are read-only."
  - q: "Why is a rationale post in the discussion marked as frozen?"
    a: "It is a copy of a rationale that a DRep committed on-chain together with their vote. The on-chain document cannot change, so the discussion copy cannot be edited either. If the DRep votes again, the copy is replaced or removed along with the old vote."
  - q: "Why is a vote marked as not counted?"
    a: "Votes can still be cast after an action is ratified, but the tally that ratified the action was already frozen at that point. DRepTalk shows these late votes for completeness and marks them as not counted in the outcome."
  - q: "Are the vote numbers on the page live?"
    a: "They are synced from the chain on a schedule, usually within minutes. Each page shows an as-of time; see the data freshness guide for details."
---

Every Cardano governance action has its own page on DRepTalk, whether or not
anyone has commented on it yet. The page collects everything about the action
in one place: what it proposes, what the community says about it, who voted
and why, and where it stands in its lifecycle. This guide walks through each
part of the page.

You can reach an action from the [governance actions list](/discussions/),
from a DRep's voting record, or by pasting its id into the search box. The
list offers several sort orders; [Sorting governance
actions](/help/sorting/) explains what each one means.

## The tab bar

Under the action's title sits a tab bar with five tabs: **Overview**,
**Discussion**, **Votes**, **On-chain Data**, and **History**. Discussion and
Votes carry counts, so you can see at a glance how much conversation and how
many votes an action has drawn. On a phone the bar scrolls sideways.

<img class="shot" src="/help/shots/ga-tabs.webp" alt="A governance action page header on DRepTalk with the tab bar: Overview, Discussion, Votes, On-chain Data, and History" width="1180" height="178" loading="lazy" />

## Overview

The Overview is what the proposer submitted: a summary of the on-chain
changes the action would make, followed by the abstract, motivation, and
rationale from the proposal's metadata. It is the tab to read first when you
want to understand what is actually being decided.

Below the proposal text, **Rationale highlights** shows a balanced selection
of vote rationales: the strongest Yes and No positions by voting power, each
expandable in place. It is a quick way to hear the best argument from both
sides without reading every vote.

The sidebar next to the content answers the status questions:

- **Status.** Where the action stands (active, ratified, enacted, expired)
  and, while it is open, when the voting window ends. The labels are
  explained in [Governance action statuses](/help/governance-statuses/).
- **Voting information.** One row per voting body (DReps, SPOs, the
  Constitutional Committee) with a Yes / No / Not-voted bar over that body's
  whole eligible voting power. Actions with an on-chain approval threshold
  show the threshold as a marker on the bar and a Met or Not met verdict.
  Not every body votes on every action; [Governance action
  types](/help/governance-action-types/) lists who votes on what.
- **Proposer.** Who submitted the action, with more actions from the same
  proposer where available.

<img class="shot" src="/help/shots/ga-voting-info.webp" alt="The voting information card: Yes, No, and Not-voted shares of eligible voting power for DReps, SPOs, and the Constitutional Committee, with a voting trend chart" width="320" height="672" loading="lazy" />

## Discussion

The Discussion tab is the action's public thread. Anyone can read it without
signing in. Posting requires an on-chain governance identity: DReps,
proposers and their co-proposers, SPOs, and Constitutional Committee members
can [sign in](/help/signing-in/) and post. Every post carries its author's
verified on-chain identity and links back to their profile, so you always
know whether a comment comes from a DRep, the proposer, or another voter.

### Frozen rationales

Some posts in the discussion are labeled **Rationale** and marked as
**frozen**. These are vote rationales that a DRep chose to cross-post into
the thread when casting their vote. The original document is committed
on-chain together with the vote and cannot change afterwards, so the
discussion copy cannot be edited either: what you read is exactly what was
committed, with a link to the on-chain record. You can reply to a frozen
rationale like any other post.

If the DRep later changes their vote, the frozen copy does not linger: it is
replaced by the new rationale, or removed if the DRep did not cross-post
again.

<a href="https://dreptalk.com/t/withdraw-120-000-000-ada-for-alphagrowth-s-cardano-prime-a59c03bc/?tab=discussion#post-61669166-a308-47dd-bf1b-f53e3daf7f75"><img class="shot" src="/help/shots/ga-frozen.webp" alt="A frozen rationale post in a discussion thread: a DRep's cross-posted vote rationale with Voted Yes and Rationale badges and a frozen notice linking to the on-chain record" width="844" height="290" loading="lazy" /></a>

This one is live too: [read this frozen rationale in its
discussion](https://dreptalk.com/t/withdraw-120-000-000-ada-for-alphagrowth-s-cardano-prime-a59c03bc/?tab=discussion#post-61669166-a308-47dd-bf1b-f53e3daf7f75).

## Votes

The Votes tab lists every DRep and SPO vote on the action, ordered by voting
power, with a toggle to switch between the two bodies. Each row shows the
voter, their vote, and their voting power at the time. Rows with a rationale
expand in place so you can read the reasoning without leaving the page.

Two markers are worth knowing:

- **Changed votes.** While an action is open, a voter can vote again and the
  newer vote replaces the older one. When that happened, the row shows the
  earlier votes too, so vote changes are transparent rather than silent.
- **Not counted.** Votes can technically still be cast after an action is
  ratified, but the tally was frozen at ratification. Late votes appear in
  the list and are marked as not counted in the outcome.

<a href="https://dreptalk.com/t/net-change-limit-cardano-treasury-epochs-613-713-7ac0d510/?tab=positions#voter-drep1y2csyxt7u2hl4674pl9cef5lknafaw5nraxvyx033kmd0es3awuv0"><img class="shot" src="/help/shots/ga-votes.webp" alt="A vote row on the Votes tab, expanded to show the DRep's rationale, with a Changed badge, the superseded earlier vote, and a copy-link button" width="840" height="269" loading="lazy" /></a>

The row above is a real example. [See this vote live on the action's Votes
tab](https://dreptalk.com/t/net-change-limit-cardano-treasury-epochs-613-713-7ac0d510/?tab=positions#voter-drep1y2csyxt7u2hl4674pl9cef5lknafaw5nraxvyx033kmd0es3awuv0),
including the earlier vote it replaced.

Every vote row has a copy-link button, so you can share a link that opens
the page with exactly that vote expanded and highlighted. Votes with a
rationale also have their own shareable page; see [Linking to DReps,
governance actions, and votes](/help/linking/).

## On-chain Data

The On-chain Data tab shows the action's raw on-chain fields: ids, deposit,
return address, anchor URL and hash, and the type-specific values the action
would set. It is the reference tab when you want the exact values rather
than the narrative.

## History

The History tab shows the action's lifecycle as a timeline: when it was
submitted, how support developed over the voting window, and how it ended.
A chart tracks cumulative Yes support per voting body across the window, so
you can see whether an action cleared its threshold early or crossed the
line late. Epochs are shown with their calendar dates.

## Frequently asked questions

### Who can post in the discussion?

Reading is public. Posting requires signing in with an on-chain governance
identity: DRep, proposer or co-proposer, SPO, or Constitutional Committee
member. Delegator sign-ins are read-only. See [Signing in](/help/signing-in/).

### Why is a rationale post marked as frozen?

It is a copy of a rationale committed on-chain with a vote. The on-chain
document cannot change, so the copy cannot be edited. It is replaced or
removed if the DRep re-votes.

### Why is a vote marked as not counted?

It was cast after the action was ratified, when the deciding tally was
already frozen. It is shown for completeness but did not affect the outcome.

### Are the numbers live?

They are synced from the chain on a schedule, usually within minutes, and
each page shows an as-of time. See [Data freshness](/help/data-freshness/).

## Related

- [Governance action types](/help/governance-action-types/)
- [Governance action statuses](/help/governance-statuses/)
- [Sorting governance actions](/help/sorting/)
- [Writing a vote rationale](/help/writing-a-vote-rationale/)
