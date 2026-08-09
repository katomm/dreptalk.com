---
title: "Linking to DReps, governance actions, and votes"
description: "How to link to any Cardano DRep, governance action, or individual vote on DRepTalk using plain on-chain ids: no need to know the page's slug, DRepTalk resolves and redirects."
cardLabel: "Linking to pages"
category: "About DRepTalk"
order: 5
updated: 2026-08-02
faqs:
  - q: "How do I link to a governance action without knowing its DRepTalk URL?"
    a: "Put the action's id after dreptalk.com/ga/, for example dreptalk.com/ga/gov_action1xyz. DRepTalk resolves the id and redirects to the action's page. The bech32 gov_action1 form and the hex forms used by explorers both work."
  - q: "How do I link to a DRep profile with just the DRep ID?"
    a: "Use dreptalk.com/dreps/ followed by the drep1 id from any wallet or explorer. If the DRep has a named profile URL, you are redirected there automatically, so the link keeps working."
  - q: "What happens when the id is unknown?"
    a: "You are redirected to search with the id prefilled, so you can see whether it matches anything on the current network."
  - q: "Can I link to one specific vote?"
    a: "Yes. Every vote row on an action's Votes tab has a copy-link button, and votes with a rationale have their own shareable page with a preview card."
---

Pages on DRepTalk have readable URLs, but you never need to know them to
link somewhere. Wherever you have an on-chain id, from a wallet, an
explorer, or a document, you can build a DRepTalk link from it directly and
the site resolves it for you. That makes DRepTalk easy to reference from
forum posts, tweets, rationale documents, or anywhere else ids circulate.

## Governance actions

Append any governance action id to `dreptalk.com/ga/`:

- **The bech32 id**: `dreptalk.com/ga/gov_action1…` This is the standard
  CIP-129 form shown by wallets and explorers, and the form DRepTalk's own
  copy buttons produce.
- **The hex forms**: the 64-character transaction hash of the submission, or
  the hash with the action index appended in hex as some explorers format
  it. Both work after `/ga/` as well.

DRepTalk looks the id up and redirects to the action's page. If the id does
not match an action on the current network, you land on search with the id
prefilled instead of an error page.

## DReps

Append a DRep ID to `dreptalk.com/dreps/`:

- `dreptalk.com/dreps/drep1…`

Every registered DRep has a profile at that address, whether or not they
have ever used DRepTalk. DReps with a display name get a friendlier profile
URL, and the id form then redirects permanently to it, so an id link never
goes stale. You can copy a DRep ID from any wallet, from an explorer, or
with the copy button on the profile itself.

## Individual votes

Sometimes you want to point at one specific vote rather than a whole
action. On an action's **Votes** tab, every row has a copy-link button that
gives you a direct link to that vote. For votes with a rationale, the link
leads to the vote's own page showing the vote, the full rationale, and the
on-chain reference, and it renders a rich preview card when shared on
social platforms and in messengers.

DReps sharing their own votes: this is the best link to circulate when you
explain a decision, since readers see your reasoning first and can delegate
from the same page. More in [Promoting your
DRep](/help/promoting-your-drep/).

## Ids inside posts

The resolver also works in the other direction. When you paste a
`gov_action1…` id into a post or a vote rationale on DRepTalk, it is
rendered as a compact linked chip with a copy button, pointing at the
action's page. You do not need to build a link by hand; the raw id is
enough.

## Sharing previews

DRepTalk pages render rich preview cards when links are shared: governance
actions, DRep profiles, and individual votes each carry their own card with
the key facts. A pasted link in a chat or on social media shows what it
points to before anyone clicks.

## Frequently asked questions

### How do I link to a governance action without knowing its URL?

Put the action's id after `dreptalk.com/ga/`. The bech32 `gov_action1…`
form and the explorer hex forms both resolve and redirect.

### How do I link to a DRep with just the DRep ID?

Use `dreptalk.com/dreps/` plus the `drep1…` id. If the DRep has a named
profile URL, the link redirects there automatically.

### What if the id is not on DRepTalk?

You are redirected to search with the id prefilled. Ids from the other
network (mainnet vs preprod) will not resolve, since each deployment serves
one network.

### Can I link to one specific vote?

Yes: use the copy-link button on the Votes tab, or share the vote's own
page when it has a rationale.

## Related

- [Understanding a governance action page](/help/understanding-a-governance-action/)
- [Promoting your DRep](/help/promoting-your-drep/)
- [Data freshness](/help/data-freshness/)
