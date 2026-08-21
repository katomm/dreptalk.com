# CIP-179 surveys in DRepTalk — MVP

> **Status: design for review.** Pushed as the first commit of the feature
> branch so the shape can be discussed before any code exists (the thread is
> katomm/dreptalk.com#379); the increments land on the same branch behind it.
> Like the earlier `docs/specs/` documents, it is deleted by the last increment.
> Paths are read against `f967e48` on the DRepTalk side and Tessera's
> `backend/server/src/http.ts` of 2026-08-21 — re-check before relying on
> them.

## Progress

_(one line per completed increment; record deviations here)_

## Open

- **Admission rule.** Which surveys get a thread: all, DRep-eligible only, or
  DRep-eligible *and* linked by an imported governance action. Asked the
  maintainer 2026-08-21 after his message mentioned paging `filter=linked`
  against imported actions as his "admission-gate discovery". Increment 3 keeps
  the predicate in one function so any answer is a one-line change; the choice
  decides which preprod survey the acceptance run must use (linked →
  `1200298ce…:0`, which must then be DRep-eligible and still open).

---

## 1. What is being built, and why a category

[CIP-179](https://github.com/cardano-foundation/CIPs/tree/master/CIP-0179) puts
surveys and polls in Cardano transaction metadata under label 17. Tessera is the
reference implementation: a browser app plus a serving backend that scans label
17, validates responses against the ledger, and finalizes closed surveys into
content-addressed result artifacts anyone can re-derive from chain data.

The ownership split was agreed in
[katomm/dreptalk.com#379](https://github.com/katomm/dreptalk.com/issues/379):
**Tessera owns the protocol behind its HTTP API** — scanning, credential-proof
verdicts, sealed reveal, weighting, finalization. **DRepTalk owns wallet,
transaction building, forum, and presentation.** DRepTalk grows no second
implementation of any CIP-179 rule; two implementations of ruleset-sensitive
logic produce results that cannot be compared, which is why DRepTalk indexing
label 17 itself was rejected by both sides and stays rejected. DRepTalk reads
surveys from Tessera's HTTP API and caches them, exactly as it already caches
governance data read from Koios.

**A survey is a first-class thread in its own category, not a sub-element of a
governance action.** Surveys stand alone: a survey is complete and valid on its
own, and most have no governance action attached at all. Linkage is a discovery
relationship an action opts into through its CIP-108 anchor — it changes nothing
about who may respond or how the survey is counted.

The relation is also N-to-1, not 1-to-1: an action's anchor names *at most one*
survey through `body.cip179`, while a survey may be linked by several actions.
So the rejected alternative — surveys living under the thread of the action that
links them — fails twice over. It has nowhere to put the majority of surveys,
which link to no action, and it has to pick one host arbitrarily for a survey
that three actions point at. (An admission rule that only *admits* linked
surveys does not change this: it narrows which surveys get a thread, not where
a thread lives.)

**What this MVP has to prove:** a DRep signed into DRepTalk on preprod can find
an open, DRep-eligible CIP-179 survey, answer it, and see the answer land on
chain and come back through the index.

## 2. Scope

**In.**

- Preprod only.
- gov-sync mirrors the admitted subset of Tessera's survey list into D1 —
  DRepTalk's own knowledge of what exists, since SSR pages read only DRepTalk's
  storage.
- One auto-opened thread per admitted survey in a new `surveys` category,
  mirroring how governance actions become threads today.
- Category listing and per-survey thread with the definition rendered, from D1
  only.
- DRep-only answering through the `<tessera-respond>` widget, with DRepTalk
  building, signing and submitting the transaction.
- Governance linkage rendered in both directions.
- Optimistic local record of a just-submitted response.

**Out, deliberately.**

- Mainnet and preview. No Tessera backend is deployed for either, and the MVP is
  a preprod exercise. The category itself is static config and therefore ships
  everywhere; see increment 4 for what mainnet shows.
- A navigation link. `NAV_LINKS` is static and would point mainnet users at an
  empty category; the category page is reachable by URL and from survey threads.
- Activity-feed events for survey threads. `activity.type` has no survey kind;
  adding one is a feed decision, not an MVP need.
- Creating surveys from DRepTalk.
- Roles other than DRep. CIP-179 also has Stakeholder, Keyholder, SPO and CC;
  DRep alone reuses machinery DRepTalk already has.
- External-content surveys as an answerable path (§7).
- Results rendering, interim or final. CIP-179 specifies how surveys and
  responses are written, **not how they are tallied**: the weighted and
  unit-weight views Tessera renders are one profile (`TALLY-SPEC.md` is explicit
  that its ruleset is "a Tessera profile, not part of CIP-179"), and how a
  survey is counted — linear stake weight, one credential one vote, quadratic,
  anything — is the survey maker's call. Tessera's own architecture notes add
  that until a reusable `<tessera-results>` element exists, "the honest MVP for
  a host is a compact summary plus a deep link, not a partial renderer that
  silently mishandles the methods it does not cover"
  (`backend/ARCHITECTURE.md` §9). So the survey card shows the deduped response
  count the list payload carries and links to Tessera's survey page, and
  presents **no figure as "the result"** — not a percentage, not a leading
  option, not a weighted or unweighted breakdown.
- Reading the per-survey bundle (`/api/surveys/{tx}/{i}`). It exists for the
  verifier and for results; neither is in scope, and not reading it keeps SSR
  D1-only (§4).
- Sealed surveys as a *tested* path. The widget encrypts them client-side with
  no host involvement, so nothing blocks them; the acceptance run targets a
  public survey.

## 3. Prerequisites

**Tessera side.**

- Backend: `https://tessera-backend-preprod.matthieu-pizenberg.workers.dev`.
- Long-running DRep-eligible preprod surveys exist to build and test against
  (`ccaa8baa…1547:0` is the DRep-eligible one recorded in `interop/preprod.md`;
  it closes at the end of epoch 308, so a fresh one is needed for the run).
- One linked survey for increment 5:
  `1200298ce001b907801909c18e6a4d55eee587e1bc3c1d4b24cfc4662ecd2d23:0` — the
  `<txHex>:<index>` form the API keys surveys by. If the admission rule is
  "linked", it is also the acceptance survey and must be DRep-eligible and open.
- `GET /api/responses/{txHash}` in Tessera before increment 7: the responses
  that transaction carried (`surveyKey`, `responseIndex`, `role`, `credential`,
  `slot`) — two primary-key reads, no new index, no change to any existing
  payload. Decided 2026-08-21. `/api/responded` as it exists cannot tell a
  *replacement* response from the one it supersedes, and the interop sequence's
  step 6 is a replacement. There is no fallback: increment 7 waits for it.

**Where the work pauses.** Increments 1–5 need nothing from Tessera beyond
what the preprod backend already serves. Increment 6 needs a fresh
DRep-eligible open survey (data, not code) and increment 7 needs the route
above, so the branch stops after increment 5 until both exist.

**DRepTalk side.**

- Fork `katomm/dreptalk.com`, add the fork as a remote, branch
  `feat/cip179-surveys` off `main` (CONTRIBUTING.md requires the `feat/`
  prefix).
- `.dev.vars` with `CARDANO_NETWORK=preprod`, `KOIOS_API_KEY` (a free
  koios.rest account is enough; the first DRep sync is the heavy one), and the
  new `TESSERA_BACKEND_URL`.
- A preprod wallet holding a **registered DRep credential** and some tADA. The
  DRep must be a key credential, not a script — `resolveDRep` rejects script
  DReps, and CIP-179 mechanism A needs a key witness anyway.

## 4. How data flows

```
Tessera preprod backend
  GET /api/surveys?filter=…&limit&cursor   discover: records, govLinks, responseCounts, tip
  GET /api/surveys?refs=a:0,b:1,…          refresh what DRepTalk already holds (≤200 refs)
  GET /api/responded?credentials=key:<h>   settle pending local rows (≤20 credentials)
  GET /health                              network guard
        │   server-side only, from gov-sync; never from a page request, never from the browser
        ▼
gov-sync worker  (*/5 cron, one phase under recordSyncRun)
        │        writes D1: survey, survey_gov_link, topics + posts; settles survey_response_local
        ▼
app worker (Astro SSR)   reads D1 only — the same invariant every other on-chain value obeys
        ▼
browser: bundled client script → <tessera-respond> → RespondResult
        ▼
DRepTalk's own transaction path (evolution-sdk + CIP-30/95 wallet) → chain
        ▼
POST /api/survey/response/record → survey_response_local until the sync settles it
```

**Nothing reaches Tessera from the browser.** DRepTalk's CSP is
`connect-src 'self' https://cloudflareinsights.com` (`astro.config.mjs:136`), so
a cross-origin fetch to the Tessera backend is blocked regardless of the
permissive CORS Tessera sends. Keeping every read server-side means no proxy
route, no CSP amendment, and no argument about either in review.

**Nothing reaches Tessera from a page request either.** Everything the MVP
renders — definition, eligible roles, end epoch, cancelled, deduped response
count, links, tip epoch, `fetchedAt` — is in the list payload the sync mirrors,
so the survey thread is a pure D1 read like every other page. The 5-minute
staleness this buys is the same one governance tallies live with, and it is
shown as an "as of" time.

### 4.1 Tessera API facts the code relies on

Verified against `backend/server/src/http.ts` and `sqlBuilders.ts`; re-check if
Tessera's commit (`GET /api/health` → `commit`) moves.

- Every snapshot-derived route: weak `ETag: W/"<route>-<fetchedAt>"`,
  `Cache-Control: no-cache`, 304 on a matching `If-None-Match`; body carries
  `fetchedAt` (unix s) and `ageSeconds`. Before the first refresh every such
  route answers `503 {"error":"snapshot not ready"}` — the sync treats that as
  "nothing to do this run", not as a failure.
- **List** `GET /api/surveys`: `filter` ∈ `all|linked|active|sealed|public|mine`
  (`linked` = at least one gov link; `active`/`public`/`sealed` are status
  chips, none of them role-aware — DRep eligibility is read off the record's
  `eligibleRoles`), `limit` ≤ 200 (default 50), keyset `cursor`; `resync: true`
  means the cursor was minted against an older snapshot — restart from page
  one. Body: `surveys[]` (wire-form `SurveyRecord`), `cancellations[]`,
  `govLinks[]` (each names its survey key and action id), `tip`,
  `responseCounts{surveyKey → n}` (distinct `(role, credential)` after
  latest-valid-wins dedup — the count to display), `finalizedCancelled[]`,
  `counts`, `nextCursor`.
- **By refs** `GET /api/surveys?refs=<key>,…`: same body for exactly the keys
  named, ≤ 200 per call, exclusive with `filter/cursor/q/limit`. A ref missing
  from the answer is rolled back or unknown — not an error. Built for "a host
  that mirrors a chosen subset and reads the surveys it holds".
- **Responded** `GET /api/responded?credentials=key:<hex>,…`: ≤ 20 credentials,
  `credentialKey` form (`key:`/`script:` + hex); for a DRep response the stored
  credential is the DRep key hash (`credentialKey(response.credential)`).
  Answers `{surveyKeys[], fetchedAt}` = `SELECT DISTINCT survey_key FROM response
  WHERE credential IN (…)`: "a response from this credential is indexed", with
  no verdict and no tx hash.
- **Survey key** canonical form: `<64 hex>:<index>` with no leading zeros on
  the index (`:01` names nothing).
- **Bundle** `GET /api/surveys/{tx}/{i}` and the **artifact** routes are not
  read by the MVP (§2). For reference: responses page 200 at a time; `verdicts`
  is keyed `<tx>:<idx>` and holds *decided* proof verdicts only (absent =
  pending, which the live tally still counts); artifacts 404 while a survey is
  open.
- **Health**: `GET /health` → `{ok, network}` (the network guard);
  `GET /api/health` → operational metrics including `commit`.

## 5. Packages to add

Two published packages, both with a negligible dependency footprint:

| Package | Why | Deps |
| :-- | :-- | :-- |
| `cip-179` (`0.3.0`) | Types, `Role`, `fromJsonSafe` (from `cip-179/tally` — Tessera's `$bytes`/`$bigint` wire form), `METADATA_LABEL`, and `cip-179/evolution`'s `toTxMetadatum` for the write path | `@noble/hashes`; `@evolution-sdk/evolution` an **optional** peer, already a DRepTalk dependency at `^0.5.11` |
| `cardano-tessera-respond` (`0.1.3`) | The `<tessera-respond>` custom element | **none** — Solid, respond-core and the codec are bundled into the artifact |

Nothing new enters the surface of the `npm audit --omit=dev --audit-level=high`
gate CI runs on production dependencies.

Check `@evolution-sdk/evolution` version skew between DRepTalk's `^0.5.11` and
what `cip-179/evolution` is built against before increment 6.

## 6. Increments

Each increment after the first ends in one commit — Conventional Commits,
imperative subject — with `npm run preflight` green. It mirrors the CI `check` job gate for gate and in
order: routed-pages guard, `typecheck`, `lint`, `test`, `build`, built-artifact
guard, then `npm audit --omit=dev --audit-level=high` on production deps. The
first three are the inner loop while working; preflight is what a commit is held
to.

Two of those gates constrain this work directly. Astro routes every supported
file under `src/pages` that is not underscore-prefixed, so a test for a route
lives in a colocated `__tests__/` folder or it ships as a public production
route. And the built artifact must stay free of `cloudflare:test` imports.

### 1 — Local preprod loop

No product code and no commit: a checkpoint. `npm ci`,
`npm run db:migrate:local`, `npm run db:seed:local`, `npm run dev`. Run a
governance sync by hand (`npm run sync:dev`, then curl `/__scheduled` with one
of the three cron expressions from `src/lib/freshness.ts`) and sign in with the
preprod DRep wallet.

*Done when:* signed in locally as `drep` against preprod and able to post.

### 2 — Config and the Tessera client

`src/lib/tessera/client.ts`: `surveyList({ filter, cursor })`,
`surveysByRefs(keys)`, `responded(credentials)`, `health()`, built on
`src/lib/http/fetchWithTimeout.ts` and decoding through `fromJsonSafe`.
Injectable fetch, following the `_setFetchImpl` idiom of
`src/pages/api/koios/[...path].ts`, so it is testable in the node project. A
503 `snapshot not ready` decodes to an explicit "not ready" result rather than
throwing, so the sync phase can record zero items and move on.

`TESSERA_BACKEND_URL` as a Worker var, preprod only:

- gov-sync: `[env.preprod.vars]` in `workers/gov-sync/wrangler.toml`.
- app worker: `cfg.vars` in `scripts/preprod-config.mjs`, next to
  `CARDANO_NETWORK: 'preprod'`. **Not** an `[env.*]` block in the app
  `wrangler.toml` — the Cloudflare adapter drops those at build time, which is
  why the preprod config is derived at all. Pages read it through the same
  runtime `env` the auth routes read `CARDANO_NETWORK` from.

The feature is on iff it is non-empty — that is also the maintainer's off switch.
The client refuses a backend whose `/health` network differs from
`CARDANO_NETWORK`; Tessera's own app does this, and the equivalent mistake once
wrote preview data into a preprod database.

*Done when:* node tests cover a list decode, a refs decode, a responded decode,
the not-ready result, and a network-mismatch refusal.

### 3 — Schema and the sync phase

Migration `0081_surveys.sql` (0080 is the current high-water mark; note the
numbering has historical duplicates at 0040/0041/0067/0073):

- `survey` — `ref` (`<txHashHex>:<index>`) PK, `topic_id`, `title`, `end_epoch`,
  `eligible_roles` (JSON int array), `sealed`, `cancelled`, `external_content`,
  `definition` (Tessera wire-form JSON), `response_count`, `tip_epoch`,
  `tessera_fetched_at` (the snapshot the row reflects — the "as of" time),
  `submitted_at`, `synced_at`.
- `survey_gov_link` — `(survey_ref, action_id)` PK, `title`; index on
  `action_id`, which joins `governance_actions.proposal_id` (both bech32
  `gov_action1…`; already indexed by migration 0077).
- `survey_response_local` — `(survey_ref, user_id)` PK, `tx_hash`,
  `credential` (the `key:<hex>` form, derived at record time so the sync never
  has to re-derive it), `created_at`.

`src/lib/surveys/sync.ts` mirrors `src/lib/governance/sync.ts`. One phase,
three passes:

1. **Discover.** Page `/api/surveys?filter=<per the admission rule>` to the
   end, restarting from page one on `resync`. Admission is one predicate,
   `admits(record, links, importedActionIds)`, so the Open question above is a
   one-line change. For each admitted survey not yet held:
   `createTopic({ categorySlug: 'surveys', authorId: GOV_SYNC_AUTHOR,
   source: 'survey', title, bodyMd, bodyHtml, postedAt: <survey block time>,
   batchWith: <insert the survey row> })` — the same atomic batch that keeps a
   partial write from leaving an orphan topic the next run would duplicate.
2. **Refresh held.** `?refs=` over every held survey not yet closed, in chunks
   of 200: upsert `response_count`, `cancelled`, links, `tip_epoch`,
   `tessera_fetched_at`. A ref absent from the answer is logged and left alone
   (rolled back or unknown upstream; rare, and a thread that exists stays).
3. **Settle pending.** `survey_response_local` rows grouped by credential, ≤ 20
   per `/api/responded` call; see increment 7 for the settle rule.

`source: 'survey'` is a third value of a union that is `'user' | 'governance'`
today. Extend it in `src/lib/db/forum.ts` (`createTopic`'s `source`, the row
types) and walk the consumers that branch on `=== 'governance'` — they all fall
into the non-governance branch for a survey topic, which is right, but each is
checked, not assumed: `src/pages/t/[slug].astro:120`,
`src/lib/forum/activityFeed.ts:106,130`, `src/lib/db/search.ts:459`,
`src/lib/cip100/reconcile.ts:75`, `src/lib/notifications/pendingLead.ts:197`,
`src/pages/notifications.astro:224`. No activity event is emitted (§2).

Wire it into `workers/gov-sync/src/index.ts` as one phase under `recordSyncRun`
on the `*/5` trigger (a few HTTP calls plus a few writes — it does not belong
behind the `minute % 15` gate for heavy work). When `TESSERA_BACKEND_URL` is
empty the phase is not registered at all, so mainnet's `/debug/sync` never
shows it.

*Done when:* a local sync creates one topic per admitted preprod survey,
`/debug/sync` shows the phase with its item count, and a second run changes
nothing.

### 4 — Category and pages

`config/categories.ts` gains `{ slug: 'surveys', name: 'Surveys', kind: 'survey',
position: … }`, extending `CategoryKind` (see §7). `isDiscussion()` already
hides the composer (`src/pages/c/[slug].astro:211`) and refuses user topic
creation (`src/lib/forum/handlers.ts:161`) for any non-discussion kind, so the
category is read-only for free. **No `NAV_LINKS` entry** (§2). The category is
static config and ships to mainnet: when `TESSERA_BACKEND_URL` is empty,
`/c/surveys/` renders an explicit "Surveys are not indexed on this network"
state instead of an empty list.

`src/components/survey/` mirrors `src/components/ga/`: a card above the thread's
posts carrying title, description, questions, eligible roles, `end_epoch` with
its deadline, the deduped response count, a deep link to the survey on Tessera,
and the "as of" time from `tessera_fetched_at` — and no tally figure of any
kind (§2) — every value here is
chain-derived and cached, so it shows its age like every other on-chain value on
the site. The card reads D1 only; no `pageCache`/`serviceUnavailable` wiring is
needed because there is no live upstream on the page path.

`src/pages/s/[ref].astro` resolves a survey ref and redirects to `/t/<slug>/`,
mirroring `src/pages/ga/[id].astro`.

*Done when:* `/c/surveys/` lists the admitted preprod surveys and each thread
renders its definition, deadline and response count; with the var unset, the
category page shows the not-indexed state.

### 5 — Governance linkage, both directions

On the survey card: *Linked by N governance actions*, each resolved through
`governance_actions.proposal_id` to its own thread. On a governance action's
thread: *Linked survey* — at most one, by construction — beside the existing
`RelatedActionsCard`.

CIP-179 requires the survey's `end_epoch` to equal the action's expiry epoch for
a link to be valid; Tessera enforces that before it reports a link, so DRepTalk
renders what it is given and re-checks nothing. Tessera's interop record is
explicit that a link is a discovery relation, not evidence the proposer and the
survey owner are one party: the label is "linked by", never "official".

*Done when:* with a linked preprod survey present, both directions render; on a
governance action with no link, the section does not appear.

### 6 — Answering

`src/components/survey/RespondPanel.astro` renders a `<tessera-respond>` element
and a connect button, server-side gated to a session holding the `drep` role and
to a survey whose eligible roles include DRep and whose deadline has not passed.
A sibling bundled `<script>` — **not** `is:inline`, so Astro hashes it into the
CSP itself and `astro.config.mjs`'s explicit `hashes` array needs no new entry —
imports the element, assigns its props and listens for its events.

- Wallet through the existing `connectAsDrep` — CIP-95 enable, network guard,
  DRep key hash derivation, registered-DRep preflight. Unchanged.
- Object-valued props are assigned as **DOM properties**, never attributes:
  `el.definition`, `el.surveyRef`, `el.responder`, `el.tipEpoch` (from the
  mirrored `tip_epoch`; a 5-minute-old tip is harmless against a 5-day epoch),
  `el.cancelled`. `responder` is `{ [Role.DRep]: { type: 'key', keyHash } }`.
  The element renders nothing until every required prop is set, which is the
  intended pattern.
- On `tessera:response` (`RespondResult`: `payload`, `proveCredentials`,
  `role`, `credential`, `sealed`), build with evolution-sdk:
  `attachMetadata({ label: 17n, metadata: toTxMetadatum(payload) })`, then
  `addSigner({ keyHash })` for each entry in `proveCredentials` — CIP-179
  mechanism A. Keep the existing `dreptalkCip20Metadatum()` at label 674; a
  different label, so no conflict with CIP-179's one-payload-per-transaction
  rule (Tessera reads only label 17).
- Sign and submit through the wallet, reusing `voteFlowClient`'s `PreSignError`
  taxonomy so failures before signing read differently from failures after.

*Done when:* a preprod DRep answers a survey from a DRepTalk thread and the
transaction confirms on chain.

### 7 — Optimistic record

`POST /api/survey/response/record`, mirroring `src/pages/api/vote/record.ts`:
session-gated, zod-validated `{ surveyRef, txHash }`, the responder credential
derived from the session — never trusted from the client — and stored in its
`key:<hex>` form. Writes `survey_response_local`.

The survey card overlays *Your answer · confirming…* from that row. Settling
the row is pass 3 of the sync phase: `GET /api/responses/{txHash}` per pending
row (always a handful); the row is deleted once Tessera reports the tx indexed.
The overlay says *confirming…* and then disappears — nothing about validity. A
response built by `<tessera-respond>` and proven by DRepTalk's own transaction
path is valid in practice, and "counted" in the final sense is only knowable
at finalization anyway (membership and dedup are decided at `end_epoch`), so
there is no honest intermediate state worth a word. The response count on the
card does the rest.

Worst-case visible latency without the overlay is Tessera's own `*/3` cron plus
DRepTalk's `*/5` — around eight minutes.

*Done when:* the answer appears immediately after submit and the overlay clears
on its own; a replacement response shows the same cycle again.

### 8 — Freshness, docs, PR

Add a row to `src/lib/freshness.ts` **and** to
`src/content/guides/data-freshness.md`; `freshness.table.test.ts` reads the
markdown table and fails CI if the two disagree. Mention the feature in the
README's stack section. Delete this document: its Decisions move into the PR
description, and `docs/` keeps only the contributor-facing pair.

PR against upstream `main`: `feat: index CIP-179 surveys and let DReps answer
them`. The description should say surveys are read from Tessera's HTTP API,
that DRepTalk does no label-17 indexing of its own, and that no page request
reads Tessera — otherwise a reviewer reads it as the design both sides rejected.

## 7. Decisions

- **List mirrored into D1; no Tessera read on a page request.** Supersedes the
  earlier "bundle fetched per request": the MVP renders nothing the list does
  not carry, so the bundle fetch bought only an exception to "SSR reads D1 only"
  and the error handling around it. Reversible — the bundle and artifact routes
  are there when results rendering lands, and the natural home for reading them
  is the same sync phase (the artifact is immutable and content-addressed, so it
  is a one-time mirror).
- **Admission rule: open** (see Open). The predicate is isolated so the answer
  costs one line; the rest of the plan does not depend on it.
- **`CategoryKind` gains `'survey'`** rather than reusing `'governance'` or
  `'discussion'`. Reusing either would make `isDiscussion()` — which drives
  category sort modes, the composer and topic creation — answer a question about
  surveys that nobody asked.
- **`topics.source` gains `'survey'`** rather than reusing `'governance'`. Ten
  consumers branch on `=== 'governance'` to mean "this thread is a governance
  action" (discussion-tab deep links, the CIP-100 reconcile author rule, search
  ranking); a survey thread must fall into their other branch.
- **No result figure of any kind in the MVP.** CIP-179 does not mandate a
  tally; Tessera's weighted and unit-weight views are its own profile and the
  survey maker owns the counting policy. Showing a DRepTalk-side "leading
  option" would present one profile as the result. Revisit when
  `<tessera-results>` exists and can state its policy itself.
- **No nav link, no activity event, in the MVP.** Both are static or
  schema-level surfaces that would show on mainnet with the feature off; both
  are one-line additions once the maintainer wants them.
- **External-content surveys are listed but not answerable.** Their titles and
  prompts live in an off-chain document behind a `content_anchor`; Tessera's API
  does not serve it, and dereferencing means IPFS gateway calls from a cron.
  They render with a ref-derived title and an explicit "presentation document
  not loaded" note rather than blank prompts. Reversible: the published
  `cip-179/content` entry point fetches and hash-verifies in one call.
- **Mechanism A only.** Mechanism B — the response bound to a governance vote
  cast in the same transaction, which is *the* interesting shape for a DRep on a
  linked action — needs the linked-action set and a combined vote+response
  transaction. Deferred, not rejected.
- **Preprod gating by `TESSERA_BACKEND_URL` presence**, plus a `/health` network
  match. One switch, and it belongs to whoever deploys.

## 8. Risks and open items

- evolution-sdk version skew between DRepTalk and `cip-179/evolution`.
- Widget bundle weight — measure the survey thread page before the PR. The
  sealed-encryption code splits into lazy chunks, so a public-survey page should
  not pay for it.
- **The maintainer may want a different shape** — no `topics` rows at all, or
  a different admission rule. This document is up for exactly that: the
  thread-per-survey decision, the admission rule and the no-nav-link choice
  are the things to settle on it before increment 3 starts.
