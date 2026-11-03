---
title: "DRep groups: found a group, admit members and manage it together"
description: "How DRep groups work on DRepTalk: open and permissioned groups, founding alone or with other DReps, joining and leaving, approving requests, keeping the management policy in step with the members, signing links, cancelling and dissolving."
cardLabel: "DRep groups"
category: "For DReps"
order: 7
updated: 2026-11-03
faqs:
  - q: "Does a DRep group vote?"
    a: "No. A group records which DReps belong together. Every member votes with their own DRep and their own rationale, and joining or leaving a group changes no delegation."
  - q: "What is the difference between an open and a permissioned group?"
    a: "In an open group membership is self-declared: every registered DRep joins with their own signature. In a permissioned group membership is confirmed by the group: a request stays pending until the admins approve it."
  - q: "Why must every founder sign, even when the threshold is 2 of 3?"
    a: "The protocol requires every key a new group lists as an admin to sign the founding transaction, so nobody can be shown as an admin without having agreed. The threshold applies to every later change."
  - q: "Can I always leave a group?"
    a: "Yes. Leaving needs only your own signature, also in a permissioned group and while your request is still pending."
  - q: "Why should a group update its management policy after admitting members?"
    a: "Approving a member adds them to the member list only. Until the policy is updated, the group stays managed by the keys it had before. DRepTalk offers the update with every approval, for example from 3 of 4 to 4 of 5."
  - q: "What happens when not enough admins sign within 48 hours?"
    a: "Every group transaction is valid for 48 hours. After that it can no longer be submitted, the signing page says so, and the action has to be started again."
  - q: "I retired as a DRep but my key is still in a group policy. Can I still sign?"
    a: "Yes. Sign in with your DRep key as usual. While your key is in a policy of an active group, DRepTalk signs you in as a group signer, which opens group pages and signing links and nothing else."
  - q: "Where can I use DRep groups?"
    a: "On the preprod test network for now, at preprod.dreptalk.com/groups."
---

