---
title: "The Governance Review"
description: "What the Governance Review is: a written edition per epoch window on what Cardano governance decided, what moved, and what is still open, with every figure traceable to a frozen snapshot."
cardLabel: "Governance Review"
category: "Understanding governance"
order: 93
updated: 2026-09-14
faqs:
  - q: "What is the Governance Review?"
    a: "A written edition covering a few epochs of Cardano governance at a time: the actions that were decided, the voting behind them, and the shifts in delegated power. It reads the same on-chain data as the analytics pages, but as an article about one window rather than a live dashboard."
  - q: "Can I check a figure myself?"
    a: "Yes. Every edition links the exact snapshot it was written from, a pack.json file stored next to the article, and every number in the text traces to a field in that file. The link is pinned by the file's content hash, so it resolves to those exact bytes whatever happens to the repository later."
  - q: "Does a correction change the numbers?"
    a: "No. A correction edits the article's wording and is listed with its date at the top of the edition. The data snapshot is frozen at publication and is never rewritten, so a corrected edition still rests on the figures it was published with."
  - q: "Why does an action appear as still open in one edition and decided in the next?"
    a: "An edition reports its window and nothing after it. An action whose voting ran past the window's last epoch is listed as open with its tally as of the window's close, and what became of it is settled in a later edition."
  - q: "Is the Governance Review available on preprod?"
    a: "No. Editions are written from mainnet facts, so they are published on mainnet only. The preprod mirror has no editions."
  - q: "Does DRepTalk take a position in an edition?"
    a: "No. An edition reports what was decided and what the figures say. It does not argue for an outcome, recommend a vote, or tell you who to delegate to."
---

The [Governance Review](/governance-review/) is a written edition covering a few
epochs of Cardano governance at a time: what was decided, the voting behind it,
and what is still open. Where the [analytics pages](/help/governance-analytics/)
show the numbers as they stand right now, an edition takes one window, fixes the
figures for it, and explains what happened in it.

Editions appear when a window is complete and its data is settled, not on a fixed
publishing day. The newest one leads the overview page and the older ones follow
below it.

## What is in an edition

Every edition follows the same shape.

- **A standfirst.** Two or three sentences naming what the window turned on, before any figure.
- **A strip of headline figures.** Each one carries a label saying what it measures, and each traces to a field in the snapshot below.
- **The article.** Prose with charts drawn from the window's own data. The charts carry captions saying what the shape means, not just what it is.
- **Also decided, and still open.** Two tables of the actions in the window, with the type, the outcome and the DRep approval each one reached. An action still being voted on shows its tally as of the window's close.
- **The numbers behind the window.** Delegated power and treasury at both ends of the window, votes cast, and the DReps whose final ballot fell inside it. Underneath sits a list of what those figures do not cover.
- **The data note.** The snapshot the edition was written from, linked twice, once readably and once pinned by content hash.

## Every figure is checkable

An edition is written from a snapshot of the site's governance data taken at a
single moment, which is stored as a `pack.json` file next to the article and
named in the data note at the bottom. Every number in the text comes from a field
in that file. Nothing is typed in by hand and nothing is estimated.

The data note links that file twice. The plain link opens it in the repository,
which is the readable version. The second link is the file's git blob hash, which
is derived from the bytes themselves, so it resolves to exactly the snapshot the
edition was written from even if the repository moves on. That is what lets you
check a figure years later and know you are checking the same data.

## The limits are stated, not implied

Under the numbers block each edition lists what its figures do not cover. These
are specific to the window, and they are written because a number without its
boundary is misleading. Typical entries say that votes cast counts every ballot
including the ones later superseded, that a lowest or highest reading is bounded
by how far this record goes back, or that a particular protocol parameter is
absent from the snapshot and therefore not stated.

An edition would rather say that it cannot answer something than answer it
loosely.

## Corrections

If an edition is corrected after publication, the correction is listed with its
date at the top of the article and stays there. Corrections change the wording,
never the data: the snapshot is frozen at publication, so a corrected edition
still rests on exactly the figures it was published with. Where a correction did
touch a figure, the note says so.

## What it is not

An edition reports. It does not argue for an outcome, recommend how to vote, or
suggest a DRep to delegate to. Where a vote was close or a result is contested,
it says so and gives the numbers on both sides.

It is also not a forecast. An action whose voting window ran past the edition's
last epoch is reported as open, with its tally as of the window's close, and what
became of it belongs to a later edition.

## Mainnet only

Editions are written from mainnet facts and are published on mainnet only. The
preprod mirror carries no editions.

## Related

- [Understanding the analytics page](/help/governance-analytics/)
- [Governance action statuses](/help/governance-statuses/)
- [Understanding a governance action](/help/understanding-a-governance-action/)
- [How current the data on this site is](/help/data-freshness/)
