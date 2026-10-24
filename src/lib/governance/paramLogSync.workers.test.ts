/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { PARAM_LOG_BATCH, syncParamLog } from './paramLogSync.js';
import { getParamLogState, paramRowAsOf } from '../db/paramLog.js';

type Row = Record<string, unknown>;

const base = (epoch: number, over: Row = {}): Row => ({
  epoch_no: epoch,
  era: 'shelley',
  nonce: 'abc',
  block_hash: 'def',
  min_fee_a: 44,
  optimal_pool_count: 150,
  max_tx_ex_mem: null,
  ...over,
});

function stub(answer: Row[]) {
  const calls: { afterEpoch: number; limit: number }[] = [];
  return {
    calls,
    epochParamsAfter: async (afterEpoch: number, limit: number) => {
      calls.push({ afterEpoch, limit });
      return answer;
    },
  };
}

const run = (answer: Row[]) => syncParamLog({ db: env.DB, koios: stub(answer) });
const log = async () =>
  (await env.DB.prepare('SELECT param_key, epoch, value_json, gov_action_id FROM param_changes ORDER BY epoch, param_key').all<{
    param_key: string;
    epoch: number;
    value_json: string;
    gov_action_id: string | null;
  }>()).results;
const setState = (n: number) => env.DB.prepare('INSERT OR REPLACE INTO param_log_state (id, last_epoch) VALUES (1, ?)').bind(n).run();
const put = (key: string, epoch: number, json: string, id: string | null = null) =>
  env.DB.prepare('INSERT INTO param_changes (param_key, epoch, value_json, gov_action_id) VALUES (?, ?, ?, ?)').bind(key, epoch, json, id).run();

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM param_changes').run();
  await env.DB.prepare('DELETE FROM param_log_state').run();
  await env.DB.prepare('DELETE FROM governance_actions').run();
});

describe('syncParamLog', () => {
  it('logs every non-null field of the first epoch and later changes only', async () => {
    const k = stub([base(208), base(209, { optimal_pool_count: 500 })]);
    const r = await syncParamLog({ db: env.DB, koios: k });
    expect(k.calls).toEqual([{ afterEpoch: -1, limit: PARAM_LOG_BATCH }]);
    expect(PARAM_LOG_BATCH).toBe(50);
    expect(r).toMatchObject({ fromEpoch: 208, toEpoch: 209, inserted: 3 });
    const rows = await log();
    expect(rows.filter((x) => x.epoch === 208).map((x) => x.param_key)).toEqual(['min_fee_a', 'optimal_pool_count']);
    expect(rows.find((x) => x.param_key === 'optimal_pool_count' && x.epoch === 208)?.value_json).toBe('"150"');
    expect(rows.find((x) => x.param_key === 'optimal_pool_count' && x.epoch === 209)?.value_json).toBe('"500"');
    expect(await getParamLogState(env.DB)).toBe(209);
  });

  it('writes nothing when Koios has no newer epoch', async () => {
    await run([base(208), base(209)]);
    const before = await log();
    const r = await run([]);
    expect(r).toMatchObject({ fromEpoch: null, toEpoch: null, inserted: 0 });
    expect(await log()).toEqual(before);
    expect(await getParamLogState(env.DB)).toBe(209);
  });

  it('catches up from the state and logs a change and its reversal', async () => {
    await setState(300);
    await put('min_fee_a', 208, '"44"');
    const k = stub([base(301, { min_fee_a: 45 }), base(302, { min_fee_a: 44 })]);
    const r = await syncParamLog({ db: env.DB, koios: k });
    expect(k.calls[0].afterEpoch).toBe(300);
    expect(r).toMatchObject({ fromEpoch: 301, toEpoch: 302 });
    const rows = (await log()).filter((x) => x.epoch > 300 && x.param_key === 'min_fee_a');
    expect(rows.map((x) => [x.epoch, x.value_json])).toEqual([[301, '"45"'], [302, '"44"']]);
    expect(await getParamLogState(env.DB)).toBe(302);
  });

  it('sets the state to the last epoch of a short page', async () => {
    await run([base(10), base(11), base(12)]);
    expect(await getParamLogState(env.DB)).toBe(12);
  });

  it('aborts on out-of-order rows', async () => {
    await setState(300);
    const r = await run([base(302), base(301)]);
    expect(r).toMatchObject({ fromEpoch: null, toEpoch: null, inserted: 0 });
    expect(await log()).toEqual([]);
    expect(await getParamLogState(env.DB)).toBe(300);
  });

  it('aborts on a row without a numeric epoch', async () => {
    await setState(300);
    await run([base(301), { ...base(302), epoch_no: null }]);
    expect(await log()).toEqual([]);
    expect(await getParamLogState(env.DB)).toBe(300);
  });

  it('writes nothing when the answer starts after a gap', async () => {
    await setState(300);
    await run([base(302), base(303)]);
    expect(await log()).toEqual([]);
    expect(await getParamLogState(env.DB)).toBe(300);
  });

  it('takes the contiguous prefix before a gap', async () => {
    await setState(300);
    const r = await run([base(301), base(303, { min_fee_a: 99 })]);
    expect(r).toMatchObject({ fromEpoch: 301, toEpoch: 301 });
    expect((await log()).every((x) => x.epoch === 301)).toBe(true);
    expect(await getParamLogState(env.DB)).toBe(301);
  });
});

