---
title: "Get feedback on a Cardano governance proposal before you submit it"
description: "Share a draft governance action with DReps on DRepTalk, collect feedback before you pay the deposit, and connect the draft to the on-chain vote once you submit."
cardLabel: "Feedback on a proposal"
category: "Understanding governance"
order: 6
updated: 2026-09-18
faqs:
  - q: "Can I get feedback on a Cardano governance action before I submit it?"
    a: "Yes. Open a thread in Proposal Drafts on DRepTalk and describe what you plan to submit. DReps, SPOs and Constitutional Committee members can reply before anything is on-chain."
  - q: "Who can open a proposal draft?"
    a: "Anyone signed in with an on-chain governance role: a DRep, an SPO, a Constitutional Committee member, a proposer who has submitted a governance action before, or a co-proposer that proposer has authorized. Everyone can read drafts."
  - q: "How do I connect my draft to the governance action?"
    a: "Before you submit, add the link to your draft thread to body.references in the action's metadata document, early in the list. Once the action is on-chain and its metadata document can be read, DRepTalk connects both threads."
  - q: "What happens to the draft once it is connected?"
    a: "Once DRepTalk connects the action to your draft, the draft closes and points to the governance action's thread, where the discussion and the vote continue. The draft stays readable as it was."
  - q: "What if someone else links my draft?"
    a: "As the draft's author you see an Unlink button next to each connected action. Unlinking detaches that action for good, and the draft reopens once no connected action remains."
---

A governance action is hard to change once it is on-chain. The metadata is
fixed, the deposit (100,000 ada on mainnet) is locked until the action is
enacted, expires or is dropped, and DReps can only vote Yes, No or Abstain. The best time to hear
what they think is before you submit.

[Proposal Drafts](/c/proposal-drafts/) is the place for that. You describe the
action you plan to submit, DReps and other governance participants reply, and
you refine the proposal before it goes on-chain.

## Open a draft

1. Sign in with your governance role. Drafts can be opened by DReps, SPOs,
   Constitutional Committee members, proposers who have submitted an action
   before, and [co-proposers](/help/proposers/) they have authorized. See
   [Signing in](/help/signing-in/).
2. Go to [Proposal Drafts](/c/proposal-drafts/) and start a new thread.
3. The editor starts with a short outline: summary, action type, requested
   amount for treasury withdrawals, motivation and planned submission. Fill
   in what applies and delete the rest.

Drafts are public. Anyone can read them, and anyone with a governance role can
reply. Not sure which action type fits? See
[Governance action types](/help/governance-action-types/).

## What makes a draft useful

- **Say what you will actually submit.** The action type, the amount and the
  recipient for a treasury withdrawal, the parameter and its new value for a
  parameter change.
- **Explain why now.** DReps weigh a proposal against the budget, the
  Constitution and other open actions.
- **Name a submission date.** Replies come faster when people know how long
  the draft is open for.
- **Update the opening post** as the proposal changes, so a late reader sees
  the current version first.

## Connect the draft to your governance action

When you are ready to submit, add the link to your draft thread to the
references of the action's metadata document. They sit inside `body`, as
CIP-108 describes, next to the title, abstract and rationale:

```json
{
  "body": {
    "title": "...",
    "abstract": "...",
    "references": [
      {
        "@type": "Other",
        "label": "Discussion draft on DRepTalk",
        "uri": "https://dreptalk.com/t/your-draft-thread/"
      }
    ]
  }
}
```

Put the draft link early in the list. DRepTalk reads up to 20 references per
action, so a link further down is not seen.

Your draft shows its exact link with a copy button while you are signed in.
Use that link as it is: a draft on the preprod test network has a
`preprod.dreptalk.com` address and connects only to preprod actions.

Once the action is on-chain, DRepTalk opens its
[governance thread](/help/understanding-a-governance-action/), usually within
a few minutes, and connects it to your draft. That needs a metadata document
DRepTalk can read and verify. If it cannot be read yet, the thread waits for it.
Once connected:

- the draft shows **Now on-chain** with a link to the governance thread,
- the governance thread shows **Discussed as a draft** in its sidebar,
- the draft closes for new replies and edits, so it stays a record of what was
  discussed before submission.

If you submit the same proposal again later, for example after it expired,
reference the same draft. Both actions appear on it.

## If someone else links your draft

The references are free text, so anyone can put your draft's link into their
own action. As the draft's author you see **Not your action? Unlink** next to
each connected action. Unlinking detaches that action permanently, and the
draft reopens once no connected action remains. Moderators can do the same.

## Frequently asked questions

**Can I get feedback on a Cardano governance action before I submit it?**
Yes. Open a thread in Proposal Drafts and describe what you plan to submit.
DReps, SPOs and Constitutional Committee members can reply before anything is
on-chain.

**Who can open a proposal draft?**
Anyone signed in with an on-chain governance role: a DRep, an SPO, a
Constitutional Committee member, a proposer who has submitted a governance
action before, or a co-proposer that proposer has authorized. Everyone can
read drafts.

**How do I connect my draft to the governance action?**
Before you submit, add the link to your draft thread to `body.references` in
the action's metadata document, early in the list. Once the action is on-chain
and its metadata document can be read, DRepTalk connects both threads.

**What happens to the draft once it is connected?**
The draft closes and points to the governance action's thread, where the
discussion and the vote continue. The draft stays readable as it was.

**What if someone else links my draft?**
As the draft's author you see an Unlink button next to each connected action.
Unlinking detaches that action for good, and the draft reopens once no
connected action remains.

## Related guides

- [Proposers of Cardano governance actions](/help/proposers/)
- [Governance action types](/help/governance-action-types/)
- [Understanding a governance action](/help/understanding-a-governance-action/)
