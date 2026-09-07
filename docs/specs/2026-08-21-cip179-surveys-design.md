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

**In:** preprod only. gov-sync mirrors eligible surveys into D1; one
auto-opened thread per published survey in a read-only `surveys` category;
governance linkage rendered in both directions; DRep-only answering via
`<tessera-respond>` with DRepTalk building, signing and submitting the
transaction.

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
  GET /api/surveys?since=0           first run: the whole corpus as delta pages
  GET /api/surveys?changes=…         every tick: what moved since, what was removed
  GET /api/artifacts/{hash}          a finalized survey's tally artifact → final count
  GET /health                        network and contract-version guard
        │   server-side only, from gov-sync; never from a page request or the browser
        ▼
gov-sync worker  (*/5 cron; one `surveys` phase entry)
        │        writes D1: survey, survey_gov_link, topics + posts
        ▼
app worker (Astro SSR)   reads D1 only, with an "as of" time — the same
        ▼                invariant every other on-chain value obeys
browser: bundled client script → <tessera-respond> → RespondResult
        ▼
DRepTalk's own transaction path (evolution-sdk + CIP-30/95 wallet) → chain
        ▼
the answer comes back through the index, on the next tick's mirror
```

Nothing reaches Tessera from the browser (CSP `connect-src` blocks it; no
proxy route) and nothing from a page request.

**Feature switch.** The mirror and the answer path exist iff
`TESSERA_BACKEND_URL` is set — preprod only today — and the client
(`cardano-tessera-client`, Tessera's own published consumer of its HTTP
contract) refuses a backend whose `/health` network differs from
`CARDANO_NETWORK`, or whose contract major is not the one it speaks.
`TESSERA_APP_URL` (optional, display-only) feeds the card's deep link.

**Schema** (`0091_surveys.sql`): `survey` (one row per mirrored survey;
`topic_id` NULL until its thread is opened; `counted_dreps` is the index's
audited in-window DRep count, `final_counted_dreps` the finalized
artifact's, `final_state` NULL until decided for good with `artifact_hash`
beside it, `unavailable` marks an upstream rollback), `survey_gov_link`,
`survey_sync_state` (one row: the change cursor and the mirror-wide "as
of").

**The sync**, three passes inside the `surveys` phase:

1. **Mirror.** `?changes=<cursor>` once, followed up in the same run
   while a page comes back full (the 25-page cap, then the backlog waits
   a run): every survey whose projection moved and every key removed,
   delivered once and never missed. The first run asks the same of
   instant zero (`?since=0`), which is the whole corpus as delta pages
   ending in an ordinary cursor; a cursor never expires, since the
   backend keeps its tombstones for the life of the corpus. Every survey
   an answer names goes through Tessera's half of admission, one pure
   predicate (`src/lib/surveys/admission.ts`): DRep-eligible, linked by
   at least one action, and neither of `aggregate()`'s two
   definition-derived verdicts against it (untalliable; sealed on a drand
   chain the published tlock cannot decrypt). A survey it passes is
   written down — row and gov links, no thread yet — and one it refuses is
   withdrawn, beside the keys the delta removed; the mirror keeps no
   working set and compares nothing, since a delivered row is by
   construction a moved row and a quiet tick delivers none. What
   withdrawal does depends on what there is to keep, and that is a fact on
   the row (`topic_id IS NULL`), so it is asked in the statements that
   act: a published row is flagged — `unavailable` hides answering and the
   gov links go (a rolled-back action must take its link down), the thread
   stays, and presence in a later answer clears it — and a row with no
   thread is deleted, since an advisory removal delivers it again. The pass is
   isolated like the others: an answer that fails to apply costs this
   tick's mirror, not its threads or its final counts.
2. **Publish.** DRepTalk's half of admission, asked of the stored rows
   right after discovery: every survey with no thread that at least one
   imported governance action links gets one — topic, first post and the
   row's `topic_id` in one batch — from the stored record, with no
   request to Tessera. An indexed query, empty in steady state; a thread
   that fails to open is simply still pending on the next run.
3. **Final counts.** Every `finalized` row without one reads its tally
   artifact by `artifact_hash` (content-addressed, immutable) and stores
   the DRep responders it lists — the responses counted at close, after
   the end-epoch role membership the in-window count cannot apply, so the
   figure can be lower. Retried each run until the artifact answers;
   `cancelled` and `untalliable` rows store no count.
**One derived state.** `src/lib/surveys/state.ts` turns a stored row,
the network calendar and the clock into `{ lifecycle, answerable,
participation }` once: lifecycle is `open` / `closed` / `cancelled` /
`untalliable` (Tessera's decision outranks the clock), `answerable` is the
survey's own half of the answer gate (open, held, DRep-eligible, not
external-content), participation the tagged figure described above. The
list row, the thread card, the action's sidebar card and the page's panel
gate all render or decide from it, through one shared badge component and
one wording per figure. The stored definition decodes
through a guarded `parseSurveyDefinition` — null, a note and no panel when
the frozen form cannot be read, never a 500 for the thread — and every
string it yields for a page or a post (title, description, prompts, option
labels) goes through the same sanitizer and caps as a governance action's
anchor text; the stored wire form stays verbatim for the widget.

**Answering.** `RespondPanel.astro` renders `<tessera-respond>` for a
key-credential `drep` session on an answerable survey whose definition
decoded, with the mirror configured (bundled sibling script, so the CSP
hash is automatic). The panel connects with `connectVerifiedDrep`: the
wallet must derive the signed-in DRep's id, so the answer is signed by the
DRep whose session opened the panel and not by another credential the same
wallet happens to hold. On `tessera:response` the existing transaction path
attaches the widget's payload at label 17 via the published `toTxMetadatum`
and adds the DRep key hash to `required_signers` — proof mechanism A; the
CIP-20 note rides at label 674 as on votes. Submission ends at the
transaction hash, shown with an explorer link: the answer is visible here
when the index has it, through the participation count the next tick
mirrors. Nothing about the viewer's own answer is stored (§5).

**Freshness.** Surveys have a row in `src/lib/freshness.ts` and the
`data-freshness` guide; the existing drift test holds the pair together.

**Packages:** `cip-179` 0.4.0, `cardano-tessera-client` 0.2.0 (contract
1.2) and `cardano-tessera-respond` 0.1.3, all pinned, all Tessera's
published code.

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
- **Each published survey is a thread in its own category**, not a card on
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
- **A survey's row keeps taking Tessera's answers until `final_state`**,
  never freezing at close — verdicts land after the deadline, so freezing
  at close would pin whatever snapshot the deadline landed on.
- **Admission is split along what Tessera knows.** Its two halves have
  two homes: the row mirrors what Tessera's answer alone decides
  (DRep-eligible, linked, talliable, supported), the thread records what
  only DRepTalk knows (a linking action imported here). Tessera
  re-delivers a survey whenever a fact on its side moves, so no verdict
  on an answer needs remembering; our fact can turn true with no move
  upstream, so it is never asked of an answer — it is asked of the
  stored rows, after every discovery, and the record is already there.
  The earlier shape asked both halves of every answer at once, stored
  nothing it could not publish, and kept a deferred set of keys to
  re-ask by `?refs=` each run until the action landed; a row that exists
  is the simpler note-to-self. The policy is unchanged: gate 2 decides
  what gets a thread, and a survey without an imported action is
  invisible, because every page reader joins topics. A stored "action
  imported" flag was not taken either: a third copy of a fact
  `governance_actions` owns, needing invalidation on every discovery.
- **Tessera's half is applied to every answer, not only at discovery**,
  and its negation is treated like a rollback: a stored survey the delta
  removes, or that an answer lists with no link left, is withdrawn — a
  published one flagged, its links erased, one with no thread deleted. The paths share one predicate so they cannot disagree about
  what a mirrored survey is, and in practice a lost link *is* a rollback
  of the linking action's transaction. A published survey whose link
  moves to an action not imported yet stays published: the link is
  Tessera's fact and the card names the action by Tessera's title until
  discovery imports it — under the earlier shape it was withdrawn, and
  since nothing upstream moved when the action then landed, stayed so.
  The alternative, a separate "delinked" state with its own badge, was
  not taken: it would add a column and copy for a case the settlement
  window already bounds.
- **Talliability and the sealed-chain check gate admission**, rather than
  being surfaced as a state on an admitted survey. Tessera's own app
  badges such a survey and blocks responding, and its finalizer decides
  it `untalliable` at close; a thread inviting answers in between would
  waste every fee spent. Both verdicts are `aggregate()`'s own
  (`talliable`, `sealedUnsupported`); DRepTalk computes neither.
- **A finalized row's artifact read is retried every run, unscheduled.**
  The artifact is immutable and content-addressed, so the request cannot
  fail on the survey's account, only on the backend's; a backoff ladder
  would re-create the scheduling the audit pass needed, with the
  concession and retirement rules that came with it.
- **The "as of" is one value for the mirror**, not one per row: the delta
  names every row that moved, so no row is fresher than the answer the run
  finished on — and stamping it only when the delta was applied to its end
  is what keeps it honest through a pass that broke off. It is the *last*
  page's generation, not the oldest: each page is read at whatever
  generation is published when its own request arrives, and the cursor is a
  keyset over `(changed_at, key)`, so a row re-stamped after an earlier page
  is delivered again on a later one.
- **The mirror keeps no working set.** It used to read every undecided row
  with its links, and every stored ref, before each run: the first to skip
  writing a delivered row no stored value of which had moved, the second to
  know whether a withdrawal should flag or delete. Both are answers the
  change selection or the row itself already gives — a delivered row is a
  moved row, and `topic_id IS NULL` is the published/pending fact — so the
  two whole-table reads per tick went with them, along with an ordering
  subtlety (the maps had to be kept current within a run so a survey two
  pages name is judged against what the first wrote). The concession is
  that a delivery moving only a figure this mirror does not store — an SPO
  count, the raw response count — rewrites the row with the same values;
  it costs one write, bounded by what Tessera reports. Decided rows follow
  the same rule rather than carrying a `final_state IS NULL` exception:
  Tessera does not move a decided survey, and a second predicate for a case
  that cannot happen is worth less than one rule for every row.
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
  TTL are gone (no set of rows bounds a request now, and a record that
  re-lands years later still clears its row). Contract 1.2 then took the
  bootstrap: the change selection has no horizon and answers from an
  instant the caller names, so the walk of `?filter=linked` that used to
  establish a cursor — with its restart on a moved snapshot and the
  `?refs=` pass that repaired what a walk cannot report — is `?since=0`
  once. The sync uses three client methods: `changesSince`, `changes` and
  `artifactByHash`.
- **Tessera's contract is consumed through its published client**
  (`cardano-tessera-client`, with `cip-179` as its peer) rather than a
  hand-written zod client: the payload types, the decoders, the
  network and contract-version guard and the not-ready state live with
  the contract they describe, the sync casts nothing, and the stored
  record is cip-179's own wire form (`toJsonSafe` when stored,
  `decodeSurveyRecord` on every page view and when the thread opens).
- **What a survey is and what may be done with it is decided in one
  function, not per reader.** Before `state.ts`, lifecycle read two
  columns, the count another two, the page's answer gate six plus the
  session, and each component hand-wrote its own participation string; a
  withdrawn row said "count pending" beside "Record missing" because
  `unavailable` was consulted by some readers and not others. Session and
  deployment facts (a key DRep, the mirror configured, the definition
  readable) stay with the page, the only place that knows them.
- **The viewer's own submission is not tracked at all.** An earlier shape
  mirrored the GA-vote pending lifecycle: an optimistic row written by
  `POST /api/survey/response/record`, settled by a fourth sync pass
  matching the exact transaction (`/api/responses/{txHash}`, since
  `/api/responded` is replacement-blind), aged to `failed` by its own
  ungated phase, and shown as *Your answer · confirming…* on the card.
  Removed: the state it rendered is minutes long and vanishes on settle —
  the settled answer is invisible either way (§5) — and the panel already
  hands the viewer the transaction hash with an explorer link, which is
  the same knowledge without a table, a route, a pass, a phase and a
  cutoff. The feature this was reaching for is the response mirror in §5,
  which shows the answer itself and can carry the pending state with it.
  Reverses three points of the first PR review (poll failed rows for a
  week; one answerability rule with a 409 in the record API; settle by
  transaction), so it is the maintainer's call to take back.
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
  side only offers answers on surveys the site can no longer refresh, or
  mirrors surveys nobody sees.

## 5. Open items, out of scope for this PR

Each has a destination; none may silently die with this document.

- **The viewer's own answer is invisible — pending or settled — and a
  re-answer starts blank** although `<tessera-respond>` ships a
  `priorResponses` edit/replace flow: DRepTalk stores nothing about who
  answered what. The fix the architecture points at is a D1 mirror of the
  viewer's own latest audited response, read from Tessera by the sync and
  served at SSR, which shows the answer itself and can say "submitted, not
  indexed yet" on the way — a new table, to raise with the maintainer
  before the code exists.
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
