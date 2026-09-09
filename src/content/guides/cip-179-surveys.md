---
title: "CIP-179 surveys on DRepTalk"
description: "What an on-chain CIP-179 survey is, how it reaches a DRepTalk thread, how a DRep answers one from the wallet they signed in with, and what the participation count does and does not say."
cardLabel: "CIP-179 surveys"
category: "For DReps"
order: 6
faqs:
  - q: "What is a CIP-179 survey?"
    a: "A survey published on the Cardano chain as transaction metadata under label 17, following CIP-179. Its rules live on chain, and so does every answer, so anyone can read and count them without trusting whoever published the survey. Some surveys keep their question texts in a document off chain, and those cannot be answered on DRepTalk."
  - q: "Why do only some surveys appear on DRepTalk?"
    a: "A survey gets a thread here when DReps may answer it, its definition is valid, any encryption it uses can be decrypted, and a governance action DRepTalk has imported carries a valid link to it. That keeps the category tied to the proposals under discussion here instead of listing every survey on the chain."
  - q: "Does DRepTalk show the result of a survey?"
    a: "No. CIP-179 leaves weighting and aggregation out of scope, so whoever counts a survey picks a rule and should say which one. DRepTalk shows how many DRep responses were counted and links to Tessera, where the tally is shown with its counting rule named."
  - q: "What does answering put on chain?"
    a: "Your DRep credential, your role and your answers, permanently. On a sealed survey the answers stay encrypted until the reveal time, but the credential and the role are public from the start."
  - q: "Can I change my answer?"
    a: "Yes. Answer again and the later response replaces the earlier one, so the participation count does not go up. You pay the network fee a second time."
  - q: "Can I answer after the closing epoch?"
    a: "The transaction would still be built and you would still pay the network fee, but a response that arrives after the closing epoch is not counted. Answer while the card still shows the survey as open."
updated: 2026-09-09
---

> Surveys are live on the preprod test deployment only. To see one, open the
> Surveys category on [preprod.dreptalk.com](https://preprod.dreptalk.com/c/surveys/).
> Nothing on this page applies to mainnet yet.

[CIP-179](https://github.com/cardano-foundation/CIPs/tree/master/CIP-0179) puts
surveys and polls on the Cardano chain, as transaction metadata under label 17.
The roles allowed to answer, the closing epoch and the shape of each question
are part of the on-chain record, and answers are sent as transactions too. That
makes a survey readable and countable by anyone, without trusting whoever
published it.

Some surveys keep their question texts in a document off chain and put only a
reference on chain. DRepTalk does not fetch those documents, so such a survey is
listed with a note that its text is not loaded, and it cannot be answered here.

DRepTalk mirrors surveys so a DRep can find and answer one next to the proposal
it belongs to, instead of leaving the site.

## How a survey reaches a thread

Surveys are indexed by [Tessera](https://github.com/mpizenberg/cardano-tessera),
the reference implementation of CIP-179. DRepTalk reads that index every few
minutes and writes down what it finds. A survey gets its own thread here when
four things hold at once: DReps are among the roles allowed to answer it, its
definition is valid, any encryption it uses is one the site can decrypt, and a
governance action DRepTalk has already imported carries a valid link to it.

That last condition is what keeps the category useful. The Surveys category
lists the surveys attached to proposals under discussion here, not every survey
that exists on the chain.

The thread is opened automatically and its first post is written by the system.
The survey card at the top carries the questions, the roles that may answer, the
closing epoch, the linking governance action and a link into Tessera. Below the
card it is an ordinary forum thread. Anyone can read it, and anyone with a
wallet-verified role, so DReps, SPOs, Constitutional Committee members and
proposers, can reply.

## Answering one

You need to be signed in as a DRep, and the wallet you connect has to hold the
same DRep key you signed in with. The panel checks that before it opens the
form, so an answer can never be signed by one DRep and recorded against another.

Answering needs a key credential and a CIP-95 capable wallet. A DRep represented
by a script, which includes a multisig DRep, can sign in and take part in the
discussion but cannot answer a survey here.

DRepTalk assembles the transaction in your browser and hands it to your wallet
to sign and submit. No private key ever reaches the site, and there is no
deposit. You pay the network fee and nothing else. One answer submitted here is
sent as one transaction.

Before the wallet opens, the panel states what signing puts on chain. On an
ordinary survey that is your DRep credential, your role and your answers, all
public and all permanent. On a sealed survey the answers stay encrypted until
the survey's reveal time, but the credential and the role are public from the
moment you submit.

You can answer again while the survey is open. The later response replaces the
earlier one in full, so it does not add to the participation count, and it costs
another network fee.

Answers are accepted through the closing epoch, inclusive. A response that
arrives after that is not counted, although the transaction is still built and
the fee still spent, so answer while the card still shows the survey as open.

Once submitted you get the transaction hash with a link to an explorer. The
participation count on the page does not move on its own. It changes after the
index has seen your transaction and the next mirror run has picked it up, so
reload the page a few minutes later.

## Answering is not voting

A survey answer says nothing about how you vote. It is survey metadata, not a
governance vote, it does not appear on the action's tally, and it neither
replaces nor implies a vote on the linked governance action. Voting is a
separate step, described in [Voting on a governance action](/help/voting/).

## What the count means, and what it does not

The card shows a line such as "3 DRep responses counted". That number comes from
Tessera, and it counts participation, never a result.

While a survey is open the figure is provisional. It counts responses whose
credential proof has not been checked yet, because a proof that is merely
pending must not read as a failed one. Once the survey is finalized the number
comes from the tally artifact instead, which also applies role membership at the
closing epoch, so the final figure can be lower than the one shown while the
survey was running.

DRepTalk renders no result of its own. CIP-179 leaves weighting and aggregation
out of scope, so whoever counts a survey picks a rule, and a chart here would
present one reading as if it were the reading. Tessera's page for a survey shows
an informational tally with its counting rule named, and the survey card links
there.

## The labels on a survey

The badges on the card and in the list say where a survey stands.

- **Open** means answers are still accepted, through the closing epoch.
- **Closed** means the closing epoch has passed. The final count may still be on its way.
- **Cancelled** means the owner withdrew the survey before it closed.
- **Invalid definition** means the index decided the survey cannot be tallied.
- **Sealed** means answers stay encrypted until the reveal time.
- **Unavailable** means the mirror lost the record, see below.

The participation line has its own vocabulary. "Count pending" means a figure is
still expected. "No count" means none is coming, which is the case for a
cancelled survey. "Count unavailable" means the record is gone, so the number
would describe something the index no longer has.

## When a survey disappears

Two things can take a survey off the board. Its own record can roll back, and so
can the governance action that links it. Either way the thread stays, the card
says the record is no longer there, and answering is switched off, because there
is nothing left to answer against.

If the survey turns up again and still meets the conditions above, the card
returns to normal on the next successful mirror run. A survey that still exists
at Tessera but has lost its last valid governance link stays switched off here,
since the link is part of what put it on the board.

## Related

- [Voting on a governance action](/help/voting/)
- [Signing in and the roles](/help/signing-in/)
- [How current the data on this site is](/help/data-freshness/)
- [Understanding a governance action](/help/understanding-a-governance-action/)
