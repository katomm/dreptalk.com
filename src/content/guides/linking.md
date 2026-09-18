---
title: "Linking to DReps, governance actions, and votes"
description: "How to link to any Cardano DRep, governance action, or individual vote on DRepTalk using plain on-chain ids: no need to know the page's slug, DRepTalk resolves and redirects."
cardLabel: "Linking to pages"
category: "About DRepTalk"
order: 5
updated: 2026-09-18
faqs:
  - q: "How do I link to a governance action without knowing its DRepTalk URL?"
    a: "Put the action id after `dreptalk.com/ga/`, in bech32 or hex form, and DRepTalk redirects to its page."
  - q: "How do I link to a DRep profile with just the DRep ID?"
    a: "Use `dreptalk.com/dreps/` plus the `drep1` id. It redirects to the DRep's named profile URL if there is one."
  - q: "What happens when the id is unknown?"
    a: "DRepTalk opens search with the id filled in."
  - q: "Can I link to one specific vote?"
    a: "Yes, with the copy-link button in an expanded row on the Votes tab. Votes with a rationale also have their own page."
  - q: "Can another site link to the discussion for every governance action?"
    a: "Yes. Build `dreptalk.com/ga/` plus the action id, with no key and no lookup. Until the discussion page opens, the link leads to search."
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
not match an action on the current network, DRepTalk opens search with the id
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
action. On an action's **Votes** tab, rows with a rationale or a vote
history expand, and the expanded part has a copy-link button that gives you
a direct link to that vote. Rows without either do not expand and have no
copy-link button. For votes with a rationale, the link
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
action's page. The hex forms work too: the 64-character transaction hash
with `#` and the action index, and the CIP-129 hex form. You do not need to
build a link by hand, the raw id is enough.

Other ids get the same treatment. A `drep1…` or `drep_script1…` id links
to the DRep's profile, and an `addr1…` (or `addr_test1…` on preprod)
payment address links out to the address page on the Cardano explorer.

## Sharing previews

DRepTalk pages render rich preview cards when links are shared: governance
actions, DRep profiles, and individual votes each carry their own card with
the key facts. A pasted link in a chat or on social media shows what it
points to before anyone clicks.

## Linking from another site

Explorers, wallets, and governance dashboards can point their own pages at
the matching DRepTalk discussion without asking us for anything first. There
is no API key, no registration, and no lookup step: the address is built from
the action id your page already has.

`dreptalk.com/ga/` plus the id is the whole integration. Either id form
works, so whichever one your site already stores is fine.

Two properties make this safe to render unconditionally:

- **Every governance action has a discussion page.** The page opens within
  minutes of the action appearing on chain, once its proposal document can be
  read, not when someone first writes a comment. Until then the link leads to
  search. A link built from any valid action id always leads somewhere, so you
  never need to check first whether a discussion exists.
- **Unknown ids do not break.** An id that does not resolve opens search
  with the id prefilled instead of an error page.

Each deployment serves one network, so use ids from the network that
deployment covers.

A plain link like this is enough when a click is all you need. If your tool
instead needs to quote a post's exact words in a way that stays verifiable
even after the post is edited, see [Citing a post](/help/citing-a-post/):
every public post has its own permanent, content-addressed version for that.

If you want a logo or a badge to go with the link, the [brand
page](/brand/) has ready-made snippets and the colors and marks to use.

## Related

- [Understanding a governance action page](/help/understanding-a-governance-action/)
- [Promoting your DRep](/help/promoting-your-drep/)
- [Citing a post](/help/citing-a-post/)
- [Data freshness](/help/data-freshness/)
