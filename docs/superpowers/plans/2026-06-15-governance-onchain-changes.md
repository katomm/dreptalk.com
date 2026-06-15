# Per-Type On-Chain Changes in the Governance Overview , Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a per-action-type "On-chain changes" block in a governance action's Overview that decodes the on-chain payload (e.g. "Governance Action Deposit 100,000 ₳ → 1,000 ₳"), with old→new where a current value exists.

**Architecture:** Three independent units. (1) Persist Koios's already-arriving `proposal_description` JSON per action and retain the full `epoch_params` blob we already fetch. (2) A pure `onchain.ts` module decodes `(payload, epochParams) → view model`, holding the param registry, formatters, and stake-address encoding. (3) A dumb Astro component renders the view model above the tally cards.

**Tech Stack:** Astro 6 + Cloudflare Workers, D1 (SQLite), Zod, Vitest (`vitest run`, workers pool for D1 tests), Biome lint, `astro check` typecheck.

**Reference spec:** `docs/superpowers/specs/2026-06-15-governance-onchain-changes-design.md`

**Verified on-chain payload shapes** (from preprod + mainnet Koios `proposal_description`):

```jsonc
// ParameterChange: contents[1] is the changed-params map (camelCase keys)
{ "tag":"ParameterChange", "contents":[ {"txId":"…","govActionIx":0}, {"govActionDeposit":1000000000}, "fa24fb…" ] }
// real keys seen: govActionDeposit(int lovelace), committeeMinSize(int), treasuryCut(float ratio),
//                 maxTxExecutionUnits/maxBlockExecutionUnits({steps,memory}), costModels(big object)
{ "tag":"HardForkInitiation", "contents":[ {"txId":"…","govActionIx":0}, {"major":11,"minor":0} ] }
{ "tag":"TreasuryWithdrawals", "contents":[ [ [ {"network":"Testnet","credential":{"keyHash":"3c79…"}}, 10 ] ], "fa24fb…" ] }
{ "tag":"UpdateCommittee", "contents":[ {"txId":"…"}, [], {"scriptHash-615b…":372}, {"numerator":2,"denominator":3} ] }
{ "tag":"NewConstitution", "contents":[ {"txId":"…"}, {"anchor":{"url":"…","dataHash":"…"},"script":"<hash|null>"} ] }
{ "tag":"InfoAction" }
{ "tag":"NoConfidence", "contents":[ {"txId":"…"} ] }
```

---

## File Structure

- `migrations/0030_governance_onchain_payload.sql` (new) , `onchain_payload TEXT` on `governance_actions`
- `migrations/0031_protocol_params_raw.sql` (new) , `raw_json TEXT` on `protocol_params`
- `src/lib/koios/client.ts` (modify) , keep `proposal_description` on the row schema
- `src/lib/db/governance.ts` (modify) , persist + read `onchain_payload`; add `updateActionOnchainPayload`, `getActionIdsMissingOnchainPayload`
- `src/lib/db/protocolParams.ts` (modify) , carry `rawJson`
- `src/lib/governance/sync.ts` (modify) , persist payload on discovery; bounded backfill pass
- `workers/gov-sync/src/index.ts` (modify) , store `epoch_params` raw JSON
- `src/lib/governance/onchain.ts` (new) , pure decoder + registry + formatters + stake encoding
- `src/components/ga/GaOnchainChanges.astro` (new) , renders the view model
- `src/components/ga/GaOverview.astro` (modify) , render the block above the stat cards
- `src/pages/t/[slug].astro` (modify) , decode and pass the view model into `GaOverview`

---

## Task 1: Migrations (additive columns)

**Files:**
- Create: `migrations/0030_governance_onchain_payload.sql`
- Create: `migrations/0031_protocol_params_raw.sql`

- [ ] **Step 1: Write migration 0030**

```sql
-- Raw Koios proposal_description JSON (the decoded on-chain action body) per
-- governance action. Used to render the per-type "On-chain changes" block.
-- Nullable: backfilled over subsequent cron ticks for pre-existing rows.
ALTER TABLE governance_actions ADD COLUMN onchain_payload TEXT;
```

- [ ] **Step 2: Write migration 0031**

```sql
-- Full epoch_params response (JSON) cached alongside the extracted thresholds,
-- so the Overview can show old→new for changed protocol parameters without a
-- second Koios call. One row, id = 1; nullable until first refreshed.
ALTER TABLE protocol_params ADD COLUMN raw_json TEXT;
```

- [ ] **Step 3: Apply migrations locally and verify columns exist**

Run: `npx wrangler d1 migrations apply DB --local`
Expected: both migrations report applied with no error.

- [ ] **Step 4: Commit**

```bash
git add migrations/0030_governance_onchain_payload.sql migrations/0031_protocol_params_raw.sql
git commit -m "feat: add onchain_payload and protocol_params.raw_json columns"
```

---

## Task 2: Keep `proposal_description` on the Koios row schema

**Files:**
- Modify: `src/lib/koios/client.ts` (`proposalListRowSchema`, ~126-145)
- Test: `src/lib/koios/client.test.ts` (create if absent; plain vitest)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { _proposalListRowSchemaForTest } from './client.js';