A DRep group is an on-chain record of which DReps belong together. Every change
to a group is a small transaction with metadata under label 8416, signed by the
DReps it concerns, so any tool can read the same history and check it by the same
rules. DRepTalk builds these transactions for you, collects the signatures and
shows each group with its members, policies and history. DRep groups currently
run on the preprod test network, at
[preprod.dreptalk.com/groups](https://preprod.dreptalk.com/groups/).

## What a group is and what it does not do

A group expresses affiliation. It has a profile (name, description, website,
charter, image), a list of members and one or two policies that say who manages
it. A group never votes and holds no voting power. Each member keeps voting with
their own DRep and their own rationale, delegators keep delegating to individual
DReps, and joining or leaving a group changes no delegation. Where DRepTalk adds
numbers up for a group, it labels them as the voting power of affiliated DReps.

The [group directory](https://preprod.dreptalk.com/groups/) lists groups with at
least two active members, sorted by the voting power of affiliated DReps. A group
with a single member already has its own page, so a founder can share the link
before the second member joins.

## Open and permissioned groups

- **Open group:** membership is self-declared. Every registered DRep joins with
  their own signature and is a member as soon as the transaction is confirmed.
  No admin is involved, and an open group cannot remove anyone.
- **Permissioned group:** membership is confirmed by the group. A join is a
  request that stays pending until the admins approve it. Admins can also
  decline a request.

The mode is chosen at founding and cannot be changed later.

## Who manages a group

A group is managed by a **management policy**: a native script over the DRep
keys of its admins with a threshold, for example **3 of 4**. Any three of the
four admins together can change the profile, change the admins or the
threshold, or dissolve the group. In a permissioned group an **admission
policy** approves and declines requests. By default it is the same policy as
the management policy. As an advanced option, a permissioned group can use a
separate admission policy with its own keys and threshold, for example any two
admins to approve a member and three to change the profile.

Admins are the DRep keys of key-based DReps. When a key is added to a policy,
DRepTalk checks that it belongs to a currently registered DRep. Script DReps can
be members of a group, but not admins.

## Found a group

Sign in as a registered DRep with your DRep key and open
[Found a group](https://preprod.dreptalk.com/groups/new/). The wizard asks how
members join, who founds the group, how many admins must sign, and for the
profile, then shows a review of who has to sign.

- **Found alone:** you are the only admin, the policy is 1 of 1. You sign the
  founding in one wallet step and DRepTalk submits it, no signing link needed.
  In a permissioned group the same transaction also approves your own
  membership. The group grows through admissions, and each admission can bring
  the new member into the policy (see below).
- **Found together:** add the other founders by DRep id. DRepTalk checks that
  each one is a registered key DRep. Then pick the threshold, which starts at
  more than half of the founders. Every founder becomes a member and an admin.

**Every listed key signs the founding, also when the threshold is lower.** With
three founders and a threshold of 2 of 3, all three still sign the founding
transaction. The protocol requires this so that nobody can be listed as an
admin of a group without having agreed to it. The threshold counts for every
change after the founding. Keys of a separate admission policy that are not
founders also sign the founding, without becoming members. After you sign,
DRepTalk gives you a signing link to share with the other founders.

The profile needs a name. Description, website, a link to the group's charter
and an image (JPG or PNG, up to 256 KB) are optional. DRepTalk hosts the
profile document and the founding transaction records its hash, so anyone can
check that the profile shown is the one the group signed.

## Join and leave

Signed-in DReps see **Join** on the page of an open group and **Request to
join** on a permissioned one. A key DRep signs with their wallet and DRepTalk
submits the transaction. A script DRep's own script has to be satisfied, so its
join goes through a signing link for the keys of that script. Your own action
shows as confirming until the chain confirms it, usually a few minutes after it
is about 10 blocks deep.

**Leaving is always possible** with your own signature, also while your request
is still pending and whatever the group's policies say. An admin who leaves
stays in the management policy until the group updates it. When the remaining
admins could no longer reach the threshold without you, the page warns you and
offers to update the policy first. Leaving stays possible either way.

## Approve requests

In a permissioned group, admins see the **Requests to join** on the group page
and get a notification for each new request. Tick one or more requests and use
**Approve** or **Remove** (which declines them). Several requests go into one
transaction. When the admission policy needs more signatures than yours,
DRepTalk gives you a signing link for the other admins.

## Keep the management policy in step with the members

Approving a member adds them to the member list only. The management policy
stays as it was, so without an update a group that has grown to ten members is
still managed by the keys it was founded with. That is why DRepTalk offers, with
every approval of a member who is not yet an admin, to update the management
policy in the same transaction.

The proposal keeps the current admins who are still members, adds the newly
approved members, and carries the ratio of the current threshold forward,
rounded up. You can change the threshold, use **More than half**, or untick
keys, and the form shows the share each choice stands for. When the admission
policy is the same as the management policy, it follows the update.

**Worked example.** Alice, Bob, Carol and Dave manage a permissioned group with
**3 of 4** (75%). Erin requests to join. Bob ticks her request, keeps the policy
update ticked and sees the proposal: Alice, Bob, Carol, Dave and Erin with a
threshold of 5 × 3 / 4 = 3.75, rounded up to **4 of 5** (80%). The signing page
then lists two lines: approve Erin, and change the management to 4 of 5 with
the five names.

Who signs that transaction:

- three of Alice, Bob, Carol and Dave, which satisfies the current 3 of 4 for
  both the approval and the update,
- and Erin, because every key an update newly lists has to sign it.

The approval comes first in the transaction, so it is checked against the
policy in force before the update. The next admission would propose 5 of 6,
then 6 of 7. Rounding up can raise the share over time, so check the number
before you continue.

You can untick the update and approve alone. The policy then stays as it was,
and the group page shows a notice to members and admins in permissioned groups:
"The group is still managed by: Alice, Bob, Carol, Dave. Members not in the
policy: Erin." Its **Update the policy** button starts an update with every
active key DRep member, at the carried ratio. Untick members who cannot sign
right now, they stay out of this update. Each member who is newly listed has to
sign. Open groups get no such notice, since anyone can join them and their
members and admins differ by design.

## Signing links

When an action needs more than your own signature, DRepTalk builds the
transaction in your browser, your wallet pays the fee and signs the fee input,
and the transaction gets a signing link. Share it with the other signers.
Signers with a DRepTalk account also get a notification.

- Only keys that may sign this action can open the link.
- The page shows what the transaction does in plain words, read from the
  transaction itself, never from a description by the person who started it.
- **Must sign** lists every key that has to sign, with who has signed so far.
- Sign with your wallet, or sign the transaction body hash offline with
  `cardano-signer` and paste its output.
- Once every required signature is there, any signer can submit. The page then
  shows the transaction as confirming and, after the chain confirms it, whether
  the change took effect, took effect in part, or was not accepted by the group
  rules.

A group has at most one open management action at a time: a change of the
profile, the admins or the threshold, a dissolution, or an approval combined
with a policy update. While one is open, the others show a note and a link to
it. Joins, leaves, plain approvals and declines are not limited.

## When the majority does not sign in 48 hours

Every group transaction DRepTalk builds is valid for **48 hours**. If the
required signatures are not all collected in that time, the transaction can no
longer be submitted. Once the chain is safely past that point, the signing page
says the transaction never reached the chain, the group's management slot is
free again, and you start the action again if you still want it.

An open management action also becomes invalid when another management change
of the same group is confirmed first, since every management change counts the
group's changes and an action built against an older count is rejected. Start
it again from the current state.

## Cancel, and cancel for real

The person who started an action can **cancel the signing link**. That stops
the link on DRepTalk. Signatures that were already handed out stay usable until
the 48 hours have passed, so someone holding a fully signed copy could still
submit it. For that reason a cancelled management action keeps the group's
slot until it expires.

To make the transaction unusable for good, the signing page then offers
**Cancel for real** to the person who started it. Their wallet sends the fee input back to their own address, for a
small network fee. A transaction whose input is spent can never be included, and the
slot is freed once DRepTalk sees the input spent on chain.

## Dissolve a group

Admins dissolve a group from **Manage the group** on the group page. Dissolving
is a management action, so the management policy has to be satisfied, and the
page asks for an explicit confirmation. It cannot be undone. Every membership
closes, members' delegations do not change, and the group page with its history
stays readable.

## Retired admins: the group signer login

A key stays in a group policy when its DRep retires or becomes inactive, and it
can still sign for the group. The normal DRep sign-in refuses retired and
inactive DReps, so DRepTalk signs such a key in as a **group signer** while it
is in a policy of an active group. That login opens group pages and signing
links where the key is needed, and grants no other DRep rights. The group can
then update its policy to keys of active members.

## Notifications

Under **DRep groups** in your notification settings, DRepTalk sends join
requests to the admins in a group's admission policy and signature requests to
every selected signer except the person who started the action, by browser push
or Telegram. The setting is on by default.

## Related

- [Managing your DRep](/help/managing-your-drep/)
- [Signing in](/help/signing-in/)
- [Data freshness](/help/data-freshness/)
