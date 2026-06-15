# Per-Type On-Chain Changes in the Governance Overview

Date: 2026-06-15
Status: Approved (design)

## Problem

A governance action's thread Overview (`GaOverview.astro`) shows the same three
tally stat cards plus the rationale for every action type. It never shows **what
the action actually does on-chain**. For a `ParameterChange` like
`parameter-change-4aa45fe4-0-6bdf757d` a reader cannot see which protocol
parameter is being changed or to what value; for a `TreasuryWithdrawals` they
cannot see the amount or recipient; for a `HardForkInitiation` they cannot see
the target protocol version. The on-chain payload is dropped at sync time and
never stored.

## Goal

Add a per-action-type **"On-chain changes"** block to the Overview, rendered
above the tally stat cards, that decodes and displays the action's on-chain
payload. Where a meaningful current value exists, show **old → new**; otherwise
show the new value only. Cover all action types.

Non-goals: no new explorer, no historical diff timeline, no editing. Read-only
display of one action's payload.

## Key facts that make this cheap

1. **`proposal_description` already arrives** in every `proposalList()` response
   from Koios; the Zod schema (`proposalListRowSchema`, `.passthrough()`) simply
   drops it today. It is a fully JSON-decoded form of the on-chain action body,
   so **no CBOR decoding is needed**.
2. **The current epoch's protocol params are already fetched.** The worker calls
   `koios.epochParams()` (`workers/gov-sync/src/index.ts:148`) every cron run and
   writes the threshold subset into `protocol_params`. For old→new we only need
   to **retain more of that same response** , no new API call.

Both align with the lean/cheap-on-Cloudflare constraint: zero additional Koios
calls, no wasm.

## Shape of `proposal_description` (verified on preprod)

```jsonc
// ParameterChange  (4aa45fe4…)
{ "tag": "ParameterChange",
  "contents": [ {"txId":"…","govActionIx":0},          // prev-action pointer (or null)
                {"govActionDeposit": 1000000000},        // ONLY the changed params
                "fa24fb…" ] }                            // guardrails policy hash

// HardForkInitiation
{ "tag": "HardForkInitiation",
  "contents": [ {"txId":"…","govActionIx":0}, {"major":11,"minor":0} ] }

// TreasuryWithdrawals
{ "tag": "TreasuryWithdrawals",
  "contents": [ [ [ {"network":"Testnet","credential":{"keyHash":"3c79…"}}, 10 ] ],  // [[rewardAccount, lovelace], …]
                "fa24fb…" ] }                            // guardrails policy hash

// NewCommittee / UpdateCommittee  (Koios tags both "UpdateCommittee")
{ "tag": "UpdateCommittee",
  "contents": [ {"txId":"…","govActionIx":0},           // prev-action pointer (or null)
                [],                                       // removed cold credentials
                {"scriptHash-615b…":372, …},             // added members → term-expiry epoch
                {"numerator":2,"denominator":3} ] }       // new threshold

// New/UpdateConstitution (structure from ledger; no preprod sample available)
{ "tag": "NewConstitution",
  "contents": [ {"txId":"…","govActionIx":0},
                {"anchor":{"url":"…","dataHash":"…"}, "script":"<guardrailsScriptHash|null>"} ] }

// InfoAction      → { "tag": "InfoAction" }            (no contents)
// NoConfidence    → { "tag": "NoConfidence", "contents": [ prevAction ] }
```

The positional layout differs per tag (e.g. `TreasuryWithdrawals` has no
prev-action pointer at `contents[0]`), so parsing is **per-tag**, not generic by
position.

## Architecture

Three independent units.

### 1. Store the on-chain payload

- Migration `0030_governance_onchain_payload.sql`: add
  `onchain_payload TEXT` to `governance_actions` (raw `proposal_description`
  JSON string; nullable).
- `proposalListRowSchema`: add `proposal_description: z.unknown().optional()`
  (keep it permissive; the shape is validated at render time, not sync time).
- `buildInsertGovernanceAction` (and its caller in `sync.ts`): persist
  `JSON.stringify(p.proposal_description)` when present.
- Backfill `backfillActionOnchainPayload(db, koios, limit)`, modeled on
  `backfillActionMetadata`: for rows where `onchain_payload IS NULL`, look the
  action up in the live `proposalList()` result (already in memory during sync)
  and fill it. Self-limiting per cron tick. Because `proposalList()` returns the
  full history (terminal actions included), the backlog is fully reachable.

Store the payload **raw**; normalize only at render time. This keeps the sync
dumb and lets the view logic be revised without a re-sync.

### 2. Retain current epoch params for old→new

- `protocol_params`: add `raw_json TEXT` (migration `0031_protocol_params_raw.sql`).
- `ProtocolParams` interface + `upsertProtocolParams` + `getProtocolParams`:
  carry a `rawJson: string | null` field.
- Worker (`workers/gov-sync/src/index.ts` around the existing
  `upsertProtocolParams` call): store `JSON.stringify(ep)` (the full
  `EpochParamsRow`, which is `.passthrough()` so it already contains
  `gov_action_deposit`, `min_fee_a`, `protocol_major`, etc.).

This is the single source for "old" values. `epoch_params` keys are snake_case
(`gov_action_deposit`); `proposal_description` keys are camelCase
(`govActionDeposit`) , the registry below bridges the two.

### 3. Render

- `src/lib/governance/onchain.ts` , a **pure** module:
  `decodeOnchainChanges(payloadJson: string | null, epochParamsJson: string | null): OnchainChanges | null`.
  Returns a normalized, display-ready view model (discriminated union by type).
  This is the testable core; all parsing, the param registry, and formatters
  live here.
