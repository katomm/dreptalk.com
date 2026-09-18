---
title: "CIP-179 surveys on DRepTalk"
description: "What an on-chain CIP-179 survey is, how it reaches a DRepTalk thread, how a DRep answers one from the wallet they signed in with, and what the participation count does and does not say."
cardLabel: "CIP-179 surveys"
category: "For DReps"
order: 6
faqs:
  - q: "What is a CIP-179 survey?"
    a: "A poll published on the Cardano chain. Its rules and every answer are on chain, so anyone can read and count them."
  - q: "Why do only some surveys appear on DRepTalk?"
    a: "Only surveys that DReps may answer and that a governance action discussed here links to get a thread."
  - q: "Does DRepTalk show the result of a survey?"
    a: "No. The survey card shows an informational tally under the generic CIP-179 rules, which is a reading and not a result."
  - q: "What does answering put on chain?"
    a: "Your DRep credential, your role and your answers, publicly and for good. A sealed survey hides the answers until its reveal time."
  - q: "Can I change my answer?"
    a: "Yes, while the survey is open. The new answer replaces the old one and costs another network fee."
  - q: "Can I answer after the closing epoch?"
    a: "No. A late response is not counted, although the network fee is still spent."
updated: 2026-09-18
---

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
The survey card at the top carries the questions and the tally of the responses.
Beside it, a column carries the facts about the survey: where it stands, the
roles that may answer, the closing epoch, the linking governance action and a
link into Tessera. Below the card it is an ordinary forum thread. Anyone can
read it, and anyone with a wallet-verified role, so DReps, SPOs, Constitutional
Committee members, proposers and co-proposers, can reply.

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
figures on the page do not move on their own. They change after the index has
seen your transaction and the next mirror run has picked it up, so reload the
page a few minutes later.

## Answering is not voting

A survey answer says nothing about how you vote. It is survey metadata, not a
governance vote, it does not appear on the action's tally, and it neither
replaces nor implies a vote on the linked governance action. Voting is a
separate step, described in [Voting on a governance action](/help/voting/).

## The informational tally

The survey card draws a tally of the responses it counted. It is a reading, not
a result, and the difference is the whole reason it can be shown at all. CIP-179
deliberately leaves weighting and aggregation out of scope, so whoever counts a
survey picks a rule. A chart with no rule named would present one reading as if
it were the reading, so every share on the card states the denominator it
divides by, and this section names the rule.

The rule is the generic one: the validity rules CIP-179 itself defines, and
nothing beyond them. No survey-specific validity rules, no allow-lists, no
custom weighting. What the answers mean is the survey creator's to say, not this
site's. A reading of the responses is not a decision about them.

Only DRep responses are counted. A survey that other roles may answer too will
say so under the figures, and those responses sit outside every number on the
card.

### Two figures, because they answer different questions

Where a weighting exists, the card puts the DRep voting power behind an option
next to the number of DReps that picked it. Both are shown on purpose. A DRep
whose voting power this site cannot resolve is missing from the weighted figure,
and dropping the head count would make that DRep vanish from their own answer
and reappear as an abstention nobody made. Under the questions the card states
how many of the counted responses it could match to a known voting power, which
is the gap between the two readings.

Bars are shares only where the shares add up to one whole, which is single
choice. On every other question type they compare the options against the
leading one, and the card says so beneath them. A rating question is different
again: its bars sit within the scale the survey declares, and each option is
rated by its own group, so those means are not parts of one whole either.

Responses can be left out of the count, and the card breaks down why: sent after
the deadline, invalid against the definition, credential not proven, replaced by
a later answer, or a sealed answer that did not reveal. The same panel carries
the turnout behind the figures, with both halves of the fraction named.

### Why the figures can still move

While a survey is open, the weighting stands on the newest epoch this site holds
DRep voting power for, not on the epoch the survey closes in. Voting power moves
every epoch, so the figures move with it.

The count is provisional for a second reason. It includes responses whose
credential proof has not been checked yet, because a proof that is merely
pending must not read as a failed one.

Once a survey is finalized and has published a tally artifact, the weighted
figures come from that artifact instead. The artifact also applies role
membership at the closing epoch, so its responder count can be lower than the
figure shown while the survey was running. The two rest on different bases and
need not agree, and the card says which figure came from where.

A sealed survey is a stronger case: its answers are timelock-encrypted, so
nothing can be counted at all until it closes and its artifact is published. The
card says so instead of drawing an empty chart.

[Tessera](https://github.com/mpizenberg/cardano-tessera) shows its own
informational tally of the same survey, counted under its own stated rule, and
the card links there.

## What the participation count means

Where no tally can exist, the card shows a line such as "3 DRep responses
counted" instead. That number comes from Tessera and it counts participation,
never a result. Once the survey is finalized it is the tally artifact's figure,
counted at close.

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
