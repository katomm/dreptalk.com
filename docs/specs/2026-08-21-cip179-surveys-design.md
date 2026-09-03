# CIP-179 surveys in DRepTalk

> **Status: as-built summary, for review** (thread: katomm/dreptalk.com#379;
> began as the design under discussion there, rewritten once the code
> existed). The README's architecture/feature update, the
> `docs/deployment.md` correction and the deletion of this document are
> deliberately the branch's **last commit, after the review is validated** —
> a review that notes the README unchanged is reading the branch mid-flight,
> not finding an oversight.

## 1. Why

[CIP-179](https://github.com/cardano-foundation/CIPs/tree/master/CIP-0179)
puts surveys and polls in transaction metadata under label 17. Tessera is
the reference implementation: a browser app plus a serving backend that
scans the label, validates responses and finalizes results.

Ownership split (agreed in #379): **Tessera owns the protocol behind its
HTTP API**; **DRepTalk owns wallet, transaction building, forum and
presentation**. DRepTalk implements no CIP-179 rule of its own — parsing,
lifecycle and counting all come from Tessera's published packages
(`fromJsonSafe`, `aggregate()`, `auditResponses()`); its API is mirrored
into D1 the way Koios is.

What this buys DRepTalk: when a governance action under discussion links a
survey, the DReps already debating that action can find it, answer it from
the thread with the wallet they are signed in with, and watch the answer
come back through the index — without leaving the site or trusting it with
any counting.

## 2. Scope and non-goals

**In:** preprod only. gov-sync mirrors admitted surveys into D1; one
auto-opened thread per admitted survey in a read-only `surveys` category;
governance linkage rendered in both directions; DRep-only answering via
`<tessera-respond>` with DRepTalk building, signing and submitting the
transaction; an optimistic local record until the index confirms.

**Out, deliberately:**

- Mainnet and Preview. The category ships everywhere and renders an
  explicit "not indexed on this network" state where the switch is off.
- Results rendering, interim or final. CIP-179 does not mandate a tally;
  the survey maker owns the counting policy. The card shows the audited
  DRep participation count and a deep link — no figure as "the result".
  Named follow-up: a live *weighted* estimate for DRep questions (DRepTalk
  already syncs per-epoch DRep voting power; Tessera's tally math takes
  weights as inputs).
- A nav link and activity-feed events (both would show on mainnet with the
  feature off; both are one-line additions later), creating surveys, roles
  other than DRep, the artifact routes, sealed surveys as a *tested* path.

## 3. Architecture as built

```
Tessera preprod backend
  GET /api/surveys?filter=linked&…   discover: records, govLinks, counts, tip
  GET /api/surveys?refs=…            refresh held not-yet-final surveys
  GET /api/surveys/{tx}/{i}          bundle: responses + verdicts → audited count
  GET /api/responses/{txHash}        settle pending local rows by exact tx
  GET /health                        network guard
        │   server-side only, from gov-sync; never from a page request or the browser
        ▼
gov-sync worker  (*/5 cron; `surveys` + `survey-reconcile` phase entries)
        │        writes D1: survey, survey_gov_link, topics + posts; settles
        ▼        survey_response_local
app worker (Astro SSR)   reads D1 only, with an "as of" time — the same
        ▼                invariant every other on-chain value obeys
browser: bundled client script → <tessera-respond> → RespondResult
        ▼
DRepTalk's own transaction path (evolution-sdk + CIP-30/95 wallet) → chain
        ▼
POST /api/survey/response/record → survey_response_local until the sync settles it
```

Nothing reaches Tessera from the browser (CSP `connect-src` blocks it; no
proxy route) and nothing from a page request.

**Feature switch.** The mirror and the answer path exist iff
`TESSERA_BACKEND_URL` is set — preprod only today — and the client refuses
a backend whose `/health` network differs from `CARDANO_NETWORK`.
`TESSERA_APP_URL` (optional, display-only) feeds the card's deep link.

**Schema** (`0091_surveys.sql`): `survey` (one row per admitted survey;
`counted_dreps` is the audited display count, `claimed_count` the list's
raw change-detector, `final_state` NULL until decided for good,
`unavailable` marks an upstream rollback), `survey_gov_link`,
`survey_response_local` (the optimistic rows), `survey_sync_state` (one
row: linked-set size, last complete walk, audit bookkeeping).

**The sync**, four passes inside the `surveys` phase:

1. **Discover.** Page one of `?filter=linked` covers the whole linked set
   while it fits one page; the walk goes deeper only when the set size
   moved, this run imported new governance actions, or on a daily
   backstop. A page answering from an older snapshot (`resync`) restarts
   the walk; only a walk that completed within one generation stamps the
   set size and walk time. Admission — DRep-eligible *and* linked by an
   imported action — creates the survey row, its topic and its gov links
   in one batch.
2. **Refresh held.** Every held row with NULL `final_state`, by `?refs=`
   in chunks of 200. A ref absent from a *complete* answer is rolled back:
   `unavailable` hides answering and erases the row's gov links (erasure
   is the contract — a rolled-back action must take its link down), but
   keeps the thread; the row stays in this set for 4 days because
   Tessera's settlement window can bring the transaction back, then
   retires. From an `incomplete` answer, absence proves nothing.
3. **Audit counts.** Triggered by a count change, the tip crossing
   `end_epoch`, `final_state` landing, reappearance after `unavailable`,
   or a daily re-audit (a verdict can flip without the count moving):
   fetch the bundle (paginated, restarting on generation changes), run
   Tessera's `auditResponses`, store the counted-DRep figure. Capped at
   20 rows per run; a bundle failure backs the row off exponentially
   (5 min → 24 h) and only a *decided* row's audit is ever conceded.
4. **Settle.** `GET /api/responses/{txHash}` per pending optimistic row
   (oldest-first, 50 per run, failures isolated per transaction) deletes
   the row once the exact transaction names a response for the survey —
   which is what makes a *replacement* observable.

A separate **`survey-reconcile` phase**, never gated by the feature
switch, ages optimistic rows still `pending` after 6 h to `failed`
(`PENDING_VOTE_TTL_SEC`, shared with the vote lifecycle), so "confirming…"
cannot outlive a Tessera outage or the switch being turned off.

**Answering.** `RespondPanel.astro` renders `<tessera-respond>` for a
`drep` session on a DRep-eligible, open, available survey (bundled sibling
script, so the CSP hash is automatic). On `tessera:response` the existing
transaction path attaches the widget's payload at label 17 via the
published `toTxMetadatum` and adds the DRep key hash to
`required_signers` — proof mechanism A; the CIP-20 note rides at label 674
as on votes. `POST /api/survey/response/record` then writes the optimistic
row with a credential derived from the *session*, never the client; script
DReps get a 403 (no key witness could ever settle such a row). The card
overlays *Your answer · confirming…* until pass 4 or the reconcile phase
resolves it.

**Freshness.** Surveys have a row in `src/lib/freshness.ts` and the
`data-freshness` guide; the existing drift test holds the pair together.

**Packages:** `cip-179` 0.3.0 and `cardano-tessera-respond` 0.1.3
(pinned), both Tessera's published code.

## 4. Decisions

- **Admission is gated, and the MVP implements one of the three agreed
  gates.** The policy (maintainer, #379) admits a survey when any one
  holds: (1) authored through DRepTalk by a verified writer — DRep, SPO,
  Proposer or CC member — with the definition transaction confirmed on
  chain; (2) linked by an imported governance action; (3) explicitly
  imported by a verified writer who separately proves control of the
  survey's owner credential. Only gate 2 can fire before authoring
  exists, so the MVP ships it alone, narrowed to DRep-eligible surveys —
  a starting point, not the settled policy; gates 1 and 3 are deferred,
  not dropped, and the role axis widens with them. The gate is editorial
  policy, so the data model does not encode it — widening is one
  predicate.
- **Each admitted survey is a thread in its own category**, not a card on
  the linking action's thread: links are N-to-1, so a card has no
  canonical home and `/s/<ref>` no single destination; and admission is
  policy that will move — a category survives any widening.
- **The displayed count is the audited DRep count, from the bundle**
  (maintainer's review). The list's `responseCounts` filters nothing and
  sums across roles; `auditResponses` is Tessera's ruleset-pinned
  counting, so no second CIP-179 implementation appears.
- **A held survey refreshes until `final_state`, never freezing at
  close** — verdicts land after the deadline, so freezing at close would
  pin whatever snapshot the deadline landed on.
- **A ref missing from a complete snapshot means rolled back**, and the
  link rewrite stands unguarded: erasure is part of the contract.
- **The audit schedule follows the row's held/retired lifecycle** rather
  than a bundle 404 being read as "gone for good" (PR review). The
  narrower fix — reappearance as the only re-trigger — fails when an
  `incomplete` refs answer hides the rollback, so both landed: back off
  and retire, *and* re-arm on reappearance.
- **Pending rows settle by exact transaction and age to `failed`** — the
  GA-vote lifecycle DRepTalk already runs; `/api/responded` is
  replacement-blind. Ageing is its own ungated phase (PR review) because
  any cleanup inside `syncSurveys` still sits under the feature switch.
- **`CategoryKind` and `topics.source` each gain `'survey'`** rather than
  reusing `'governance'` or `'discussion'`: consumers branching on those
  values must not answer questions about surveys nobody asked. The three
  category-page branches this created share one `CategoryShell` scaffold
  (PR review), so the frame exists once.
- **External-content surveys are listed but not answerable.** Their
  prompts live off-chain behind a `content_anchor` Tessera's API does not
  serve; they render with a ref-derived title and a "document not loaded"
  note.
- **Mechanism A now; mechanism B later.** B proves by voting on a linked
  action in the same transaction, so its place is the vote panel, riding
  with A. Deferred, not rejected.
- **One deploy switch: `TESSERA_BACKEND_URL` presence** plus the
  `/health` network match, owned by whoever deploys the site.

## 5. Open items, out of scope for this PR

Each has a destination; none may silently die with this document.

- **The voter's own settled answer is invisible, and a re-answer starts
  blank** although `<tessera-respond>` ships a `priorResponses`
  edit/replace flow — DRepTalk persists no response content (pass 3
  discards the bundle after auditing; pass 4 reads identity only). The
  fix the architecture points at is a D1 mirror of the audited
  latest-valid responses, written in pass 3 and read at SSR — a new
  table, to raise with the maintainer before the code exists.
- **The connected wallet is not bound to the session's DRep** (PR review,
  confirmed). `connectAsDrep` preflights that the wallet is *a*
  registered active DRep, never that it is the session's; the record
  endpoint stores the session's credential. Answering with another DRep's
  wallet puts that DRep's answer on chain and the session's credential in
  a row that can never settle; a script-DRep session is shown a panel
  whose record call 403s. Nothing is forged — but the vote flow
  (`VotePanel`, `MultiVoteBar`, `/api/vote/record`) runs the identical
  model, so the fix spans both: give `connectVerifiedDrep` the
  active-registration preflight, use it for both panels, and resolve the
  viewer's DRep id (and credential kind) server-side. → file as an
  upstream issue before this document is deleted.
- **Route behaviour forks on ambient config vars and cannot be passed
  in** (`runtimeEnv()` ignores its argument since the adapter dropped
  `Astro.locals.runtime.env`), so tests assign to the module env instead
  of describing an input. ~13 sites across ~40 API routes share the
  shape; `src/lib/legal.ts` already models the fix (pure core, thin
  ambient adapter). Worth deciding once on `main`, not once badly here.
  → file as an upstream issue before this document is deleted.
- **Mechanism B** (vote-in-same-transaction proof) — lands in the vote
  panel when scheduled.
- **`docs/development.md`'s local-sync commands are stale** (pre-existing on
  `main`): it documents the old `*/15` and hourly crons, and its bare
  `curl .../__scheduled` sends an empty expression, so the worker logs
  `unknown cron` and runs nothing. The working form is
  `?cron=*/5+*+*+*+*`. The `CRON_*` drift test does not reach prose.
  → fix with the README/deployment pass, or as its own upstream issue.

At deletion time: the architecture summary above feeds the README and
`docs/deployment.md` updates, the Decisions move into the PR description,
and the two flagged items become upstream issues.
