# CIP-179 surveys in DRepTalk — MVP

> **Status: design for review.** Pushed as the first commit of the feature
> branch so the shape can be discussed before any code exists (the thread is
> katomm/dreptalk.com#379); the increments land on the same branch behind it.
> Like the earlier `docs/specs/` documents, it is deleted by the last increment.
> Paths are read against `f967e48` on the DRepTalk side and Tessera's
> `backend/server/src/http.ts` of 2026-08-21 — re-check before relying on
> them. Revised 2026-08-25 to answer the maintainer's review on the PR.

## Progress

_(one line per completed increment; record deviations here)_

- 2026-08-25 — design revised for the maintainer's review: audited DRep count
  from the bundle, refresh-until-final lifecycle, the rollback rule, tx-exact
  settling with a failed state, bounded discovery. No code yet.

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

**DRepTalk admits a survey when it is DRep-eligible *and* linked by a governance
action DRepTalk has imported** (maintainer's decision, 2026-08-21). Linkage is a
discovery relationship an action opts into through its CIP-108 anchor: it
changes nothing about who may respond or how a survey is counted, so the gate is
a DRepTalk editorial policy about what belongs on a Cardano governance forum,
never a claim about the survey.

**An admitted survey is a first-class thread in its own category, not a
sub-element of the action that links it.** The gate makes the obvious
alternative — render the survey as a card on the linking action's thread and
open no topic at all — genuinely cheaper than it was: no new category, no new
`CategoryKind`, no new `topics.source`, no `topic_id`. Three things still argue
against it:

- The relation is N-to-1, not 1-to-1: an action's anchor names *at most one*
  survey through `body.cip179`, while a survey may be linked by several actions.
  Card-on-the-action renders that survey in several places with no canonical
  one, so `/s/<ref>` has no single destination and its discussion has no single
  home.
- A survey and an action are different objects to discuss. The questions asked,
  and how a DRep reads them, is not the debate about the action's merits; one
  thread for both merges two conversations that happen to share a deadline.
- **The gate is policy, and policy moves.** It is DRepTalk's rule about what to
  show, not a property of surveys — the same maintainer described gating as "a
  policy layer deserving its own review". A data model that assumes every survey
  has a host action has to be rebuilt the day a standalone DRep survey is worth
  showing; a category costs one value in each of two unions and survives any
  widening.

The cost is honest and small: `CategoryKind` and `topics.source` each gain a
value (§7), and the category ships to every network as static config
(increment 4).

**What this MVP has to prove:** a DRep signed into DRepTalk on preprod can find
an open, DRep-eligible CIP-179 survey, answer it, and see the answer land on
chain and come back through the index.

## 2. Scope

**In.**

- Preprod only.
- gov-sync mirrors the admitted surveys — DRep-eligible and linked by an
  imported action — from Tessera's survey list into D1: DRepTalk's own knowledge
  of what exists, since SSR pages read only DRepTalk's storage.
- The per-survey response bundle, read by the same sync — never by a page — to
  derive the audited DRep response count each card shows (increment 3).
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
  (`backend/ARCHITECTURE.md` §9). So the survey card shows the audited DRep
  response count (increment 3) and links to Tessera's survey page, and presents
  **no figure as "the result"** — not a percentage, not a leading option, not a
  weighted or unweighted breakdown. The named follow-up is a live *weighted*
  estimate for DRep questions on public surveys: DRepTalk already syncs
  per-epoch DRep voting power, and Tessera's tally math is published and takes
  weights as inputs (`weightedTallySurvey`), so it waits on presentation, not
  on data — and on nothing in this PR.
- Reading the artifact routes. Results are out of scope, and the artifact is
  immutable and content-addressed — a one-time mirror for whenever results
  rendering lands. (The response *bundle* moved into scope for the audited
  count; the sync reads it, and pages stay D1-only.)
- Sealed surveys as a *tested* path. The widget encrypts them client-side with
  no host involvement, so nothing blocks them; the acceptance run targets a
  public survey.

## 3. Prerequisites

**Tessera side.**

- Backend: `https://tessera-backend-preprod.matthieu-pizenberg.workers.dev`.
- **The acceptance survey, which the admission rule makes a compound object:**
  DRep-eligible, linked by a real preprod governance action, and still open at
  increment 6. Since CIP-179 requires a survey's `end_epoch` to equal its
  linking action's expiry epoch, the two cannot be created independently — the
  survey must exist first (the anchor names its ref) with its `end_epoch` set to
  the epoch the not-yet-submitted action will expire at, and the action follows
  carrying that anchor. `1200298ce001b907801909c18e6a4d55eee587e1bc3c1d4b24cfc4662ecd2d23:0`
  is the known linked survey; if it is not DRep-eligible or has closed, a fresh
  pair is the long-lead item of the whole plan and is worth starting before
  increment 3. (`ccaa8baa…1547:0` from `interop/preprod.md` is DRep-eligible but
  standalone, so under this rule DRepTalk never sees it — it is still useful for
  testing the client and the widget in increments 2 and 6.)
- `GET /api/responses/{txHash}` in Tessera before increment 7: the responses
  that transaction carried (`surveyKey`, `responseIndex`, `role`, `credential`,
  `slot`) — a primary-key prefix read, no new index, no change to any existing
  payload. Decided 2026-08-21, confirmed 2026-08-25. `/api/responded` as it
  exists cannot tell a *replacement* response from the one it supersedes, and
  the interop sequence's step 6 is a replacement. There is no fallback:
  increment 7 waits for it.
- `finalState` on Tessera's list rows — `finalized` (with the artifact hash),
  `cancelled`, or `untalliable` — so a mirror knows when a closed survey is
  decided for good and can stop refreshing it. Agreed 2026-08-25: today the
  untalliable outcome (spec-invalid definition, refuted owner proof) is
  computed at finalization and discarded, so "no artifact yet" cannot be told
  apart from "never will be one". **Not a blocker**: until it ships, pass 2
  keeps refreshing every held survey that is not `finalizedCancelled`, and
  adopts `finalState` as the stop condition when it exists.

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
  GET /api/surveys?filter=linked&limit&cursor  discover: records, govLinks, counts, tip
  GET /api/surveys?refs=a:0,b:1,…          refresh held not-yet-final surveys (≤200 refs)
  GET /api/surveys/{tx}/{i}                bundle: responses + verdicts → audited DRep count
  GET /api/responses/{txHash}              settle pending local rows (prerequisite, §3)
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
renders — definition, eligible roles, end epoch, cancelled, the audited DRep
response count, links, tip epoch, `fetchedAt` — is mirrored by the sync from
the list and bundle payloads, so the survey thread is a pure D1 read like every other page. The 5-minute
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
  latest-valid-wins dedup, **summed across roles and with no validity, proof
  or deadline filter** — the sync's change detector, never the displayed
  count), `finalizedCancelled[]`, `counts` (whole-set sizes per chip —
  `counts.linked` is the size of the entire linked set), `nextCursor`, and
  `incomplete: true` when the snapshot may be missing transactions (a dropped
  batch, a page cap) — the rollback rule in increment 3 keys on its
  **absence**.
- **By refs** `GET /api/surveys?refs=<key>,…`: same body for exactly the keys
  named, ≤ 200 per call, exclusive with `filter/cursor/q/limit`. A ref missing
  from the answer is rolled back or unknown, and only a body without
  `incomplete` can tell the two apart — Tessera's own refresh states the rule:
  an unfetched tx is indistinguishable from a vanished one. Built for "a host
  that mirrors a chosen subset and reads the surveys it holds".
- **Responses by tx** `GET /api/responses/{txHash}` (prerequisite, §3): the
  responses that transaction carried — `surveyKey`, `responseIndex`, `role`,
  `credential`, `slot`. "Indexed", nothing more: counted is decided at
  `end_epoch`. The existing `/api/responded` is deliberately not used — it
  answers per credential with no tx hash, so it cannot tell a *replacement*
  response from the one it supersedes.
- **Survey key** canonical form: `<64 hex>:<index>` with no leading zeros on
  the index (`:01` names nothing).
- **Bundle** `GET /api/surveys/{tx}/{i}`: one survey's raw responses (200 per
  page) plus `verdicts`, keyed `<tx>:<idx>` and holding *decided* proof
  verdicts only — an absent key is pending, and a pending response stays
  counted: "not yet checked" must never display as "failed". Read by the
  sync's audit pass (increment 3). The **artifact** routes are not read by the
  MVP (§2); they 404 while a survey is open.
