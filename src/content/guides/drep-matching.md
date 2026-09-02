---
title: "How DRep matching works on DRepTalk"
description: "The full methodology behind Find your DRep: how questions are selected from completed governance actions, which DReps can appear, how the match score is computed, and why your answers never leave your device."
cardLabel: "How DRep matching works"
category: "Start here"
order: 6
updated: 2026-09-02
---

[Find your DRep](/match/) is a short quiz built entirely from completed
on-chain votes. You answer a set of governance questions, and DRepTalk shows
you a ranked list of DReps whose past votes align with your answers, each
with a link to their written rationale where one exists. This guide explains
exactly how that quiz is built and scored, so you can judge how much weight
to put on the result.

## Your answers never leave your device

Matching runs entirely in your browser. **Your answers never leave your
device.** DRepTalk's server never receives them, and there is nothing to opt
out of because nothing is sent in the first place.

If you share a result link, the answers travel in the URL fragment, the part
after the `#` character. Browsers never send that part of a URL to a server,
so the fragment only ever reaches whoever you hand the link to directly.
Sharing a result link is a deliberate choice: the link itself contains your
answers, so only share it with people you are fine seeing them.

## How questions are selected

The question pool starts from the 100 most recently completed governance
actions that received at least one DRep vote. Completed means voting has
ended, whether the action was ratified, enacted, dropped, expired, or closed. Actions
still in their voting window are never used, since their outcome and vote
counts are not final yet.

From that pool, an action qualifies as a question only if all of the
following hold:

- It has a title.
- It received at least 50 combined Yes and No votes from DReps, counted per
  DRep rather than by voting power, so one large DRep cannot inflate the
  count on their own.
- Fewer than 60 percent of its DRep votes were Abstain. An action where
  almost everyone abstained does not separate DReps from each other, so it
  makes a poor question.

Where a DRep changed their vote on-chain, only their latest vote counts,
both when selecting questions and later when matching.

Each qualifying action gets a score that reflects how evenly its Yes and No
votes were split. Take the difference between the number of Yes votes and
the number of No votes, divide that by the total number of Yes and No votes,
and subtract the result from one. A perfectly even split scores highest,
and a lopsided vote scores lowest. The closer the split, the better the
question separates DReps who agree from DReps who do not.

Questions are ordered by that score, from most evenly split to least. Ties
go to the newer action. To keep the set varied, at most 4 questions may
share the same governance action type. Up to 10 questions make the final
set. If fewer than 5 qualifying actions are available, the quiz shows a
not-enough-data notice instead of a short quiz.

## Which DReps can appear in results

A DRep shows up in your results only if all of the following are true:

- They are currently registered and active.
- Their on-chain metadata includes a public name.
- They have not set the "do not list" flag on their profile.
- Their voting power is between 25,000 and 50 million ada.
- They voted on at least two thirds of the selected questions, which is 7
  out of 10 when the full set is used.

The 50 million ada cap is deliberate. The largest DReps already have
outsized influence and plenty of visibility. Find your DRep is meant to
surface the long tail of smaller DReps whose views you might otherwise never
come across, not to point you toward whoever already holds the most power.

The 25,000 ada floor is the counterpart at the other end. Smaller voting
power ranks first when two DReps tie, so without a floor a DRep with next to
no stake behind them could top the list. The floor keeps the ranking to DReps
that at least some delegators already trust.

## How the match score is computed

Your score with a given DRep is based only on the questions you both
answered. For each shared question:

- You and the DRep took the identical position: 1 point.
- One of you voted Abstain while the other took a firm Yes or No position:
  half a point.
- One of you voted Yes and the other voted No: 0 points.

Your match percent with a DRep is the total points divided by the number of
shared questions. Questions you skipped, and questions the DRep did not
vote on at all, are excluded from that count entirely, they neither help
nor hurt the score.

Each result card prints that division underneath the percent, so 7.5 / 10
reads as seven and a half points across ten shared questions. Because the
denominator is the shared count and not the full question set, two DReps
can land on the same percent from a different number of shared questions:
7.5 out of 10 and 6 out of 8 are both 75 percent.

Two floors apply before a result appears:

- You must answer at least two thirds of the questions, 7 out of 10, to
  get a result at all.
- A DRep must share at least 5 answered questions with you to be ranked, on
  the full set of 10. The floor scales with the set size: two thirds of the
  set, rounded up, minus two, and never below two. A DRep who voted on very
  few of the questions you answered is excluded, since too small a shared set
  makes the percentage unreliable.

When DReps tie on match percent, the one with more shared questions ranks
higher, since their score rests on more evidence. If they are still tied,
the DRep with smaller voting power ranks higher, consistent with the same
long-tail goal behind the 50 million ada cap.

## What the score is not

A match percent measures past voting alignment only. It is not a prediction
of how a DRep will vote in the future, and it is not an endorsement by
DRepTalk of any DRep. All the votes behind it are public on-chain data,
the same votes anyone can look up directly on a DRep's profile.

## Related

- [Find your DRep](/match/)
- [How to delegate to a DRep](/help/delegate-to-a-drep/)
- [Governance action types](/help/governance-action-types/)
