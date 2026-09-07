# CIP-179 surveys in DRepTalk

> **Status: as-built summary, for review** (thread: katomm/dreptalk.com#379;
> began as the design under discussion there, rewritten once the code
> existed). The README's architecture/feature update and the deletion of
> this document are deliberately the branch's **last commit, after the
> review is validated** —
> a review that notes the README unchanged is reading the branch mid-flight,
> not finding an oversight.

## 1. Why

[CIP-179](https://github.com/cardano-foundation/CIPs/tree/master/CIP-0179)
puts surveys and polls in transaction metadata under label 17. Tessera is
the reference implementation: a browser app plus a serving backend that
scans the label, validates responses and finalizes results.

Ownership split (agreed in #379): **Tessera owns the protocol behind its
HTTP API**; **DRepTalk owns wallet, transaction building, forum and
presentation**. DRepTalk implements no CIP-179 rule of its own — parsing and
lifecycle come from Tessera's published package (`fromJsonSafe`,
`aggregate()`), every count from its backend; its API is mirrored into D1
the way Koios is.

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

- Mainnet and Preview. The category exists only where the switch is on:
  elsewhere it is unlisted, absent from the sitemap, and `/c/surveys/` is
  a 404. Threads the mirror created before a switch-off keep their pages.
- Results rendering, interim or final. CIP-179 does not mandate a tally;
  the survey maker owns the counting policy. The card shows Tessera's
  DRep participation count (the index's audited in-window figure, then
  the finalized artifact's) and a deep link — no figure as "the result".
  Named follow-up: a live *weighted* estimate for DRep questions (DRepTalk
  already syncs per-epoch DRep voting power; Tessera's tally math takes
  weights as inputs).
- A nav link and activity-feed events (both would show on mainnet with the
  feature off; both are one-line additions later), creating surveys, roles
  other than DRep, the artifact routes, sealed surveys as a *tested* path.

## 3. Architecture as built

```
Tessera preprod backend
  GET /api/surveys?filter=linked&…   walk once: records, govLinks, audited counts, tip
  GET /api/surveys?changes=…         every tick: what moved since, what was removed
  GET /api/surveys?refs=…            deferred surveys; every held row after a walk
  GET /api/artifacts/{hash}          a finalized survey's tally artifact → final count
  GET /api/responses/{txHash}        settle pending local rows by exact tx
  GET /health                        network and contract-version guard
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
`TESSERA_BACKEND_URL` is set — preprod only today — and the client
(`cardano-tessera-client`, Tessera's own published consumer of its HTTP
contract) refuses a backend whose `/health` network differs from
`CARDANO_NETWORK`, or whose contract major is not the one it speaks.
`TESSERA_APP_URL` (optional, display-only) feeds the card's deep link.

**Schema** (`0091_surveys.sql`): `survey` (one row per admitted survey;
`counted_dreps` is the index's audited in-window DRep count,
`final_counted_dreps` the finalized artifact's, `final_state` NULL until
decided for good with `artifact_hash` beside it, `unavailable` marks an
upstream rollback), `survey_gov_link`, `survey_response_local` (the
optimistic rows), `survey_sync_state` (one row: the change cursor, the
deferred refs, the mirror-wide "as of").

**The sync**, four passes inside the `surveys` phase:

1. **Mirror.** With a cursor, `?changes=<cursor>` once, followed up in
   the same run while a page comes back full (the 25-page cap, then the
   backlog waits a run): every survey whose projection moved and every
   key removed, delivered once and never missed. Without one — the first
   run, or the backend answering that the cursor outlived its retention
   window — a walk of `?filter=linked`, whose last page hands out the
   cursor to continue from; a page answering from an older snapshot
   (`resync`) restarts the walk, and a walk the cap ends is abandoned
   with a warning rather than restarted. Every survey an answer names
   goes through one pure predicate (`src/lib/surveys/admission.ts`):
   DRep-eligible, neither of `aggregate()`'s two definition-derived
   verdicts against it (untalliable; sealed on a drand chain the
   published tlock cannot decrypt), *and* linked by an imported action.
   An unknown survey is admitted on it — survey row, topic and gov links
   in one batch — or deferred while its links name actions not imported
   yet; a held row is refreshed where a stored value moved (count,
   cancellation, decision, links) and withdrawn once on the predicate's
   negation or on a removal: `unavailable` hides answering and the gov
   links go (a rolled-back action must take its link down), the thread
   stays, and presence in a later answer clears it. The pass is isolated
   like the others: an answer that fails to apply costs this tick's
   mirror, not its settle.
2. **By reference.** The deferred surveys every run — the DRepTalk half
   of admission turns true with no move upstream, and a change is
   delivered once — and, on a run that walked, every held row: the linked
   list covers only what is linked now, so absence from a *complete*
   `?refs=` answer is the rollback the delta would otherwise have
   delivered as a removal. From an `incomplete` answer, absence proves
   nothing. Empty on a steady-state run.
3. **Final counts.** Every `finalized` row without one reads its tally
   artifact by `artifact_hash` (content-addressed, immutable) and stores
   the DRep responders it lists — the responses counted at close, after
   the end-epoch role membership the in-window count cannot apply, so the
   figure can be lower. Retried each run until the artifact answers;
   `cancelled` and `untalliable` rows store no count.
4. **Settle.** `GET /api/responses/{txHash}` per optimistic row still
   worth polling — every `pending` row, and `failed` rows recorded within
   the last week, pending first then oldest first, 50 per run, failures
   isolated per transaction — deletes the row once the exact transaction
   names a response for the survey, keyed by that transaction so a
   re-answer that replaced the row mid-poll is left alone. Matching the
   transaction is what makes a *replacement* observable.

A separate **`survey-reconcile` phase**, never gated by the feature
switch, ages optimistic rows still `pending` after 6 h to `failed`
(`PENDING_VOTE_TTL_SEC`, shared with the vote lifecycle), so "confirming…"
cannot outlive a Tessera outage or the switch being turned off.

**One derived state.** `src/lib/surveys/state.ts` turns a stored row,
the network calendar and the clock into `{ lifecycle, answerable,
participation }` once: lifecycle is `open` / `closed` / `cancelled` /
`untalliable` (Tessera's decision outranks the clock), `answerable` is the
survey's own half of the answer gate (open, held, DRep-eligible, not
external-content), participation the tagged figure described above. The
list row, the thread card, the action's sidebar card, the page's panel
gate and the record API all render or decide from it, through one shared
badge component and one wording per figure. The stored definition decodes
through a guarded `parseSurveyDefinition` — null, a note and no panel when
the frozen form cannot be read, never a 500 for the thread — and every
string it yields for a page or a post (title, description, prompts, option
labels) goes through the same sanitizer and caps as a governance action's
anchor text; the stored wire form stays verbatim for the widget.

**Answering.** `RespondPanel.astro` renders `<tessera-respond>` for a
key-credential `drep` session on an answerable survey whose definition
decoded, with the mirror configured (bundled sibling script, so the CSP
hash is automatic). The panel connects with `connectVerifiedDrep`: the
wallet must derive the signed-in DRep's id, since the record API stores
the *session's* credential and the sync settles only on it — another
wallet's answer would land on chain and leave the account a row nothing
settles. On `tessera:response` the existing transaction path attaches the
widget's payload at label 17 via the published `toTxMetadatum` and adds
the DRep key hash to `required_signers` — proof mechanism A; the CIP-20
note rides at label 674 as on votes. `POST /api/survey/response/record`
then loads the row and refuses (409) a survey `state.ts` no longer calls
answerable — a tab left open past the epoch roll can still submit — before
writing the optimistic row with the session-derived credential; script
DReps get a 403 as the backstop behind the page gate. The card overlays
*Your answer · confirming…* until pass 4 or the reconcile phase resolves
it, and offers "answer again" on a failed row only while the survey is
still answerable.

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
- **The displayed count is Tessera's, from two of its published figures:**
  the index's audited per-role count (`countedByRole`) while a survey is
  held, the finalized tally artifact's DRep responders once it is
  decided, each labelled as what it is ("counted" / "counted at close").
  The maintainer's first review rejected the list's raw `responseCounts`
  (no validity, deadline or proof filter, summed across roles) and asked
  for a figure that cannot inflate; the first answer ran `auditResponses`
  over every bundle in DRepTalk's own sync, which re-implemented a
  schedule Tessera already runs (verdicts land on its refresh, not on
  ours), cost a bundle walk per survey, and could not apply end-epoch
  role membership at all. The backend serving its own audited count and
  the artifact carrying the final one removes the pass and the schedule;
  a backend predating `countedByRole` shows "count pending" rather than
  the raw figure.
- **A held survey refreshes until `final_state`, never freezing at
  close** — verdicts land after the deadline, so freezing at close would
  pin whatever snapshot the deadline landed on.
- **Admission is applied to every answer, not only at discovery**, and
  its negation is treated like a rollback: a held survey the delta
  removes, that a complete reference answer omits, or that an answer
  lists without an imported link, is withdrawn — flag, clock, links
  erased. The paths share one predicate so they cannot disagree about
  what an admitted survey is, and in practice a lost link *is* a
  rollback of the linking action's transaction. The alternative,
  a separate "delinked" state with its own badge, was not taken: it
  would add a column and copy for a case the settlement window already
  bounds.
- **Talliability and the sealed-chain check gate admission**, rather than
  being surfaced as a state on an admitted survey. Tessera's own app
  badges such a survey and blocks responding, and its finalizer decides
  it `untalliable` at close; a thread inviting answers in between would
  waste every fee spent. Both verdicts are `aggregate()`'s own
  (`talliable`, `sealedUnsupported`); DRepTalk computes neither.
- **A failed local answer keeps being polled for a week.** The
  confirmation cutoff fails a row on the clock alone, so an outage longer
  than it fails every pending row at once; a transaction that then lands
  must still settle its row, or the card invites an answer the chain
  already has. Pending rows go first so a failed backlog cannot delay a
  fresh answer's "confirming" going away.
- **A finalized row's artifact read is retried every run, unscheduled.**
  The artifact is immutable and content-addressed, so the request cannot
  fail on the survey's account, only on the backend's; a backoff ladder
  would re-create the scheduling the audit pass needed, with the
  concession and retirement rules that came with it.
- **The "as of" is one value for the mirror**, not one per row: the
  delta names every held row that moved and a decided row cannot change,
  so no row is fresher than the oldest answer the run used — and
  stamping it only when the delta was applied to its end (or a walk
  completed) and every reference asked for was answered is what keeps it
  honest through a pass that broke off.
- **The mirror is Tessera's change selection, not a per-tick walk and
  refresh.** The earlier shape read page one of the linked list every
  tick, walked further on heuristics (the set size moved, an action was
  imported since, a daily backstop — with a blind spot when one survey
  came in as another left), and re-asked every held row by `?refs=` in
  chunks of 200; removals were inferred from absence, and a withdrawn
  row retired from the refresh set after four days so a record that
  never came back would not be named forever. `?changes=<cursor>`
  delivers every moved row and every removal once, so the heuristics,
  the per-tick refs call, their two state columns and the retirement
  TTL are gone (the held set bounds no request now, and a record that
  re-lands years later still clears its row). What the delta cannot
  deliver is the DRepTalk half of an admission turning true — an action
  imported after the survey's change went by — hence the deferred refs,
  bounded to one request and re-asked each run until admission holds or
  the record is gone.
- **Tessera's contract is consumed through its published client**
  (`cardano-tessera-client`, with `cip-179` as its peer) rather than a
  hand-written zod client: the payload types, the decoders, the
  network and contract-version guard and the not-ready state live with
  the contract they describe, the sync casts nothing, and the stored
  record is cip-179's own wire form (`toJsonSafe` at admission,
  `decodeSurveyRecord` on every page view).
- **What a survey is and what may be done with it is decided in one
  function, not per reader.** Before `state.ts`, lifecycle read two
  columns, the count another two, the page's answer gate six plus the
  session, and each component hand-wrote its own participation string; a
  withdrawn row said "count pending" beside "Record missing" because
  `unavailable` was consulted by some readers and not others. Session and
  deployment facts (a key DRep, the mirror configured, the definition
  readable) stay with the page and the record API, which are the only
  places that know them.
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
  `/health` network match, owned by whoever deploys the site. Read once
  by `surveysEnabled()`; the app's copy and gov-sync's are held equal per
  environment by `src/lib/deployVars.test.ts`, since the switch on one
  side only offers answers nothing settles or mirrors surveys nobody sees.

## 5. Open items, out of scope for this PR

Each has a destination; none may silently die with this document.

- **The voter's own settled answer is invisible, and a re-answer starts
  blank** although `<tessera-respond>` ships a `priorResponses`
  edit/replace flow — DRepTalk persists no response content (pass 4
  reads identity only). The fix the architecture points at is a D1
  mirror of the viewer's own latest response, read from Tessera as the
  row settles and served at SSR — a new table, to raise with the
  maintainer before the code exists.
- **The vote flow still connects any registered DRep, not the session's.**
  The survey panel now binds the wallet to the signed-in DRep
  (`connectVerifiedDrep`), but `VotePanel`, `MultiVoteBar` and
  `/api/vote/record` run the older model: `connectAsDrep` preflights that
  the wallet is *a* registered active DRep, never that it is the
  session's, while the record endpoint stores the session's credential.
  Same defect, same fix, on a mainnet surface this PR does not touch.
  → file as an upstream issue before this document is deleted.
- **Route behaviour forks on ambient config vars and cannot be passed
  in** (`runtimeEnv()` ignores its argument since the adapter dropped
  `Astro.locals.runtime.env`), so tests assign to the module env instead
  of describing an input. ~13 sites across ~40 API routes share the
  shape; `src/lib/legal.ts` already models the fix (pure core, thin
  ambient adapter). Worth deciding once on `main`, not once badly here.
  → file as an upstream issue before this document is deleted.
- **Mechanism B** (vote-in-same-transaction proof) — lands in the vote
  panel when scheduled.

At deletion time: the architecture summary above feeds the README
update, the Decisions move into the PR description,
and the two flagged items become upstream issues.