- **Health**: `GET /health` → `{ok, network}` (the network guard);
  `GET /api/health` → operational metrics including `commit`.

## 5. Packages to add

Two published packages, both with a negligible dependency footprint:

| Package | Why | Deps |
| :-- | :-- | :-- |
| `cip-179` (`0.3.0`) | Types, `Role`, `fromJsonSafe` (from `cip-179/tally` — Tessera's `$bytes`/`$bigint` wire form), `auditResponses` (from `cip-179/domain` — the ruleset-pinned counting the audit pass runs), `METADATA_LABEL`, and `cip-179/evolution`'s `toTxMetadatum` for the write path | `@noble/hashes`; `@evolution-sdk/evolution` an **optional** peer, already a DRepTalk dependency at `^0.5.11` |
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
`surveysByRefs(keys)`, `surveyBundle(ref)`, `responsesByTx(txHash)` (against
the agreed shape — §3), `health()`, built on
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

*Done when:* node tests cover a list decode, a refs decode, a bundle decode, a
responses-by-tx decode against the agreed shape, the not-ready result, and a
network-mismatch refusal.

### 3 — Schema and the sync phase

Migration `0081_surveys.sql` (0080 is the current high-water mark; note the
numbering has historical duplicates at 0040/0041/0067/0073):

- `survey` — `ref` (`<txHashHex>:<index>`) PK, `topic_id`, `title`, `end_epoch`,
  `eligible_roles` (JSON int array), `sealed`, `cancelled`, `external_content`,
  `definition` (Tessera wire-form JSON), `counted_dreps` (the audited DRep
  count the card shows — pass 3), `claimed_count` (the list's raw
  `responseCounts` value — pass 3's change detector, never rendered),
  `final_state` (NULL until the survey is decided for good; `cancelled` from
  `finalizedCancelled` today, `finalized`/`untalliable` once Tessera ships
  `finalState`), `unavailable` (rolled back upstream — hides answering, keeps
  the thread), `tip_epoch`, `tessera_fetched_at` (the snapshot the row
  reflects — the "as of" time), `submitted_at`, `synced_at`.
- `survey_gov_link` — `(survey_ref, action_id)` PK, `title`; index on
  `action_id`, which joins `governance_actions.proposal_id` (both bech32
  `gov_action1…`; already indexed by migration 0077).
- `survey_response_local` — `(survey_ref, user_id)` PK, `tx_hash`,
  `credential` (the `key:<hex>` form, derived at record time so the sync never
  has to re-derive it), `status` (`pending` | `failed` — the
  `drep_votes.local_status` lifecycle), `created_at`.
- `survey_sync_state` — one row: the last seen `counts.linked`, the time of the
  last complete walk of the linked set (pass 1) and of the last unconditional
  re-audit (pass 3).

`src/lib/surveys/sync.ts` mirrors `src/lib/governance/sync.ts`. One phase,
four passes:

1. **Discover.** Read page one of `/api/surveys?filter=linked` (limit 200) —
   its `counts.linked` is the size of the entire linked set, so while that set
   fits one page (dozens, for the foreseeable future) every run re-evaluates
   all of it for the price of one request. Walk past page one — restarting on
   `resync` — only when `counts.linked` moved since the last complete walk,
   when this run's governance phase imported new actions (the DRepTalk half of
   admission turning true late), or when the daily backstop in
   `survey_sync_state` is due: the steady-state cost stays flat as the archive
   grows, and admission is never frozen. Admit a survey when its
   `eligibleRoles` contains DRep **and** at least one of its `govLinks` names
   an action already in `governance_actions.proposal_id`. `eligibleRoles` is
   fixed in the on-chain definition, but the link half can turn true later —
   Tessera resolves a few anchors per refresh, and an action DRepTalk has not
   yet imported arrives on its own `*/5` run — so a survey that misses is
   simply admitted by a later run, which is why the pass re-evaluates rather
   than tracking what it has rejected. There is no status condition: a closed
   linked survey still gets its thread, so the first run backfills the linked
   archive (a handful, on preprod). For each admitted survey not yet held:
   `createTopic({ categorySlug: 'surveys', authorId: GOV_SYNC_AUTHOR,
   source: 'survey', title, bodyMd, bodyHtml, postedAt: <survey block time>,
   batchWith: <insert the survey row> })` — the same atomic batch that keeps a
   partial write from leaving an orphan topic the next run would duplicate.
2. **Refresh held.** `?refs=` over every held survey whose `final_state` is
   NULL, in chunks of 200: upsert `claimed_count`, `cancelled`, links,
   `tip_epoch`, `tessera_fetched_at`, and `final_state` when the answer decides
   one. A *closed* survey stays in this set on purpose: `end_epoch` is
   inclusive and Tessera's validation is incremental, so responses and verdicts
   keep landing after the deadline — a row freezes at `final_state`, never at
   close. A held ref absent from an answer that carries no `incomplete` is
   rolled back: set `unavailable`, which hides the answering panel and puts an
   "on-chain record no longer found" note on the card — the thread and its
   discussion stay, and a later answer containing the ref clears the flag.
   When the body says `incomplete: true`, absence proves nothing (an unfetched
   tx is indistinguishable from a vanished one) — leave every row untouched.
3. **Audit counts.** For each held survey whose `claimed_count` changed, whose
   `tip_epoch` crossed `end_epoch`, or on the unconditional daily re-audit (a
   proof verdict can flip from pending to refuted without the claimed count
   moving): fetch the bundle and run Tessera's published
   `auditResponses(responses, definition, verdicts)` — drop after-deadline,
   then invalid, then proof-refuted, then dedupe latest-valid-wins — and store
   `counted_dreps` as the counted records whose role is DRep. Same code the
   ruleset pins, so the number always agrees with what Tessera itself will
   count; per-role because roles are independent electorates, and a mixed sum
   on a DRep forum reads as "how many DReps answered" when it is not.
4. **Settle pending.** `GET /api/responses/{txHash}` per pending
   `survey_response_local` row (always a handful); see increment 7 for the
   settle rule.

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

*Done when:* a local sync creates one topic per admitted preprod survey with
an audited `counted_dreps`, a DRep-eligible standalone survey and a linked
non-DRep survey are both correctly absent, `/debug/sync` shows the phase with its item count, and a second run
changes nothing.

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
its deadline, the audited DRep count labelled "N DRep responses counted", a
deep link to the survey on Tessera, and the "as of" time from
`tessera_fetched_at` — and no tally figure of any kind (§2) — every value here
is chain-derived and cached, so it shows its age like every other on-chain
value on the site. An `unavailable` survey keeps its card and thread, with an
"on-chain record no longer found" note where the answering panel would be. The
card reads D1 only; no `pageCache`/`serviceUnavailable` wiring is
needed because there is no live upstream on the page path.

`src/pages/s/[ref].astro` resolves a survey ref and redirects to `/t/<slug>/`,
mirroring `src/pages/ga/[id].astro`.

*Done when:* `/c/surveys/` lists the admitted preprod surveys and each thread
renders its definition, deadline and counted DReps; with the var unset, the
category page shows the not-indexed state.

### 5 — Governance linkage, both directions

On the survey card: *Linked by N governance actions*, each resolved through
`governance_actions.proposal_id` to its own thread. Under the admission rule N
is never zero, so the section is unconditional there; the render still handles
several links, which is the case the whole thread-per-survey shape exists for.
On a governance action's thread: *Linked survey* — at most one, by construction,
and absent on almost every action — beside the existing `RelatedActionsCard`.

CIP-179 requires the survey's `end_epoch` to equal the action's expiry epoch for
a link to be valid; Tessera enforces that before it reports a link, so DRepTalk
renders what it is given and re-checks nothing. Tessera's interop record is
explicit that a link is a discovery relation, not evidence the proposer and the
survey owner are one party: the label is "linked by", never "official".

*Done when:* both directions render for the acceptance pair, and the section is
absent on a governance action that links no survey — the common case.

### 6 — Answering

`src/components/survey/RespondPanel.astro` renders a `<tessera-respond>` element
and a connect button, server-side gated to a session holding the `drep` role and
to a survey whose eligible roles include DRep, whose deadline has not passed,
and that is neither `cancelled` nor `unavailable`.
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
the row is pass 4 of the sync phase: `GET /api/responses/{txHash}` per pending
row (always a handful); the row is deleted once the answer names a response
for this survey — the exact transaction, not merely "this credential
responded", which is what makes a replacement observable. A row still
`pending` past the same cutoff the GA-vote sweep uses is marked `failed` — the
`drep_votes.local_status` lifecycle exactly — and the overlay turns into
*didn't confirm — you can answer again*. Until then the overlay says
*confirming…* and nothing about validity: a response built by
`<tessera-respond>` and proven by DRepTalk's own transaction path is valid in
practice, and "counted" in the final sense is only knowable at finalization
anyway (membership and dedup are decided at `end_epoch`), so there is no
honest intermediate state worth a word. The audited count on the card does the
rest.

Worst-case visible latency without the overlay is Tessera's own `*/3` cron plus
DRepTalk's `*/5` — around eight minutes.

*Done when:* the answer appears immediately after submit and the overlay clears
on its own; a replacement response shows the same cycle again; a row whose tx
never lands ages to *didn't confirm*.

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
- **The displayed count is the audited DRep count, derived from the bundle**
  (2026-08-25, from the maintainer's review). The list's `responseCounts` —
  the earlier plan's display value — filters nothing and sums across roles:
  inflatable by anyone (label 17 is cheap) and mixing electorates the tally
  keeps separate. Tessera's published `auditResponses` is the counting its
  ruleset pins, so deriving from the bundle adds no second implementation of
  any CIP-179 rule — the line §1 draws stays intact. The list count survives
  only as `claimed_count`, the change detector deciding when to re-audit.
- **A held survey refreshes until `final_state`, never freezing at close**
  (2026-08-25). The earlier "refresh what is not yet closed" froze a survey at
  whatever snapshot its deadline happened to land on, while `end_epoch` is
  inclusive and verdicts land incrementally. Terminal today means
  `finalizedCancelled`; Tessera is adding `finalState`
  (finalized/cancelled/untalliable) because the untalliable outcome is
  currently invisible to mirrors — until it ships, a closed uncancelled survey
  simply keeps refreshing, which preprod volumes make free.
- **A ref missing from a complete snapshot means rolled back → `unavailable`**
  (2026-08-25). The earlier log-and-keep left DRepTalk inviting answers to a
  survey that no longer exists on chain. `unavailable` hides the answering
  panel and keeps the thread; a survey that reappears clears it. When the
  snapshot says `incomplete`, absence proves nothing and every row is left
  untouched.
- **Pending rows settle by `GET /api/responses/{txHash}` and age to `failed`**
  (2026-08-25) — the `drep_votes.local_status` lifecycle DRepTalk already runs
  for governance votes, with the settle read swapped for the tx-exact route.
  `/api/responded` was the earlier settle read and is replacement-blind;
  Tessera's `/api/tx_status` is its own frontend's submit-flow tool, and a
  cron mirror has no use for a live confirmation feed when "indexed by
  Tessera" is the event the overlay actually waits on.
- **Admission: DRep-eligible *and* linked by an imported action** (maintainer,
  2026-08-21). Alternatives were every survey Tessera reports, or DRep-eligible
  alone. The chosen rule keeps the forum to surveys that bear on Cardano
  governance as DRepTalk already indexes it, and it is the cheapest to compute:
  `filter=linked` narrows server-side and the rest is one join DRepTalk already
  has an index for. What it costs is real — a DRep-eligible standalone survey is
  invisible on DRepTalk, including one whose author expected a forum audience —
  and it is a *policy*, so the data model deliberately does not encode it (§1):
  widening later is an edit to one predicate, not a migration.
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
  `<tessera-results>` exists and can state its policy itself — and the first
  candidate is the live weighted DRep estimate (§2), which needs no new data
  on either side.
- **No nav link, no activity event, in the MVP.** Both are static or
  schema-level surfaces that would show on mainnet with the feature off; both
  are one-line additions once the maintainer wants them.
- **External-content surveys are listed but not answerable.** Their titles and
  prompts live in an off-chain document behind a `content_anchor`; Tessera's API
  does not serve it, and dereferencing means IPFS gateway calls from a cron.
  They render with a ref-derived title and an explicit "presentation document
  not loaded" note rather than blank prompts. Reversible: the published
  `cip-179/content` entry point fetches and hash-verifies in one call.
- **Mechanism A for the MVP; mechanism B later, for linked surveys.** A —
  the DRep key hash in `required_signers` — is the proof that exists for every
  survey at every moment, it is what the interop contract specifies, and it
  costs one entry for a key the DRep wallet signs with anyway. B is not a
  different way to prove the same thing: it proves the credential *by voting on
  one of the survey's linked actions in the same transaction*, so it exists only
  for a linked survey, only while the DRep is casting that vote, and never from
  the survey thread. Its place is the vote panel — "answer the linked survey
  with this vote", the label-17 payload attached to the vote transaction the
  existing `drepTx` path already builds — and even there it should ride with A:
  Tessera's verdict on a B-only response is `unknown` until the action's anchor
  resolves, while A proves immediately. Deferred, not rejected — and the
  admission rule has now made it the natural next feature, since every survey
  DRepTalk shows has an action a DRep can be voting on.
- **Preprod gating by `TESSERA_BACKEND_URL` presence**, plus a `/health` network
  match. One switch, and it belongs to whoever deploys.

## 8. Risks and open items

- evolution-sdk version skew between DRepTalk and `cip-179/evolution`.
- Widget bundle weight — measure the survey thread page before the PR. The
  sealed-encryption code splits into lazy chunks, so a public-survey page should
  not pay for it.
- **The acceptance pair is the long-lead item.** A DRep-eligible, linked, open
  preprod survey needs a governance action submitted against it with matching
  epochs (§3); nothing in increments 1–5 is blocked, but increment 6 cannot run
  without it. Start it early.
- **The narrowed rule reopens the presentation question, not the admission
  one.** With every shown survey linked, "card on the linking action's thread,
  no topic" is a smaller diff than a category; §1 argues it still loses on
  N-to-1, on merging two conversations, and on encoding a policy into the
  schema. Confirm with the maintainer before increment 3 — it is the last
  decision that would invalidate the migration.