describe('proposalListRowSchema', () => {
  it('retains proposal_description', () => {
    const row = _proposalListRowSchemaForTest.parse({
      proposal_id: 'gov_action1xyz', proposal_tx_hash: 'abcd', proposal_index: 0,
      proposal_type: 'ParameterChange',
      proposal_description: { tag: 'ParameterChange', contents: [null, { govActionDeposit: 1000000000 }, 'fa24fb'] },
    });
    expect(row.proposal_description).toEqual({
      tag: 'ParameterChange', contents: [null, { govActionDeposit: 1000000000 }, 'fa24fb'],
    });
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `npx vitest run src/lib/koios/client.test.ts`
Expected: FAIL , `_proposalListRowSchemaForTest` is not exported (and the field is dropped).

- [ ] **Step 3: Add the field + a test export**

In `src/lib/koios/client.ts`, add inside the `proposalListRowSchema` object (before the closing `})`):

```ts
    proposal_description: z.unknown().optional(),
```

And at the end of the schema definition add:

```ts
// Exported for unit tests only.
export const _proposalListRowSchemaForTest = proposalListRowSchema;
```

- [ ] **Step 4: Run the test to confirm pass**

Run: `npx vitest run src/lib/koios/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/koios/client.ts src/lib/koios/client.test.ts
git commit -m "feat: retain proposal_description on the Koios proposal row"
```

---

## Task 3: Persist + read `onchain_payload` in the DB layer

**Files:**
- Modify: `src/lib/db/governance.ts` (`NewGovernanceAction`, `buildInsertGovernanceAction`, `GovernanceAction`, `GovernanceActionRow`, `rowToGovernanceAction`)
- Test: `src/lib/db/governance.workers.test.ts`

- [ ] **Step 1: Write the failing test** (append to the existing `describe`)

```ts
it('persists and reads back onchain_payload', async () => {
  const topicId = 'topic-ocp';
  await env.DB.prepare(
    `INSERT INTO topics (id, category_slug, author_id, title, slug, body_html, source, created_at, last_post_at, post_count)
     VALUES (?, ?, 'gov-sync', 'P', 'p-ocp', '<p>x</p>', 'governance', 1, 1, 1)`,
  ).bind(topicId, GOV).run();
  const stmt = buildInsertGovernanceAction(env.DB, {
    id: 'tx-ocp#0', proposalId: 'gov_action1', type: 'ParameterChange', title: null, abstract: null,
    rationaleHtml: null, anchorUrl: null, anchorHash: null, anchorStatus: 'no-anchor', returnAddress: null,
    deposit: null, submittedEpoch: 1, expiryEpoch: 2, metaVersion: 1, topicId,
    onchainPayload: '{"tag":"ParameterChange"}', now: 1,
  } satisfies NewGovernanceAction);
  await stmt.run();
  const got = await getGovernanceActionByTopicId(env.DB, topicId);
  expect(got?.onchainPayload).toBe('{"tag":"ParameterChange"}');
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `npx vitest run src/lib/db/governance.workers.test.ts`
Expected: FAIL , `onchainPayload` is not a known property / column.

- [ ] **Step 3: Add the field through the layer**

In `NewGovernanceAction` (after `expiryEpoch`):

```ts
  /** Raw Koios proposal_description JSON, or null when absent. */
  onchainPayload: string | null;
```

In `buildInsertGovernanceAction`, add `onchain_payload` to the column list and a `?` to VALUES, and bind `a.onchainPayload` (place it right after `expiry_epoch`/`a.expiryEpoch`):

```ts
      `INSERT OR IGNORE INTO governance_actions
         (id, proposal_id, type, title, abstract, rationale_html, anchor_url, anchor_hash, anchor_status,
          return_address, deposit, submitted_epoch, expiry_epoch, onchain_payload, status, meta_version, topic_id, created_at, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
```

```ts
      a.expiryEpoch,
      a.onchainPayload,
      a.metaVersion,
```

In `GovernanceAction` (after `expiryEpoch`): `onchainPayload: string | null;`
In `GovernanceActionRow` (after `expiry_epoch`): `onchain_payload: string | null;`
In `rowToGovernanceAction` (after `expiryEpoch: r.expiry_epoch,`): `onchainPayload: r.onchain_payload,`

- [ ] **Step 4: Run the test to confirm pass**

Run: `npx vitest run src/lib/db/governance.workers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/governance.ts src/lib/db/governance.workers.test.ts
git commit -m "feat: carry onchain_payload through the governance data layer"
```

---

## Task 4: Add `updateActionOnchainPayload` + `getActionIdsMissingOnchainPayload`

**Files:**
- Modify: `src/lib/db/governance.ts`
- Test: `src/lib/db/governance.workers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('backfills onchain_payload only where missing', async () => {
  await env.DB.prepare(
    `INSERT INTO governance_actions (id, type, anchor_status, status, meta_version, created_at, last_synced_at)
     VALUES ('miss#0','InfoAction','no-anchor','active',1,1,1), ('have#0','InfoAction','no-anchor','active',1,1,1)`,
  ).run();
  await env.DB.prepare(`UPDATE governance_actions SET onchain_payload='{"tag":"InfoAction"}' WHERE id='have#0'`).run();
  const missing = await getActionIdsMissingOnchainPayload(env.DB);
  expect(missing.has('miss#0')).toBe(true);
  expect(missing.has('have#0')).toBe(false);
  await updateActionOnchainPayload(env.DB, 'miss#0', '{"tag":"InfoAction"}');
  const after = await getActionIdsMissingOnchainPayload(env.DB);
  expect(after.has('miss#0')).toBe(false);
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `npx vitest run src/lib/db/governance.workers.test.ts`
Expected: FAIL , functions not exported.

- [ ] **Step 3: Implement both functions** (add near `getKnownActionIds`)

```ts
/** Ids of actions whose on-chain payload has not yet been stored (backfill target). */
export async function getActionIdsMissingOnchainPayload(db: D1Database): Promise<Set<string>> {
  const rows =
    (await db.prepare('SELECT id FROM governance_actions WHERE onchain_payload IS NULL').all<{ id: string }>())
      .results ?? [];
  return new Set(rows.map((r) => r.id));
}

/** Stores the raw proposal_description JSON for one action (backfill). */
export async function updateActionOnchainPayload(db: D1Database, id: string, payload: string): Promise<void> {
  await db.prepare('UPDATE governance_actions SET onchain_payload = ? WHERE id = ?').bind(payload, id).run();
}
```

- [ ] **Step 4: Run the test to confirm pass**

Run: `npx vitest run src/lib/db/governance.workers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/governance.ts src/lib/db/governance.workers.test.ts
git commit -m "feat: add onchain_payload backfill queries"
```

---

## Task 5: Persist the payload on discovery + bounded backfill in sync

**Files:**
- Modify: `src/lib/governance/sync.ts`
- Test: `src/lib/governance/sync.workers.test.ts`

- [ ] **Step 1: Write the failing test** , extend the sync test so a discovered action stores its payload.

Find the existing sync test's fake `koios.proposalList()` rows and add `proposal_description` to one row, then assert it round-trips. Add this case to the `describe`:

```ts
it('stores proposal_description as onchain_payload on discovery', async () => {
  const proposals = [{
    proposal_id: 'gov_action1pay', proposal_tx_hash: 'payhash', proposal_index: 0,
    proposal_type: 'ParameterChange', meta_url: null, meta_hash: null, proposed_epoch: 1, expiration: 2,
    proposal_description: { tag: 'ParameterChange', contents: [null, { govActionDeposit: 1000000000 }, 'fa'] },
  }];
  await syncGovernanceActions({
    koios: { proposalList: async () => proposals as never },
    db: env.DB, network: 'preprod', now: 1000, rand: () => 'rnd1',
  });
  const row = await env.DB.prepare(
    `SELECT onchain_payload FROM governance_actions WHERE id = 'payhash#0'`,
  ).first<{ onchain_payload: string }>();
  expect(JSON.parse(row!.onchain_payload).contents[1].govActionDeposit).toBe(1000000000);
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `npx vitest run src/lib/governance/sync.workers.test.ts`
Expected: FAIL , `onchain_payload` is null.

- [ ] **Step 3: Persist on discovery**

In `syncGovernanceActions`, inside the `buildInsertGovernanceAction({...})` call, add after `expiryEpoch: p.expiration ?? null,`:

```ts
            onchainPayload: p.proposal_description != null ? JSON.stringify(p.proposal_description) : null,
```

- [ ] **Step 4: Run the test to confirm pass**

Run: `npx vitest run src/lib/governance/sync.workers.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the bounded backfill pass for known rows missing a payload**

Still in `syncGovernanceActions`, import the two new helpers at the top:

```ts
import { /* …existing… */ getActionIdsMissingOnchainPayload, updateActionOnchainPayload } from '../db/governance.js';
```

After the discovery `for` loop (just before `return { total, … }`), add:

```ts
  // Backfill payloads for already-known rows discovered before this column existed.
  // Bounded per run; `proposals` is already in memory, so this adds no Koios call.
  const missing = await getActionIdsMissingOnchainPayload(db);
  let backfilled = 0;
  for (const p of proposals) {
    if (backfilled >= 50) break;
    const id = `${p.proposal_tx_hash}#${p.proposal_index}`;
    if (missing.has(id) && p.proposal_description != null) {
      await updateActionOnchainPayload(db, id, JSON.stringify(p.proposal_description));
      backfilled++;
    }
  }
```

- [ ] **Step 6: Write a backfill test**

```ts
it('backfills onchain_payload for a pre-existing row', async () => {
  await env.DB.prepare(
    `INSERT INTO governance_actions (id, type, anchor_status, status, meta_version, created_at, last_synced_at)
     VALUES ('bf#0','HardForkInitiation','no-anchor','active',1,1,1)`,
  ).run();
  await syncGovernanceActions({
    koios: { proposalList: async () => [{
      proposal_id: 'g', proposal_tx_hash: 'bf', proposal_index: 0, proposal_type: 'HardForkInitiation',
      meta_url: null, meta_hash: null, proposed_epoch: 1, expiration: 2,
      proposal_description: { tag: 'HardForkInitiation', contents: [null, { major: 11, minor: 0 }] },
    }] as never },
    db: env.DB, network: 'preprod', now: 1, rand: () => 'r',
  });
  const row = await env.DB.prepare(`SELECT onchain_payload FROM governance_actions WHERE id='bf#0'`).first<{ onchain_payload: string }>();
  expect(JSON.parse(row!.onchain_payload).contents[1].major).toBe(11);
});
```

- [ ] **Step 7: Run the sync tests to confirm pass**

Run: `npx vitest run src/lib/governance/sync.workers.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/governance/sync.ts src/lib/governance/sync.workers.test.ts
git commit -m "feat: store and backfill on-chain payload during sync"
```

---

## Task 6: Cache the full `epoch_params` blob for old→new

**Files:**
- Modify: `src/lib/db/protocolParams.ts` (`ProtocolParams`, `Row`, `getProtocolParams`, `upsertProtocolParams`)
- Modify: `workers/gov-sync/src/index.ts` (the `params` phase, ~147-181)
- Test: `src/lib/db/protocolParams.workers.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```ts
it('round-trips raw_json', async () => {
  await upsertProtocolParams(env.DB, { ...PARAMS, rawJson: '{"gov_action_deposit":100000000000}' });
  const p = await getProtocolParams(env.DB);
  expect(p!.rawJson).toBe('{"gov_action_deposit":100000000000}');
});
```

Also extend the existing `PARAMS` literal at the top of the file with `rawJson: null,`.

- [ ] **Step 2: Run it to confirm failure**

Run: `npx vitest run src/lib/db/protocolParams.workers.test.ts`
Expected: FAIL , `rawJson` unknown.

- [ ] **Step 3: Add `rawJson` through the layer**

In `ProtocolParams` (after `syncedAt`): `rawJson: string | null;`
In `Row` (after `synced_at: number;`): `raw_json: string | null;`
In `getProtocolParams` return object (after `syncedAt: r.synced_at,`): `rawJson: r.raw_json,`
In `upsertProtocolParams`, add `raw_json` to the column list, one more `?` to VALUES, and bind `p.rawJson` last:

```ts
       (id, epoch, dvt_motion_no_confidence, dvt_committee_normal, dvt_committee_no_confidence,
        dvt_update_constitution, dvt_hard_fork, dvt_pp_network, dvt_pp_economic, dvt_pp_technical,
        dvt_pp_gov, dvt_treasury_withdrawal, pvt_motion_no_confidence, pvt_committee_normal,
        pvt_committee_no_confidence, pvt_hard_fork, pvt_security_group, cc_threshold,
        committee_min_size, synced_at, raw_json)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
```

```ts
      p.committeeMinSize, p.syncedAt, p.rawJson,
```

- [ ] **Step 4: Run the test to confirm pass**

Run: `npx vitest run src/lib/db/protocolParams.workers.test.ts`
Expected: PASS.

- [ ] **Step 5: Store the blob in the worker**

In `workers/gov-sync/src/index.ts`, in the `next` object (after `syncedAt: now,`):

```ts
      rawJson: JSON.stringify(ep),
```

And extend the change-detection `if` so a first-time/changed blob is written even within the same epoch:

```ts
    if (
      !cur ||
      cur.epoch !== next.epoch ||
      cur.dvtTreasuryWithdrawal !== next.dvtTreasuryWithdrawal ||
      cur.ccThreshold !== next.ccThreshold ||
      cur.rawJson !== next.rawJson
    ) {
```

- [ ] **Step 6: Typecheck the worker**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/protocolParams.ts workers/gov-sync/src/index.ts src/lib/db/protocolParams.workers.test.ts
git commit -m "feat: cache full epoch_params blob for parameter old to new"
```

---

## Task 7: Formatters + param registry (pure)

**Files:**
- Create: `src/lib/governance/onchain.ts`
- Test: `src/lib/governance/onchain.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { formatValue, PARAM_REGISTRY } from './onchain.js';

describe('formatValue', () => {
  it('formats lovelace as ada', () => { expect(formatValue('lovelace', 1000000000)).toBe('1,000 ₳'); });
  it('formats a float ratio as percent', () => { expect(formatValue('ratio', 0.1)).toBe('10%'); });
  it('formats a {numerator,denominator} ratio as percent', () => {
    expect(formatValue('ratio', { numerator: 2, denominator: 3 })).toBe('66.67%');
  });
  it('formats an int with grouping', () => { expect(formatValue('int', 90112)).toBe('90,112'); });
  it('formats exec units', () => {
    expect(formatValue('exUnits', { memory: 16500000, steps: 10000000000 })).toBe('16,500,000 mem / 10,000,000,000 steps');
  });
  it('summarises cost models', () => { expect(formatValue('costModels', { PlutusV1: [1, 2] })).toBe('Updated'); });
});

describe('PARAM_REGISTRY', () => {
  it('maps govActionDeposit to a lovelace entry', () => {
    expect(PARAM_REGISTRY.govActionDeposit).toEqual({
      snake: 'gov_action_deposit', group: 'Governance', label: 'Governance Action Deposit', format: 'lovelace',
    });
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `npx vitest run src/lib/governance/onchain.test.ts`
Expected: FAIL , module does not exist.

- [ ] **Step 3: Implement formatters + registry**

Create `src/lib/governance/onchain.ts`:

```ts
// Pure decoder for a governance action's on-chain payload (Koios proposal_description).
// Turns the raw JSON + current epoch params into a display-ready view model.
// No I/O, no DOM; the Astro component renders the result.

import { formatAda } from './view.js';
import { rewardAddressToStakeBech32 } from './stakeAccount.js';
import type { CardanoNetwork } from '../config/network.js';

export type Fmt = 'lovelace' | 'ratio' | 'int' | 'bytes' | 'exUnits' | 'costModels';

export interface ParamMeta { snake: string; group: string; label: string; format: Fmt }

// camelCase ledger param name → display metadata + the snake_case epoch_params key
// used for old→new. snake '' means "no comparable scalar in epoch_params" (new only).
// All keys here were observed in real preprod/mainnet payloads or are standard
// Conway-updatable parameters; unknown keys fall back to a humanized label.
export const PARAM_REGISTRY: Record<string, ParamMeta> = {
  govActionDeposit: { snake: 'gov_action_deposit', group: 'Governance', label: 'Governance Action Deposit', format: 'lovelace' },
  dRepDeposit: { snake: 'drep_deposit', group: 'Governance', label: 'DRep Deposit', format: 'lovelace' },
  committeeMinSize: { snake: 'committee_min_size', group: 'Governance', label: 'Committee Min Size', format: 'int' },
  committeeMaxTermLength: { snake: 'committee_max_term_length', group: 'Governance', label: 'Committee Max Term Length', format: 'int' },
  govActionLifetime: { snake: 'gov_action_lifetime', group: 'Governance', label: 'Governance Action Lifetime', format: 'int' },
  dRepActivity: { snake: 'drep_activity', group: 'Governance', label: 'DRep Activity', format: 'int' },
  treasuryCut: { snake: 'treasury_growth_rate', group: 'Economic', label: 'Treasury Cut', format: 'ratio' },
  monetaryExpansion: { snake: 'monetary_expand_rate', group: 'Economic', label: 'Monetary Expansion', format: 'ratio' },
  minFeeA: { snake: 'min_fee_a', group: 'Economic', label: 'Min Fee Coefficient (a)', format: 'int' },
  minFeeB: { snake: 'min_fee_b', group: 'Economic', label: 'Min Fee Constant (b)', format: 'lovelace' },
  minFeeRefScriptCostPerByte: { snake: 'min_fee_ref_script_cost_per_byte', group: 'Economic', label: 'Ref Script Cost per Byte', format: 'lovelace' },
  minPoolCost: { snake: 'min_pool_cost', group: 'Economic', label: 'Min Pool Cost', format: 'lovelace' },
  keyDeposit: { snake: 'key_deposit', group: 'Economic', label: 'Key Deposit', format: 'lovelace' },
  poolDeposit: { snake: 'pool_deposit', group: 'Economic', label: 'Pool Deposit', format: 'lovelace' },
  coinsPerUTxOByte: { snake: 'coins_per_utxo_size', group: 'Economic', label: 'Coins per UTxO Byte', format: 'lovelace' },
  maxBlockBodySize: { snake: 'max_block_size', group: 'Network', label: 'Max Block Body Size', format: 'bytes' },
  maxTxSize: { snake: 'max_tx_size', group: 'Network', label: 'Max Tx Size', format: 'bytes' },
  maxBlockHeaderSize: { snake: 'max_bh_size', group: 'Network', label: 'Max Block Header Size', format: 'bytes' },
  maxValueSize: { snake: 'max_val_size', group: 'Network', label: 'Max Value Size', format: 'bytes' },
  maxTxExecutionUnits: { snake: '', group: 'Technical', label: 'Max Tx Execution Units', format: 'exUnits' },
  maxBlockExecutionUnits: { snake: '', group: 'Technical', label: 'Max Block Execution Units', format: 'exUnits' },
  collateralPercentage: { snake: 'collateral_percent', group: 'Technical', label: 'Collateral Percentage', format: 'int' },
  maxCollateralInputs: { snake: 'max_collateral_inputs', group: 'Technical', label: 'Max Collateral Inputs', format: 'int' },
  costModels: { snake: 'cost_models', group: 'Technical', label: 'Cost Models', format: 'costModels' },
};

const groupNum = (v: number): string => v.toLocaleString('en-US');

function fmtRatio(v: unknown): string {
  let n: number | null = null;
  if (v && typeof v === 'object' && 'numerator' in v && 'denominator' in v) {
    const o = v as { numerator: number; denominator: number };
    n = o.denominator ? o.numerator / o.denominator : null;
  } else if (typeof v === 'number') {
    n = v;
  }
  if (n === null || Number.isNaN(n)) return String(v);
  return `${(n * 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

function fmtExUnits(v: unknown): string {
  if (v && typeof v === 'object') {
    const o = v as { memory?: number; steps?: number };
    if (o.memory != null || o.steps != null) {
      return `${groupNum(o.memory ?? 0)} mem / ${groupNum(o.steps ?? 0)} steps`;
    }
  }
  return String(v);
}

export function formatValue(fmt: Fmt, v: unknown): string {
  switch (fmt) {
    case 'lovelace':
      return formatAda(String(v)) ?? String(v);
    case 'ratio':
      return fmtRatio(v);
    case 'bytes':
      return typeof v === 'number' ? `${groupNum(v)} bytes` : String(v);
    case 'exUnits':
      return fmtExUnits(v);
    case 'costModels':
      return 'Updated';
    default:
      return typeof v === 'number' ? groupNum(v) : String(v);
  }
}

export function humanizeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}
```

- [ ] **Step 4: Run the test to confirm pass**

Run: `npx vitest run src/lib/governance/onchain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/governance/onchain.ts src/lib/governance/onchain.test.ts
git commit -m "feat: add param registry and value formatters for on-chain changes"
```

---

## Task 8: Stake-address encoding for treasury recipients (pure)

**Files:**
- Modify: `src/lib/governance/onchain.ts`
- Test: `src/lib/governance/onchain.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { rewardAccountToBech32 } from './onchain.js';

describe('rewardAccountToBech32', () => {
  it('encodes a key-hash credential to a stake_test address (preprod)', () => {
    const out = rewardAccountToBech32(
      { network: 'Testnet', credential: { keyHash: '3c79df2221075f32327bbf2aa8ccc22b3d2bc316b076e652eea9b2cd' } },
      'preprod',
    );
    expect(out.startsWith('stake_test1')).toBe(true);
  });
  it('returns a placeholder for a malformed credential', () => {
    expect(rewardAccountToBech32({ credential: {} }, 'preprod')).toBe('(unknown recipient)');
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `npx vitest run src/lib/governance/onchain.test.ts`
Expected: FAIL , `rewardAccountToBech32` not exported.

- [ ] **Step 3: Implement** (append to `onchain.ts`)

```ts
interface RewardAccount { credential?: { keyHash?: string; scriptHash?: string } }

// Encodes a treasury-withdrawal recipient as a bech32 stake address. The network
// comes from app config, not the payload's "network" string (untrusted). Builds
// the 29-byte reward address (header + 28-byte hash) and reuses the stake encoder.
export function rewardAccountToBech32(acct: RewardAccount, network: CardanoNetwork): string {
  const cred = acct?.credential ?? {};
  const isScript = typeof cred.scriptHash === 'string';
  const hashHex = isScript ? cred.scriptHash : cred.keyHash;
  if (typeof hashHex !== 'string' || hashHex.length !== 56) return '(unknown recipient)';
  const header = (isScript ? 0xf0 : 0xe0) | (network === 'mainnet' ? 1 : 0);
  const headerHex = header.toString(16).padStart(2, '0');
  return rewardAddressToStakeBech32(headerHex + hashHex, network);
}
```

- [ ] **Step 4: Run the test to confirm pass**

Run: `npx vitest run src/lib/governance/onchain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/governance/onchain.ts src/lib/governance/onchain.test.ts
git commit -m "feat: encode treasury recipients as stake addresses"
```

---

## Task 9: `decodeOnchainChanges` , per-type decode (pure)

**Files:**
- Modify: `src/lib/governance/onchain.ts`
- Test: `src/lib/governance/onchain.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { decodeOnchainChanges } from './onchain.js';

const EP = JSON.stringify({ gov_action_deposit: 100000000000, protocol_major: 10, protocol_minor: 0, treasury_growth_rate: 0.2 });

describe('decodeOnchainChanges', () => {
  it('returns null for empty payload', () => {
    expect(decodeOnchainChanges(null, EP, 'preprod')).toBeNull();
  });

  it('decodes a ParameterChange with old→new', () => {
    const p = JSON.stringify({ tag: 'ParameterChange', contents: [null, { govActionDeposit: 1000000000 }, 'fa'] });
    const r = decodeOnchainChanges(p, EP, 'preprod');
    expect(r).toEqual({ kind: 'params', rows: [
      { group: 'Governance', label: 'Governance Action Deposit', oldValue: '100,000 ₳', newValue: '1,000 ₳' },
    ] });
  });

  it('falls back to a humanized label for an unknown param key', () => {
    const p = JSON.stringify({ tag: 'ParameterChange', contents: [null, { someNewParam: 5 }, 'fa'] });
    const r = decodeOnchainChanges(p, EP, 'preprod');
    expect(r).toEqual({ kind: 'params', rows: [
      { group: 'Other', label: 'Some New Param', oldValue: null, newValue: '5' },
    ] });
  });

  it('decodes a HardForkInitiation with old→new version', () => {
    const p = JSON.stringify({ tag: 'HardForkInitiation', contents: [null, { major: 11, minor: 0 }] });
    expect(decodeOnchainChanges(p, EP, 'preprod')).toEqual({ kind: 'hardfork', fromVersion: '10.0', toVersion: '11.0' });
  });

  it('decodes a TreasuryWithdrawals with total', () => {
    const p = JSON.stringify({ tag: 'TreasuryWithdrawals', contents: [
      [[{ network: 'Testnet', credential: { keyHash: '3c79df2221075f32327bbf2aa8ccc22b3d2bc316b076e652eea9b2cd' } }, 5000000]], 'fa',
    ] });
    const r = decodeOnchainChanges(p, EP, 'preprod') as { kind: 'treasury'; rows: { address: string; ada: string }[]; totalAda: string };
    expect(r.kind).toBe('treasury');
    expect(r.rows[0].ada).toBe('5 ₳');
    expect(r.totalAda).toBe('5 ₳');
    expect(r.rows[0].address.startsWith('stake_test1')).toBe(true);
  });

  it('decodes an UpdateCommittee threshold and members', () => {
    const p = JSON.stringify({ tag: 'UpdateCommittee', contents: [
      null, [], { 'scriptHash-615b54137e73f090d2dddb04317bee41624f4013e5cfe4a5efa76d76': 372 }, { numerator: 2, denominator: 3 },
    ] });
    const r = decodeOnchainChanges(p, EP, 'preprod') as { kind: 'committee'; added: { who: string }[]; threshold: string };
    expect(r.kind).toBe('committee');
    expect(r.threshold).toBe('66.67%');
    expect(r.added[0].who).toContain('scriptHash');
  });

  it('returns a note for InfoAction', () => {
    const p = JSON.stringify({ tag: 'InfoAction' });
    expect(decodeOnchainChanges(p, EP, 'preprod')).toEqual({
      kind: 'note', text: 'Informational action. No on-chain effect; the vote signals opinion only.',
    });
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `npx vitest run src/lib/governance/onchain.test.ts`
Expected: FAIL , `decodeOnchainChanges` not exported.

- [ ] **Step 3: Implement the decoder** (append to `onchain.ts`)

```ts
export interface ParamRow { group: string; label: string; oldValue: string | null; newValue: string }
export interface TreasuryRow { address: string; ada: string }
export interface CommitteeMember { who: string; termEpoch: number | null }

export type OnchainChanges =
  | { kind: 'params'; rows: ParamRow[] }
  | { kind: 'hardfork'; fromVersion: string | null; toVersion: string }
  | { kind: 'treasury'; rows: TreasuryRow[]; totalAda: string }
  | { kind: 'committee'; added: CommitteeMember[]; removed: string[]; threshold: string | null }
  | { kind: 'constitution'; anchorUrl: string | null; scriptHash: string | null }
  | { kind: 'note'; text: string };

function shortenHash(h: string): string {
  return h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

function labelMemberKey(raw: string): string {
  const dash = raw.indexOf('-');
  if (dash === -1) return shortenHash(raw);
  return `${raw.slice(0, dash)} ${shortenHash(raw.slice(dash + 1))}`;
}

function labelMemberObj(o: unknown): string {
  if (o && typeof o === 'object') {
    const c = o as { scriptHash?: string; keyHash?: string };
    if (typeof c.scriptHash === 'string') return `scriptHash ${shortenHash(c.scriptHash)}`;
    if (typeof c.keyHash === 'string') return `keyHash ${shortenHash(c.keyHash)}`;
  }
  return '(member)';
}

function decodeParams(contents: unknown[], ep: Record<string, unknown>): OnchainChanges {
  const map = contents[1];
  const rows: ParamRow[] = [];
  if (map && typeof map === 'object') {
    for (const [key, val] of Object.entries(map)) {
      const meta = PARAM_REGISTRY[key];
      if (meta) {
        const old = meta.snake ? ep[meta.snake] : undefined;
        rows.push({
          group: meta.group,
          label: meta.label,
          oldValue: old === undefined || old === null ? null : formatValue(meta.format, old),
          newValue: formatValue(meta.format, val),
        });
      } else {
        rows.push({
          group: 'Other',
          label: humanizeKey(key),
          oldValue: null,
          newValue: val !== null && typeof val === 'object' ? 'Updated' : String(val),
        });
      }
    }
  }
  return { kind: 'params', rows };
}

function decodeHardFork(contents: unknown[], ep: Record<string, unknown>): OnchainChanges {
  const ver = contents.find((c) => c !== null && typeof c === 'object' && 'major' in c) as
    | { major: number; minor?: number }
    | undefined;
  const toVersion = ver ? `${ver.major}.${ver.minor ?? 0}` : '';
  const maj = ep.protocol_major;
  const fromVersion = typeof maj === 'number' ? `${maj}.${typeof ep.protocol_minor === 'number' ? ep.protocol_minor : 0}` : null;
  return { kind: 'hardfork', fromVersion, toVersion };
}

function decodeTreasury(contents: unknown[], network: CardanoNetwork): OnchainChanges {
  const list = contents[0];
  const rows: TreasuryRow[] = [];
  let total = 0n;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (!Array.isArray(entry)) continue;
      const [acct, lovelace] = entry as [RewardAccount, number | string];
      const amt = typeof lovelace === 'number' ? BigInt(Math.trunc(lovelace)) : BigInt(Number(lovelace) || 0);
      total += amt;
      rows.push({ address: rewardAccountToBech32(acct, network), ada: formatAda(String(amt)) ?? `${amt}` });
    }
  }
  return { kind: 'treasury', rows, totalAda: formatAda(String(total)) ?? `${total}` };
}

function decodeCommittee(contents: unknown[]): OnchainChanges {
  const removedRaw = Array.isArray(contents[1]) ? (contents[1] as unknown[]) : [];
  const addedRaw = contents[2] && typeof contents[2] === 'object' ? (contents[2] as Record<string, unknown>) : {};
  const thrRaw = contents[3] && typeof contents[3] === 'object' && 'numerator' in (contents[3] as object) ? contents[3] : null;
  const added: CommitteeMember[] = Object.entries(addedRaw).map(([who, epoch]) => ({
    who: labelMemberKey(who),
    termEpoch: typeof epoch === 'number' ? epoch : null,
  }));
  const removed = removedRaw.map(labelMemberObj);
  return { kind: 'committee', added, removed, threshold: thrRaw ? fmtRatio(thrRaw) : null };
}

function decodeConstitution(contents: unknown[]): OnchainChanges {
  const body = contents.find((c) => c !== null && typeof c === 'object' && 'anchor' in c) as
    | { anchor?: { url?: string }; script?: string }
    | undefined;
  return {
    kind: 'constitution',
    anchorUrl: body?.anchor?.url ?? null,
    scriptHash: typeof body?.script === 'string' ? body.script : null,
  };
}

// Total: never throws on an unexpected shape; returns null instead.
export function decodeOnchainChanges(
  payloadJson: string | null,
  epochParamsJson: string | null,
  network: CardanoNetwork,
): OnchainChanges | null {
  if (!payloadJson) return null;
  let payload: { tag?: string; contents?: unknown[] };
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  let ep: Record<string, unknown> = {};
  if (epochParamsJson) {
    try {
      ep = (JSON.parse(epochParamsJson) as Record<string, unknown>) ?? {};
    } catch {
      ep = {};
    }
  }
  const contents = Array.isArray(payload.contents) ? payload.contents : [];
  switch (payload.tag) {
    case 'ParameterChange':
      return decodeParams(contents, ep);
    case 'HardForkInitiation':
      return decodeHardFork(contents, ep);
    case 'TreasuryWithdrawals':
      return decodeTreasury(contents, network);
    case 'UpdateCommittee':
    case 'NewCommittee':
      return decodeCommittee(contents);
    case 'NewConstitution':
    case 'UpdateConstitution':
      return decodeConstitution(contents);
    case 'NoConfidence':
      return { kind: 'note', text: 'Motion of no-confidence in the constitutional committee.' };
    case 'InfoAction':
      return { kind: 'note', text: 'Informational action. No on-chain effect; the vote signals opinion only.' };
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run the test to confirm pass**

Run: `npx vitest run src/lib/governance/onchain.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/governance/onchain.ts src/lib/governance/onchain.test.ts
git commit -m "feat: decode on-chain payload into a per-type view model"
```

---

## Task 10: `GaOnchainChanges.astro` component

**Files:**
- Create: `src/components/ga/GaOnchainChanges.astro`

- [ ] **Step 1: Write the component**

```astro
---
// "On-chain changes" block for the Overview: renders the decoded payload per type.
// Renders nothing when there is no decodable payload.
import type { OnchainChanges } from '@/lib/governance/onchain.js';

interface Props { changes: OnchainChanges | null }
const { changes } = Astro.props;
const hasParams = changes?.kind === 'params' && changes.rows.length > 0;
const hasTreasury = changes?.kind === 'treasury' && changes.rows.length > 0;
const hasCommittee = changes?.kind === 'committee' && (changes.added.length > 0 || changes.removed.length > 0 || changes.threshold !== null);
const show =
  changes !== null &&
  (hasParams || hasTreasury || hasCommittee || changes.kind === 'hardfork' || changes.kind === 'constitution' || changes.kind === 'note');
---

{show && changes && (
  <section class="ocx">
    <p class="ocx__label">On-chain changes</p>

    {changes.kind === 'params' && (
      <ul class="ocx__rows">
        {changes.rows.map((r) => (
          <li class="ocx__row">
            <span class="ocx__group">{r.group}</span>
            <span class="ocx__name">{r.label}</span>
            <span class="ocx__val">
              {r.oldValue !== null && <span class="ocx__old">{r.oldValue}</span>}
              {r.oldValue !== null && <span class="ocx__arrow">→</span>}
              <span class="ocx__new">{r.newValue}</span>
            </span>
          </li>
        ))}
      </ul>
    )}

    {changes.kind === 'hardfork' && (
      <p class="ocx__single">
        Protocol Version{' '}
        {changes.fromVersion && <><span class="ocx__old">{changes.fromVersion}</span> <span class="ocx__arrow">→</span> </>}
        <span class="ocx__new">{changes.toVersion}</span>
      </p>
    )}

    {changes.kind === 'treasury' && (
      <>
        <ul class="ocx__rows">
          {changes.rows.map((r) => (
            <li class="ocx__row">
              <span class="ocx__name mono">{r.address}</span>
              <span class="ocx__val"><span class="ocx__new">{r.ada}</span></span>
            </li>
          ))}
        </ul>
        <p class="ocx__total">Total: <span class="ocx__new">{changes.totalAda}</span></p>
      </>
    )}

    {changes.kind === 'committee' && (
      <ul class="ocx__rows">
        {changes.threshold !== null && (
          <li class="ocx__row"><span class="ocx__name">New threshold</span><span class="ocx__val"><span class="ocx__new">{changes.threshold}</span></span></li>
        )}
        {changes.added.map((m) => (
          <li class="ocx__row"><span class="ocx__name">Added</span><span class="ocx__val mono">{m.who}{m.termEpoch !== null && <span class="ocx__group"> term to epoch {m.termEpoch}</span>}</span></li>
        ))}
        {changes.removed.map((m) => (
          <li class="ocx__row"><span class="ocx__name">Removed</span><span class="ocx__val mono">{m}</span></li>
        ))}
      </ul>
    )}

    {changes.kind === 'constitution' && (
      <ul class="ocx__rows">
        {changes.anchorUrl && (
          <li class="ocx__row"><span class="ocx__name">New constitution</span><span class="ocx__val"><a href={changes.anchorUrl} target="_blank" rel="noopener noreferrer">{changes.anchorUrl}</a></span></li>
        )}
        {changes.scriptHash && (
          <li class="ocx__row"><span class="ocx__name">Guardrails script</span><span class="ocx__val mono">{changes.scriptHash}</span></li>
        )}
      </ul>
    )}

    {changes.kind === 'note' && <p class="ocx__note">{changes.text}</p>}
  </section>
)}

<style>
  .ocx { margin: 0 0 1.25rem; border: 1px solid var(--border); border-radius: 0.5rem; padding: 1rem 1.125rem; background: var(--surface); }
  .ocx__label { font-size: 0.8125rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 0.6rem; }
  .ocx__rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .ocx__row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem; font-size: 0.875rem; }
  .ocx__group { font-size: 0.72rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; }
  .ocx__name { font-weight: 600; color: var(--fg); }
  .ocx__val { margin-left: auto; display: inline-flex; align-items: baseline; gap: 0.4rem; }
  .ocx__old { color: var(--muted); text-decoration: line-through; }
  .ocx__arrow { color: var(--muted); }
  .ocx__new { color: var(--fg); font-weight: 600; }
  .ocx__single, .ocx__total, .ocx__note { font-size: 0.9375rem; margin: 0.4rem 0 0; }
  .ocx__note { color: var(--muted); }
  .mono { font-family: monospace; font-size: 0.78rem; word-break: break-all; overflow-wrap: anywhere; }
</style>
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no new errors from the component.

- [ ] **Step 3: Commit**

```bash
git add src/components/ga/GaOnchainChanges.astro
git commit -m "feat: add GaOnchainChanges overview component"
```

---

## Task 11: Wire the block into the Overview

**Files:**
- Modify: `src/components/ga/GaOverview.astro`
- Modify: `src/pages/t/[slug].astro`

- [ ] **Step 1: Add an `onchain` prop to `GaOverview`**

In `GaOverview.astro`, extend the imports and `Props`:

```ts
import GaOnchainChanges from './GaOnchainChanges.astro';
import type { OnchainChanges } from '@/lib/governance/onchain.js';
```

```ts
interface Props {
  action: GovernanceAction;
  stake: StakeParticipation | null;
  tally: OverviewTally | null;
  onchain: OnchainChanges | null;
  now: number;
}
```

```ts
const { action, stake, tally, onchain, now } = Astro.props;
```

And render the block as the first child of `<section class="ga-overview">`, before `<GaStatCards …>`:

```astro
  <GaOnchainChanges changes={onchain} />
  <GaStatCards stake={stake} tally={tally} />
```

- [ ] **Step 2: Decode and pass it from the page**

In `src/pages/t/[slug].astro`, add the import near the other governance imports:

```ts
import { decodeOnchainChanges } from '@/lib/governance/onchain.js';
```

Compute the view model where `govAction` and `params` are in scope (after both are resolved):

```ts
const onchainChanges = govAction
  ? decodeOnchainChanges(govAction.onchainPayload, params?.rawJson ?? null, network)
  : null;
```

Pass it into the `<GaOverview>` element:

```astro
              <GaOverview
                action={govAction}
                stake={stake}
                tally={tally}
                onchain={onchainChanges}
                now={now}
              />
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (If `params` or `network` is named differently in the page, match the existing local names , `network` is already passed to `GaOnchain` and `params` to `GaSidebar`.)

- [ ] **Step 4: Commit**

```bash
git add src/components/ga/GaOverview.astro src/pages/t/\[slug\].astro
git commit -m "feat: render on-chain changes at the top of the governance overview"
```

---

## Task 12: Full verification

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: PASS (no regressions; new onchain/sync/db tests green).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Lint the changed files**

Run: `npm run lint`
Expected: no new lint errors. (Repo is lint-gated, not format-clean; do not run a repo-wide format.)

- [ ] **Step 4: Dash check (project rule)**

Run: `grep -rnE "—|–|―|&mdash;|&ndash;" src/lib/governance/onchain.ts src/components/ga/GaOnchainChanges.astro`
Expected: only the intended `→` arrows (U+2192, which is allowed; it is not an em/en dash). No em-dash (—) or en-dash (–).

- [ ] **Step 5: Manual smoke against preprod data** (optional but recommended)

Start the dev server (`CARDANO_NETWORK=preprod`) and open
`/t/parameter-change-4aa45fe4-0-6bdf757d`. Expected: an "On-chain changes" block
showing `Governance · Governance Action Deposit  100,000 ₳ → 1,000 ₳` above the
tally cards. Also open the van Rossem hard-fork thread and confirm
`Protocol Version 10 → 11`. (Old values appear only after the gov-sync `params`
phase has run once on the local DB to populate `protocol_params.raw_json`.)

---

## Notes for the implementer

- **Old values need the cache populated.** `protocol_params.raw_json` is filled by the gov-sync `params` phase. Until it has run once against the target DB, `decodeOnchainChanges` still renders new values (old shows nothing). This is expected and handled.
- **Backfill is gradual.** Existing `governance_actions` rows get their `onchain_payload` over subsequent cron ticks (≤50/run). Until then those Overviews simply omit the block , never an error.
- **`→` is allowed.** The project's dash rule forbids em/en dashes (—, –). The right-arrow U+2192 used for old→new is a different character and is intended UI.
- **Remote D1 migrations are manual.** After merge, apply `0030`/`0031` with `wrangler d1 migrations apply DB --remote` for both mainnet and preprod databases.
