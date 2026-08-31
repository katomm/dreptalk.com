# CIP-179 surveys in DRepTalk — MVP

> **Status: design for review.** First commit of the feature branch so the
> shape can be discussed before code exists (thread: katomm/dreptalk.com#379).
> Deleted by the last increment, like earlier `docs/specs/` documents.
> Revised 2026-08-25 to answer the maintainer's review.

## Progress

_(one line per completed increment; record deviations here)_

- 2026-08-25 — revised for the maintainer's review: audited DRep count,
  refresh-until-final, rollback rule, tx-exact settling. No code yet.

---

## 1. What is being built

[CIP-179](https://github.com/cardano-foundation/CIPs/tree/master/CIP-0179)
puts surveys and polls in transaction metadata under label 17. Tessera is
the reference implementation: a browser app plus a serving backend that
scans the label, validates responses, and finalizes results.

Ownership split (agreed in #379): **Tessera owns the protocol behind its
HTTP API**; **DRepTalk owns wallet, transaction building, forum, and
presentation**. DRepTalk implements no CIP-179 rule of its own; it mirrors
Tessera's API into D1 as it mirrors Koios.

**Admission rule** (maintainer, 2026-08-21): a survey is shown when it is
DRep-eligible **and** linked by a governance action DRepTalk has imported.
Linkage is a discovery relation declared in the action's CIP-108 anchor; the
gate is editorial policy, not a claim about the survey.

**Each admitted survey is a thread in its own `surveys` category**, not a
card on the linking action's thread: links are N-to-1 (several actions may
link one survey), so a card has no canonical home and `/s/<ref>` no single
destination; the survey and the action are different discussions; and
admission is policy that will move — a category survives any widening.

**The MVP proves:** a DRep signed into DRepTalk on preprod can find an open
survey, answer it, and see the answer come back through the index.

## 2. Scope

**In.**

- Preprod only.
- gov-sync mirrors admitted surveys from Tessera's list into D1, and reads
  each survey's bundle — never from a page — to derive the audited DRep
  count the card shows.
- One auto-opened thread per admitted survey; category and thread pages read
  D1 only.
- DRep-only answering via `<tessera-respond>`; DRepTalk builds, signs and
  submits the transaction.
- Governance linkage in both directions; optimistic local record of a
  just-submitted response.

**Out, deliberately.**

- Mainnet and Preview.
- A nav link; activity-feed events; creating surveys; roles other than DRep.
- External-content surveys as an answerable path (§7).
- Results rendering, interim or final. CIP-179 does not specify tallying;
  Tessera's views are one profile. The card shows the audited DRep count and
  a deep link — no figure as "the result". Named follow-up: a live *weighted*
  estimate for DRep questions on public surveys (DRepTalk already syncs
  per-epoch DRep voting power; Tessera's tally math takes weights as inputs).
- The artifact routes: a one-time mirror for when results rendering lands.
- Sealed surveys as a *tested* path. Nothing blocks them; the acceptance run
  targets a public survey.

## 3. Prerequisites

**Tessera side.**

- Backend: `https://tessera-backend-preprod.matthieu-pizenberg.workers.dev`.
- **The acceptance survey** — DRep-eligible, linked, still open at
  increment 6. Its `end_epoch` = Koios `expiration` − 1 (DRepTalk's
  `expiryEpoch` is that +1): survey and vote close at the same boundary.
  Survey first, then the action, its anchor naming the ref.
  `1200298c…2d23:0` is the known linked survey; if unusable, a fresh pair
  is the long-lead item — start before increment 3. (`ccaa8baa…1547:0` is
  standalone: never admitted, still useful for testing.)
- `GET /api/responses/{txHash}` (agreed 2026-08-21, confirmed 2026-08-25):
  the responses one transaction carried — `surveyKey`, `responseIndex`,
  `role`, `credential`, `slot`. Needed because `/api/responded` cannot tell
  a *replacement* from the response it supersedes. No fallback: increment 7
  waits for it.
- `finalState` on list rows (agreed 2026-08-25): `finalized` (with artifact
  hash), `cancelled`, or `untalliable` — so a mirror knows when a closed
  survey is decided for good (today the untalliable outcome is computed and
  discarded). **Not a blocker**: until it ships, pass 2 keeps refreshing
  everything not `finalizedCancelled`.

**Where the work pauses.** Increment 6 needs the acceptance survey and
increment 7 the route above, so the branch stops after increment 5.

**DRepTalk side.** Branch `feat/cip179-surveys` off `main`. `.dev.vars` with
`CARDANO_NETWORK=preprod`, `KOIOS_API_KEY`, the new `TESSERA_BACKEND_URL`. A
preprod wallet with tADA and a registered **key** DRep credential
(`resolveDRep` rejects script DReps; mechanism A needs a key witness).

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
gov-sync worker  (*/5 cron, one entry in the phase registry)
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

**Nothing reaches Tessera from the browser** (the CSP `connect-src` blocks
it: no proxy route, no CSP amendment) **and nothing from a page request**:
everything rendered is mirrored into D1 by the sync, and the ~5-minute
staleness is shown as an "as of" time.

## 5. Packages to add

| Package | Why | Deps |
| :-- | :-- | :-- |
| `cip-179` (`0.3.0`) | Types, `Role`, `fromJsonSafe` (wire form), `auditResponses` (the ruleset-pinned counting), `METADATA_LABEL`, `cip-179/evolution`'s `toTxMetadatum` | `@noble/hashes`; `@evolution-sdk/evolution` an **optional** peer, already a DRepTalk dependency |
| `cardano-tessera-respond` (`0.1.3`) | The `<tessera-respond>` element | none — everything is bundled |

Check `@evolution-sdk/evolution` version skew against `cip-179/evolution`
before increment 6.

## 6. Increments

One commit per increment (after the first), `npm run preflight` green.

### 1 — Local preprod loop

No product code, no commit. Local setup per `docs/development.md`, one manual
sync, sign in with the preprod DRep wallet.

*Done when:* signed in locally as `drep` against preprod and able to post.

### 2 — Config and the Tessera client

`src/lib/tessera/client.ts`: `surveyList({ filter, cursor })`,
`surveysByRefs(keys)`, `surveyBundle(ref)`, `responsesByTx(txHash)` (§3),
`health()`. Injectable fetch, so it tests in the node project. A `503
snapshot not ready` decodes to a "not ready" result rather than throwing.

`TESSERA_BACKEND_URL` as a Worker var, preprod only: `[env.preprod.vars]` in
the gov-sync `wrangler.toml`, `cfg.vars` in `scripts/preprod-config.mjs` for
the app worker. The feature is on iff the var is non-empty — the maintainer's
off switch. The client refuses a backend whose `/health` network differs
from `CARDANO_NETWORK`.

*Done when:* node tests cover the four decodes, the not-ready result, and a
network-mismatch refusal.

### 3 — Schema and the sync phase

One migration (numbered when written; `0081`/`0082` are already taken):

- `survey` — `ref` (`<txHashHex>:<index>`) PK, `topic_id`, `title`,
  `end_epoch`, `eligible_roles` (JSON int array), `sealed`, `cancelled`,
  `external_content`, `definition` (wire-form JSON), `counted_dreps` (the
  audited count the card shows), `claimed_count` (the list's raw number —
  change detector, never rendered), `final_state` (NULL until decided for
  good), `unavailable` (rolled back upstream), `tip_epoch`,
  `tessera_fetched_at` (the "as of" time), `submitted_at`, `synced_at`.
- `survey_gov_link` — `(survey_ref, action_id)` PK, `title`; index on
  `action_id`, joining `governance_actions.proposal_id`.
- `survey_response_local` — `(survey_ref, user_id)` PK, `tx_hash`,
  `credential` (`key:<hex>`, derived at record time), `status`
  (`pending` | `failed`), `created_at`.
- `survey_sync_state` — one row: last seen `counts.linked`, time of the last
  complete walk (pass 1) and of the last unconditional re-audit (pass 3).

`src/lib/surveys/sync.ts` is one entry in the `*/5` registry of
`src/lib/sync/phases/`. Four passes:

1. **Discover.** Read page one of `?filter=linked` (limit 200); its
   `counts.linked` is the size of the whole linked set, so while that fits
   one page every run re-evaluates all of it for one request. Walk further
   only when the count moved, when this run imported new governance actions
   (the DRepTalk half of admission turning true late), or on the daily
   backstop. Admit when `eligibleRoles` contains DRep and a `govLink`
   matches `governance_actions.proposal_id`; a miss is re-evaluated next
   run, and a closed linked survey still gets its thread. Each admission:
   `createTopic({ …, source: 'survey', batchWith: <survey row> })`, atomic.
2. **Refresh held.** `?refs=` over every held survey with NULL `final_state`,
   chunks of 200: upsert `claimed_count`, `cancelled`, links, `tip_epoch`,
   `tessera_fetched_at`, `final_state` — 5 rows per statement, as
   `drepVotes.ts` `UPSERT_CHUNK` does: D1 caps bound params at 100 per
   query (~19 columns here) and miniflare ignores the cap. Closed surveys
   stay in this set — `end_epoch` is inclusive, verdicts land late, so a
   row freezes at `final_state`, never at close. A ref absent from a *complete*
   answer (no `incomplete` in the body) is rolled back: set `unavailable`
   (hides answering, keeps the thread; cleared if the ref reappears). From
   an incomplete answer, absence proves nothing — touch no row.
3. **Audit counts.** When a survey's `claimed_count` changed, its
   `tip_epoch` crossed `end_epoch`, or the daily re-audit is due (a verdict
   can flip without the count moving): fetch the bundle, run Tessera's
   published `auditResponses(responses, definition, verdicts)`, store
   `counted_dreps` = counted records with role DRep. Same code the ruleset
   pins; per-role because roles are separate electorates.
4. **Settle pending.** `GET /api/responses/{txHash}` per pending local row;
   settle rule in increment 7.

`topics.source` gains `'survey'`; every `=== 'governance'` consumer falls
into its neutral branch (the maintainer verified this against main). The
`when` gate holds the entry off while `TESSERA_BACKEND_URL` is empty.

*Done when:* a local sync creates one topic per admitted survey with an
audited `counted_dreps`; a DRep-eligible standalone survey and a linked
non-DRep survey are both absent; a second run changes nothing.

### 4 — Category and pages

`config/categories.ts` gains `{ slug: 'surveys', kind: 'survey', … }`,
extending `CategoryKind` (§7); `isDiscussion()` already makes the category
read-only. It ships to mainnet; with the var empty, `/c/surveys/` renders an
explicit "not indexed on this network" state.

`src/components/survey/` mirrors `src/components/ga/`: a card with title,
description, questions, eligible roles, deadline, the audited count labelled
"N DRep responses counted", a deep link to Tessera, and the "as of" time —
no tally figure of any kind (§2). An `unavailable` survey keeps its card and
thread, with an "on-chain record no longer found" note where the answering
panel would be. `src/pages/s/[ref].astro` redirects a ref to `/t/<slug>/`.

*Done when:* `/c/surveys/` lists the admitted surveys; each thread renders
definition, deadline, counted DReps; var unset shows the not-indexed state.

### 5 — Governance linkage, both directions

Survey card: *Linked by N governance actions*, each resolved to its thread.
Action thread: *Linked survey* — at most one by construction. Tessera
validates links; DRepTalk re-checks nothing. "Linked by", never "official".

*Done when:* both directions render for the acceptance pair; the section is
absent on an action with no linked survey.

### 6 — Answering

`RespondPanel.astro` renders `<tessera-respond>` plus a connect button,
server-side gated to a `drep` session and a survey that is DRep-eligible,
open, not `cancelled`, not `unavailable`. Its sibling script is bundled —
**not** `is:inline` — so Astro hashes it into the CSP automatically.

- Wallet via the existing `connectAsDrep`, unchanged.
- Object props are assigned as **DOM properties**, never attributes:
  `el.definition`, `el.surveyRef`, `el.responder`, `el.tipEpoch` (mirrored
  `tip_epoch` — a 5-minute-old tip is harmless against a 5-day epoch),
  `el.cancelled`. The element renders once every required prop is set.
- On `tessera:response`, build with evolution-sdk:
  `attachMetadata({ label: 17n, metadata: toTxMetadatum(payload) })`, then
  `addSigner({ keyHash })` per `proveCredentials` entry — mechanism A. The
  existing CIP-20 metadatum stays at label 674: different label, no conflict
  with CIP-179's one-payload-per-transaction rule.
- Sign and submit through the wallet, reusing `voteFlowClient`'s
  `PreSignError` taxonomy.

*Done when:* a preprod DRep answers a survey from a DRepTalk thread and the
transaction confirms on chain.

### 7 — Optimistic record

`POST /api/survey/response/record`, mirroring `api/vote/record.ts`:
session-gated, zod-validated `{ surveyRef, txHash }`, credential derived from
the session — never from the client. Writes `survey_response_local`.

The card overlays *Your answer · confirming…* from that row. Pass 4 deletes
the row once `GET /api/responses/{txHash}` names a response for this survey —
the exact transaction, which makes a replacement observable. A row still
`pending` past the GA-vote sweep's cutoff turns `failed`
(`drep_votes.local_status` lifecycle) and the overlay becomes *didn't
confirm — you can answer again*. The overlay never claims validity:
"counted" is only knowable at finalization. Worst-case latency ≈ 8 minutes
(Tessera's `*/3` cron plus DRepTalk's `*/5`).

*Done when:* the answer appears right after submit and the overlay clears on
its own; a replacement shows the same cycle; a tx that never lands ages to
*didn't confirm*.

### 8 — Freshness, docs, PR

Add the freshness row (both places; the drift test enforces the pair),
mention the feature in the README, delete this document (Decisions move into
the PR description). PR: `feat: index CIP-179 surveys and let DReps answer
them` — say explicitly that surveys come from Tessera's HTTP API, DRepTalk
does no label-17 indexing, and no page request reads Tessera.

## 7. Decisions

- **List mirrored into D1; no Tessera read on a page request.** Supersedes
  "bundle fetched per request", which only bought an SSR exception.
- **The displayed count is the audited DRep count, from the bundle**
  (2026-08-25, maintainer's review). The list's `responseCounts` — the
  earlier display value — filters nothing and sums across roles.
  `auditResponses` is Tessera's published, ruleset-pinned counting, so no
  second CIP-179 implementation appears.
- **A held survey refreshes until `final_state`, never freezing at close**
  (2026-08-25). The earlier "refresh what is not yet closed" froze a survey
  at whatever snapshot its deadline landed on.
- **A ref missing from a complete snapshot means rolled back →
  `unavailable`** (2026-08-25). The earlier log-and-keep left DRepTalk
  inviting answers to a survey that no longer exists.
- **Pending rows settle by `GET /api/responses/{txHash}` and age to
  `failed`** (2026-08-25) — the GA-vote lifecycle DRepTalk already runs.
  `/api/responded` (the earlier settle read) is replacement-blind.
- **Admission: DRep-eligible *and* linked by an imported action** (maintainer,
  2026-08-21). Alternatives: every survey, or DRep-eligible alone. Cost: a
  standalone DRep survey is invisible. It is policy, so the data model does
  not encode it — widening later is one predicate.
- **`CategoryKind` and `topics.source` each gain `'survey'`** rather than
  reusing `'governance'` or `'discussion'`: consumers branching on those
  values must not answer questions about surveys nobody asked.
- **No result figure of any kind in the MVP.** CIP-179 does not mandate a
  tally; the survey maker owns the counting policy. Revisit with
  `<tessera-results>`; first candidate is the live weighted estimate (§2).
- **No nav link, no activity event.** Both would show on mainnet with the
  feature off; both are one-line additions later.
- **External-content surveys are listed but not answerable.** Their prompts
  live off-chain behind a `content_anchor` Tessera's API does not serve;
  they render with a ref-derived title and a "document not loaded" note.
- **Mechanism A now; mechanism B later, for linked surveys.** A (DRep key
  hash in `required_signers`) exists for every survey at every moment. B
  proves by voting on a linked action in the same transaction, so its place
  is the vote panel, riding with A. Deferred, not rejected.
- **Preprod gating by `TESSERA_BACKEND_URL` presence** plus the `/health`
  network match. One switch, owned by whoever deploys the site.

## 8. Risks and open items

- evolution-sdk skew (§5); widget bundle weight — measure before the PR.
- **The acceptance pair is the long-lead item** (§3). Nothing in 1–5 blocks
  on it, but increment 6 cannot run without it. Start early.
- **The narrowed admission rule reopens the presentation question.** "Card
  on the action's thread, no topic" is now a smaller diff than a category; §1
  argues it still loses. Confirm with the maintainer before increment 3 — the
  last decision that would invalidate the migration.