- `src/components/ga/GaOnchainChanges.astro` , renders the view model. Inserted
  in `GaOverview.astro` **above** `<GaStatCards>`. Renders nothing when the model
  is null or carries no payload (e.g. InfoAction with no extra detail).
- The Overview page loader passes `action.onchainPayload` and the cached
  `protocolParams.rawJson` into the component.

### View model (sketch)

```ts
type OnchainChanges =
  | { kind: 'params';      rows: ParamRow[] }                  // ParameterChange
  | { kind: 'hardfork';    fromVersion: string|null; toVersion: string }
  | { kind: 'treasury';    rows: { address: string; ada: string }[]; totalAda: string }
  | { kind: 'committee';   added: {who:string; termEpoch:number}[]; removed: string[]; threshold: string|null }
  | { kind: 'constitution';anchorUrl: string; scriptHash: string|null }
  | { kind: 'note';        text: string };                     // Info / NoConfidence

interface ParamRow { group: string; label: string; oldValue: string|null; newValue: string }
```

## The param registry (core content work)

A static map keyed by the camelCase ledger param name, covering the ~30
Conway-era parameters a `ParameterChange` can touch:

```ts
govActionDeposit → { snake: 'gov_action_deposit', group: 'Governance',
                     label: 'Governance Action Deposit', format: 'lovelace' }
```

- **Labels are English**, matching the rest of the action UI (`readableType`).
- **Formatters**: `lovelace` (→ `1,000 ₳`), `ratio` (`{numerator,denominator}`
  or float → `66.67%`), `bytes`, `exUnits` (large int, thousands-grouped),
  `int`, `version`.
- `proposal_description` encodes ratios as `{numerator, denominator}` while
  `epoch_params` gives a float; the `ratio` formatter accepts both so old→new
  compares cleanly.
- **Unknown key** (registry miss): fall back to a humanized camelCase label and
  the raw value. Never throw, never hide a real change.

Groups mirror CIP-1694: Network, Economic, Technical, Governance, Security.

## Per-type rendering

| Type | Block contents | old→new |
|---|---|---|
| ParameterChange | one `ParamRow` per changed key: group · label, old → new | yes |
| HardForkInitiation | `Protocol Version <old> → <major.minor>` (old from `protocol_major/minor`) | yes |
| TreasuryWithdrawals | recipient stake address(es) + amount in ₳, plus total | n/a (new only) |
| New/UpdateCommittee | members added (with term epoch) / removed; new threshold (old→new if available) | threshold only |
| New/UpdateConstitution | link to the new constitution anchor + guardrails script hash | new only |
| NoConfidence | short note ("Motion of no-confidence in the constitutional committee.") | , |
| InfoAction | short note ("Informational action , no on-chain effect; vote signals opinion only.") | , |

Example render for `parameter-change-4aa45fe4`:

```
ON-CHAIN CHANGES
Governance · Governance Action Deposit      100,000 ₳  →  1,000 ₳
```

## Stake-address encoding (TreasuryWithdrawals)

Recipients arrive as `{network, credential:{keyHash|scriptHash}}`. Render them as
a bech32 stake address: header byte (`0xe0` test / `0xe1` main for a key-hash
stake credential, `0xf0`/`0xf1` for a script-hash) + 28-byte hash, bech32 with
the `stake`/`stake_test` HRP. Small dedicated helper in `onchain.ts` (or a shared
address util if one already fits). Network is taken from the app config, not
trusted from the payload's `network` string. Amount: lovelace → ₳ via the
existing `formatAda`.

## Error handling

- A malformed or absent `onchain_payload` → component renders nothing; the rest
  of the Overview is unaffected.
- A registry miss → humanized fallback row (see above).
- Missing `epoch_params` cache → old values render as "n/a"; new values still show.
- `decodeOnchainChanges` is total: it returns `null` rather than throwing on any
  unexpected shape.

## Testing

- Unit tests for `decodeOnchainChanges` with one fixture per tag (the verified
  preprod payloads above), asserting the view model , including the old→new join
  for `govActionDeposit` (100,000 ₳ → 1,000 ₳) and a registry-miss fallback.
- Formatter unit tests: lovelace, ratio (both encodings), version, exUnits.
- Stake-address encoder test against a known keyHash → bech32 vector.
- A sync test asserting `onchain_payload` is persisted from `proposal_description`.

## Files touched

- `migrations/0030_governance_onchain_payload.sql` (new)
- `migrations/0031_protocol_params_raw.sql` (new)
- `src/lib/koios/client.ts` (`proposalListRowSchema`)
- `src/lib/db/governance.ts` (`GovernanceAction` type, `buildInsertGovernanceAction`)
- `src/lib/db/protocolParams.ts` (`ProtocolParams`, upsert, getter)
- `src/lib/governance/sync.ts` (persist payload; new backfill fn)
- `workers/gov-sync/src/index.ts` (store epoch_params raw_json; call backfill)
- `src/lib/governance/onchain.ts` (new , decoder, registry, formatters, encoder)
- `src/components/ga/GaOnchainChanges.astro` (new)
- `src/components/ga/GaOverview.astro` (insert block)
- the Overview page loader (pass payload + params into the component)
- tests alongside the above

## Migration / deploy note

Both migrations are additive (new nullable columns). Per the project's deploy
model, remote D1 migrations are applied manually after merge
(`wrangler d1 migrations apply DB --remote`). Existing rows backfill their
`onchain_payload` over subsequent cron ticks; until then those Overviews simply
omit the block.