describe('param log linking', () => {
  const action = (id: string, enacted: number | null, payload: unknown) =>
    env.DB.prepare(
      `INSERT INTO governance_actions (id, type, status, enacted_epoch, onchain_payload, created_at, last_synced_at)
       VALUES (?, 'ParameterChange', 'enacted', ?, ?, 1, 1)`,
    ).bind(id, enacted, JSON.stringify(payload)).run();
  const payload = { tag: 'ParameterChange', contents: [null, { maxTxExecutionUnits: { memory: 16500000, steps: 10000000000 } }, null] };
  const ID = `c21b00f9${'0'.repeat(56)}#0`;

  it('does not touch rows below the lowest enacted epoch', async () => {
    await action(ID, 614, payload);
    await setState(614);
    await put('max_tx_ex_mem', 300, '"1"');
    const r = await run([]);
    expect(r.linked).toBe(0);
    expect((await log())[0].gov_action_id).toBeNull();
  });

  it('links the rows an enacted proposal set, once', async () => {
    await action(ID, 614, payload);
    await setState(614);
    await put('max_tx_ex_mem', 614, '"16500000"');
    await put('max_tx_ex_steps', 614, '"10000000000"');
    await put('min_fee_a', 614, '"44"');
    expect(await run([])).toMatchObject({ linked: 2, inserted: 0 });
    const rows = await log();
    expect(rows.filter((x) => x.gov_action_id === ID).map((x) => x.param_key)).toEqual(['max_tx_ex_mem', 'max_tx_ex_steps']);
    expect(rows.find((x) => x.param_key === 'min_fee_a')?.gov_action_id).toBeNull();
    expect((await run([])).linked).toBe(0);
  });
});

describe('paramRowAsOf', () => {
  it('rebuilds the row of an epoch from the newest value per key', async () => {
    await put('min_fee_a', 208, '"44"');
    await put('decentralisation', 208, '"1"');
    await put('decentralisation', 400, 'null');
    expect(await paramRowAsOf(env.DB, 300)).toBeNull();
    await setState(450);
    expect(await paramRowAsOf(env.DB, 300)).toEqual({ min_fee_a: '44', decentralisation: '1' });
    expect(await paramRowAsOf(env.DB, 420)).toEqual({ min_fee_a: '44' });
    expect(await paramRowAsOf(env.DB, 451)).toBeNull();
    expect(await paramRowAsOf(env.DB, 100)).toEqual({});
  });
});
