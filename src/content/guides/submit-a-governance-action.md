---
title: "Submit a Cardano governance action on DRepTalk"
description: "How to put a Cardano governance action on-chain with DRepTalk: pick the action type, write the metadata, review it, and sign with your wallet. Covers the deposit, the refund and treasury withdrawals."
cardLabel: "Submit a governance action"
category: "Understanding governance"
order: 7
updated: 2026-10-07
faqs:
  - q: "Who can submit a governance action on DRepTalk?"
    a: "Anyone who is signed in. You do not need to be a DRep, an SPO or a committee member. Any ada holder can propose a governance action on Cardano."
  - q: "How much is the deposit for a Cardano governance action?"
    a: "100,000 ada on mainnet and 1,000 tADA on preprod. DRepTalk reads the current amount from the chain and shows it before you sign."
  - q: "Do I get the deposit back?"
    a: "Yes. The deposit goes back to the reward address of the wallet that submitted the action once the action is enacted, expires or is dropped."
  - q: "Do I need a wallet to write a governance action?"
    a: "No. You can fill in the form, save it as a draft and review it without a wallet. You only connect a wallet in the last step, to pay the deposit and sign."
  - q: "Which governance actions can I submit?"
    a: "Info actions, motions of no confidence, hard fork initiations, new constitutions, committee updates and, on preprod, treasury withdrawals and staking parameter changes. Parameter changes beyond the five staking parameters are not offered yet."
  - q: "Why does a treasury withdrawal need my stake address to be registered?"
    a: "The ledger only pays treasury withdrawals to registered stake addresses. DRepTalk checks every recipient before you sign, so the transaction does not fail on-chain."
  - q: "Can I change a governance action after I submit it?"
    a: "No. Once it is on-chain, the action and its metadata are fixed. Collect feedback in Proposal Drafts first."
---

A governance action is the way to put a proposal in front of Cardano's DReps,
SPOs and the Constitutional Committee. DRepTalk can build and submit one for you.
You write the action in a form, see it the way the action page will show it,
and sign it with your wallet.

Submitting is open on preprod at
[preprod.dreptalk.com](https://preprod.dreptalk.com/ga/new) and comes to
mainnet soon. The page is marked **Beta**.

## Before you start

- **Sign in.** Any signed-in account can submit, whatever its role. See
  [Signing in](/help/signing-in/).
- **Get feedback first.** An action cannot be changed once it is on-chain.
  [Get feedback on a proposal](/help/get-feedback-on-a-proposal/) explains how
  to discuss a draft in Proposal Drafts before you pay the deposit.
- **Have the deposit ready.** The wallet that signs pays the deposit: 100,000
  ada on mainnet, 1,000 tADA on preprod, plus a small transaction fee. Its stake
  address has to be registered, because that is where the deposit goes back to.

## Submit an action step by step

Open **Submit action** from the account menu, or the **Submit a governance
action** card on your home page.

1. **Pick the action type.** Each card says what the action does and who votes
   on it. [Governance action types](/help/governance-action-types/) explains
   them in detail.
2. **Fill in the type's details.** A motion of no confidence, a hard fork, a
   new constitution and a committee update each build on the last action of
   their kind, and DRepTalk fills in that previous action for you. A hard fork
   asks for the protocol version, a new constitution for the constitution
   document, a committee update for the members and the quorum, a treasury
   withdrawal for its recipients, and a parameter change for the new values.
3. **Write the metadata.** Every action carries a title (up to 80 characters),
   an abstract, a motivation and a rationale, plus up to ten references. Link
   your Proposal Drafts thread with **Link a Proposal Draft**, so DRepTalk
   connects the draft to the action once it is on-chain.
4. **Sign as author.** This is on by default. Your wallet signs the metadata,
   which makes your authorship verifiable. Enter the name you want to appear
   as the author, or turn it off to publish without an author.
5. **Review.** **Review** shows the action exactly as its page on DRepTalk will
   render it. Check the text, the links and the on-chain changes.
6. **Sign and submit.** Pick your wallet and connect it. DRepTalk shows the
   deposit next to your wallet's balance. Then it publishes the metadata on
   IPFS, checks that the published file matches its hash, builds the
   transaction and asks your wallet to sign it.

Your form is saved in your browser as you type, so you can leave and come back.
The saved draft never contains wallet data.

## Treasury withdrawals

A treasury withdrawal pays ada from the Cardano treasury to one or more stake
addresses. On DRepTalk it is available on preprod for now.

- Add up to 20 recipients, each with a stake address and an amount in tADA. The
  form shows the exact total.
- Every recipient must be a registered stake address. DRepTalk checks them while
  you type and again right before you sign.
- **Add my wallet's stake address** puts your own stake address into the list.
  If no wallet is connected yet, **Connect wallet and add my stake address**
  connects it for you.
- The constitution's guardrails script checks every treasury withdrawal. DRepTalk
  runs that check before your wallet signs. If the script rejects the
  withdrawal, nothing is signed and the page tells you why.
- The transaction needs about 5 ada in plain ada UTxOs as collateral. It is only
  spent if the script check fails on-chain, which the check before signing is
  there to prevent.

## Protocol parameter changes

A parameter change sets new values for the staking parameters that shape pool
rewards. On DRepTalk it is available on preprod for now.

- Pick any of five parameters, and several can go into one action: the target
  number of pools (k), the pledge influence (a0), the minimum pool cost, the
  monetary expansion (rho) and the treasury cut (tau).
- The form shows each parameter's current value and the range the constitution
  allows. It blocks values outside that range and values equal to the current one.
- Impact panels show what the new values would do: the saturation point and the
  pools above it, the maximum pool rewards by stake and pledge, the pools below a
  new minimum cost, and how the reserve draw splits between the treasury and
  stakers. They are a model at full block production and before fees, so read
  them as an estimate.
- DReps and the Constitutional Committee decide these changes. Stake pools do
  not vote on these five parameters.
- The constitution's guardrails script checks every parameter change. DRepTalk
  runs that check before your wallet signs. If the script rejects the change,
  nothing is signed and the page tells you why.
- **Add the changes to the abstract** is an optional button that adds a
  "Changes" paragraph with the old and new values to your abstract.

## After you submit

DRepTalk shows the transaction hash. Once the transaction is in a block, the
action gets its own page on DRepTalk with a discussion thread, the votes as they
come in, and its status. [Understanding a governance action](/help/understanding-a-governance-action/)
explains that page.

An action stays open for voting for a limited number of epochs. It is enacted
if the required bodies ratify it in time, and it expires otherwise. Either way
the deposit returns to the reward address that submitted it.

## When something goes wrong

- **"The guardrails script could not be checked."** DRepTalk could not confirm
  which guardrails script the constitution currently uses. Nothing was published
  or signed. Try again later.
- **"This stake address is not registered."** The recipient cannot receive a
  treasury withdrawal. Ask them to register their stake address first, or remove
  the row.
- **"Your wallet needs about 5 ada in plain-ada UTxOs that can serve as
  collateral."** Send about 5 ada to your wallet as a separate payment and try
  again.
- **Not enough funds.** The wallet holds less than the deposit plus the fee. The
  page tells you how much is missing.
