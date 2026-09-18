---
title: "Citing a post so it stays verifiable"
description: "Posts on DRepTalk have a permanent, verifiable version you can cite in a vote rationale or anywhere else, so the quote cannot silently change later."
cardLabel: "Citing a post"
category: "About DRepTalk"
order: 6
updated: 2026-09-18
faqs:
  - q: "How do I cite a DRepTalk post so the quote cannot change?"
    a: "Use Cite on the post and link a version from its version list. A version's address is derived from its text, so the text behind it never changes."
  - q: "What happens to a citation when the author edits the post?"
    a: "Nothing. The edit becomes a new version next to the one you cited."
  - q: "What does the hash actually prove?"
    a: "That the text matches what was published at that address. It does not prove who wrote it."
  - q: "What happens if a post is deleted?"
    a: "Its versions answer Gone, and the version list notes the deletion without naming the author."
  - q: "Is a deleted post's text really gone?"
    a: "It stops being served at once, and the forum erases its own copy 30 days after the deletion."
  - q: "Why does a citation answer not found instead of Gone?"
    a: "Not found means the post is unavailable for now and may return with the same text. Gone is final."
---

When you quote a forum post in a vote rationale, or link to it from anywhere
off DRepTalk, the quote should still say the same thing next year. Public
posts on DRepTalk get a permanent, verifiable version for exactly that: an
address whose content cannot change underneath it, so the quote you cited
cannot be silently rewritten later. A vote rationale posted through DRepTalk
already has its own permanent document, so it does not get a second one, and
the same is true of the opening post of a governance action, which is the
on-chain text of the action itself.

## Getting a citable link

Open the **Cite** action at the end of a post's action row, after Flag. It
opens the post's version list: a page listing every version of that post,
newest first, each with its own permanent address you can copy. Link to one
version, and the text behind that address stays exactly what it was when you
linked it.

Posts stay quietly editable for a grace window right after posting, and the
Cite action does not appear until that window has closed. A post you just
wrote will not have it yet: it appears a little later on its own, so there
is no need to sit and wait for it.

## What the address proves, and what it does not

The address of a version is derived from its own content, which is what
makes it tamper evident: if the text behind that address were altered, the
address would no longer match it. That is what "verifiable" means here. You,
or anyone else, can fetch the text at that address and confirm it is
unchanged.

What it does not prove is who wrote it. Author identity on DRepTalk is the
account that published the post, the same as any forum, not a cryptographic
signature over the text. If that distinction matters for how you plan to use
a citation, keep it in mind: the address guarantees the words, not the
person behind them.

## Editing does not break a citation

If a post is edited after its grace window, the edit does not touch any
version that already exists. The version you cited stays available exactly
as it was, at the same address. The edit becomes a new version with its own
address, and the post's version list shows every version in order, so a
reader can see what changed and when, right alongside the version you
originally cited.

## When a post is deleted

If a post is later deleted, its versions stop being served: every version
address that used to return the text now answers with a Gone response
instead. The post's version list keeps a minimal record that the post
existed and was deleted, but that record carries no author identity and
none of the original text.

A post can also be withheld from the forum for a time without being deleted,
and while it is, its versions answer "not found" rather than Gone. That is
the difference to read: Gone is final, while a version that answers "not
found" is served again, unchanged and at the same address, if the post
returns.

Being unavailable and being erased are two different moments. The versions
stop being served the moment the post is deleted. The text itself is kept for
30 days after that, so that abuse can still be dealt with, and is erased once
those 30 days have passed, along with every earlier version and the search
entry.

## For developers

Anything that wants to fetch, verify, or mirror these documents can start at
[`/.well-known/cip-100.json`](/.well-known/cip-100.json). It describes the
URL shapes for a single version, a post's version list, and a thread's full
manifest, how to verify a document against its address, and what a deletion
looks like to something mirroring the documents. It is a short pointer, not
a full reference.

One distinction worth knowing before you write a parser: the version itself is
a CIP-100 governance metadata document. The version list and the thread
manifest are not. They are our own JSON-LD, meant for finding and following
documents, and validating them against the CIP-100 schema will report them as
broken when they are simply a different thing.

A deleted version stops being served straight away. Erasing the document
bytes behind its address is a separate step, 30 days later, together with the
rest of the post as described above. Deleting a whole thread erases every
post in it the same way, though the thread's title stays in its address.

## Related

- [Linking to DReps, governance actions, and votes](/help/linking/)
- [Writing a vote rationale](/help/writing-a-vote-rationale/)
- [Open source](/help/open-source/)
