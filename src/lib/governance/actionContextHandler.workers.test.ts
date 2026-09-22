/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for handleActionContext, run against real D1 (for the
// title lookup) with a mocked Koios client (network and env are injected via
// deps, matching gateGovActionRequest's own test style).
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { handleActionContext, type ActionContextKoios } from './actionContextHandler.js';
import type { ProposalListRow } from '../koios/client.js';

const preprod = { network: 'preprod', networkId: 0 } as never; // minimal NetworkConfig stub
const testEnv = { ...env } as Cloudflare.Env;

function ctx(type: string, user: { id: string; roles: string[] } | null = { id: 'ctx-user', roles: [] }) {
  const request = new Request(`https://dreptalk.com/api/gov-action/context?type=${encodeURIComponent(type)}`, {
    method: 'GET',
    headers: { 'sec-fetch-site': 'same-origin' },
  });
  return { request, locals: { user } as App.Locals };
}

function row(overrides: Partial<ProposalListRow> = {}): ProposalListRow {
  return {
    proposal_tx_hash: 'a'.repeat(64),
    proposal_index: 0,
    proposal_id: 'gov_action1abc',
    proposal_type: 'InfoAction',
    proposed_epoch: 500,
    ratified_epoch: null,
    enacted_epoch: null,
    expired_epoch: null,
    dropped_epoch: null,
    ...overrides,
  };
}

function mockKoios(overrides: Partial<ActionContextKoios> = {}): ActionContextKoios {
  return {
    tip: async () => ({ epoch_no: 600 }),
    epochParams: async () => null,
    lastRatifiedProposal: async () => [],
    openProposals: async () => [],
    committeeContext: async () => ({ members: [], quorum: null }),
    ...overrides,
  };
}

async function seedTitle(id: string, title: string) {
  await env.DB.prepare(
    `INSERT INTO governance_actions (id, type, anchor_status, status, title, created_at, last_synced_at)
     VALUES (?, 'InfoAction', 'no-anchor', 'active', ?, 1, 1)`,
  ).bind(id, title).run();
}

async function seedCcName(hotKeyHex: string, name: string, sourceBlockTime: number) {
  await env.DB.prepare(
    `INSERT INTO cc_member_name (hot_key_hex, name, source_ga_id, source_block_time, updated_at)
     VALUES (?, ?, NULL, ?, ?)`,
  ).bind(hotKeyHex, name, sourceBlockTime, sourceBlockTime).run();
}

async function seedHotKey(hotKeyHex: string, coldKeyHex: string) {
  await env.DB.prepare('INSERT INTO committee_hot_key (hot_key_hex, cold_key_hex) VALUES (?, ?)')
    .bind(hotKeyHex, coldKeyHex)
    .run();
}

describe('handleActionContext', () => {
  it('401s when signed out', async () => {
    const res = await handleActionContext(ctx('InfoAction', null), { koios: mockKoios(), network: preprod, env: testEnv });
    expect(res.status).toBe(401);
  });

  it('400s on an unrecognized type', async () => {
    const res = await handleActionContext(ctx('NotAType'), { koios: mockKoios(), network: preprod, env: testEnv });
    expect(res.status).toBe(400);
  });

  it('answers 503 JSON with no-store when a Koios call rejects', async () => {
    const res = await handleActionContext(ctx('InfoAction'), {
      koios: mockKoios({
        tip: async () => {
          throw new Error('koios request failed: 502');
        },
      }),
      network: preprod,
      env: testEnv,
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'service unavailable' });
  });

  it('answers 503 when a chain-specific Koios call rejects after tip succeeds', async () => {
    const res = await handleActionContext(ctx('NoConfidence'), {
      koios: mockKoios({
        lastRatifiedProposal: async () => {
          throw new Error('koios request failed: 500');
        },
      }),
      network: preprod,
      env: testEnv,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'service unavailable' });
  });

  it('returns only the epoch for InfoAction, with cache-control: no-store', async () => {
    const res = await handleActionContext(ctx('InfoAction'), {
      koios: mockKoios({ tip: async () => ({ epoch_no: 601 }) }),
      network: preprod,
      env: testEnv,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ epoch: 601 });
  });

  it('resolves the committee chain for NoConfidence, with titles from D1 where present', async () => {
    const lastEnactedId = `${'b'.repeat(64)}#0`;
    await seedTitle(lastEnactedId, 'Last Enacted Title');
    const lastEnacted = row({
      proposal_tx_hash: 'b'.repeat(64),
      proposal_index: 0,
      proposal_id: 'gov_action1last',
      proposal_type: 'NewCommittee',
      ratified_epoch: 500,
    });
    const open1 = row({
      proposal_tx_hash: 'c'.repeat(64),
      proposal_index: 1,
      proposal_id: 'gov_action1open1',
      proposal_type: 'NoConfidence',
      proposed_epoch: 520,
    });
    const open2 = row({
      proposal_tx_hash: 'd'.repeat(64),
      proposal_index: 2,
      proposal_id: 'gov_action1open2',
      proposal_type: 'NewCommittee',
      proposed_epoch: 510,
    });

    const res = await handleActionContext(ctx('NoConfidence'), {
      koios: mockKoios({
        lastRatifiedProposal: async () => [lastEnacted],
        openProposals: async () => [open1, open2],
      }),
      network: preprod,
      env: testEnv,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      prev: { lastEnacted: { id: string; title: string | null }; open: { id: string; title: string | null }[] };
    };
    expect(json.prev.lastEnacted.id).toBe('gov_action1last');
    expect(json.prev.lastEnacted.title).toBe('Last Enacted Title');
    expect(json.prev.open).toHaveLength(2);
    expect(json.prev.open.map((r) => r.title)).toEqual([null, null]);
  });

  it('includes protocolVersion and a typed version on every hard-fork ref, undefined without one', async () => {
    const lastEnacted = row({
      proposal_type: 'HardForkInitiation',
      ratified_epoch: 400,
      proposal_description: { tag: 'HardForkInitiation', contents: [null, { major: 10, minor: 0 }] },
    });
    const openWithVersion = row({
      proposal_tx_hash: 'e'.repeat(64),
      proposal_id: 'gov_action1open_v',
      proposal_type: 'HardForkInitiation',
      proposed_epoch: 450,
      proposal_description: { tag: 'HardForkInitiation', contents: [null, { major: 11, minor: 0 }] },
    });
    const openWithoutVersion = row({
      proposal_tx_hash: 'f'.repeat(64),
      proposal_id: 'gov_action1open_nov',
      proposal_type: 'HardForkInitiation',
      proposed_epoch: 440,
      proposal_description: undefined,
    });

    const res = await handleActionContext(ctx('HardForkInitiation'), {
      koios: mockKoios({
        lastRatifiedProposal: async () => [lastEnacted],
        openProposals: async () => [openWithVersion, openWithoutVersion],
        epochParams: async () => ({ protocol_major: 10, protocol_minor: 0 }),
      }),
      network: preprod,
      env: testEnv,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      protocolVersion: { major: number; minor: number };
      prev: { lastEnacted: { version?: { major: number; minor: number } }; open: { id: string; version?: { major: number; minor: number } }[] };
    };
    expect(json.protocolVersion).toEqual({ major: 10, minor: 0 });
    expect(json.prev.lastEnacted.version).toEqual({ major: 10, minor: 0 });
    expect(json.prev.open).toHaveLength(2);
    const withV = json.prev.open.find((r) => r.id === 'gov_action1open_v');
    const withoutV = json.prev.open.find((r) => r.id === 'gov_action1open_nov');
    expect(withV?.version).toEqual({ major: 11, minor: 0 });
    expect(withoutV?.version).toBeUndefined();
  });

  it('includes committee members, quorum (0 preserved), and maxTermLength for UpdateCommittee', async () => {
    const res = await handleActionContext(ctx('UpdateCommittee'), {
      koios: mockKoios({
        committeeContext: async () => ({
          members: [
            {
              status: 'authorized',
              cc_hot_id: null,
              cc_cold_id: null,
              cc_hot_hex: null,
              cc_cold_hex: 'abc123',
              expiration_epoch: 700,
              cc_hot_has_script: null,
              cc_cold_has_script: true,
            },
          ],
          quorum: { numerator: 0, denominator: 1 },
        }),
        epochParams: async () => ({ committee_max_term_length: null }),
      }),
      network: preprod,
      env: testEnv,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      committee: {
        members: { coldHex: string | null; hasScript: boolean; expirationEpoch: number | null; name: string | null }[];
        quorum: { numerator: number; denominator: number } | null;
        maxTermLength: number | null;
      };
    };
    expect(json.committee.members).toEqual([{ coldHex: 'abc123', hasScript: true, expirationEpoch: 700, name: null }]);
    expect(json.committee.quorum).toEqual({ numerator: 0, denominator: 1 });
    expect(json.committee.maxTermLength).toBeNull();
  });

  it('names a committee member from its self-declared vote rationale, resolved cold-key through the hot-to-cold map', async () => {
    const cold = 'c'.repeat(56);
    const hot = 'h'.repeat(56);
    await seedHotKey(hot, cold);
    await seedCcName(hot, 'Alice', 100);

    const res = await handleActionContext(ctx('UpdateCommittee'), {
      koios: mockKoios({
        committeeContext: async () => ({
          members: [
            {
              status: 'authorized',
              cc_hot_id: null,
              cc_cold_id: null,
              cc_hot_hex: hot,
              cc_cold_hex: cold,
              expiration_epoch: 700,
              cc_hot_has_script: null,
              cc_cold_has_script: false,
            },
          ],
          quorum: { numerator: 2, denominator: 3 },
        }),
      }),
      network: preprod,
      env: testEnv,
    });
    const json = (await res.json()) as {
      committee: { members: { coldHex: string | null; hasScript: boolean; expirationEpoch: number | null; name: string | null }[] };
    };
    expect(json.committee.members).toEqual([{ coldHex: cold, hasScript: false, expirationEpoch: 700, name: 'Alice' }]);
  });

  it('leaves name null for a committee member with no stored display name', async () => {
    const cold = 'd'.repeat(56);
    const res = await handleActionContext(ctx('NoConfidence'), {
      koios: mockKoios({
        committeeContext: async () => ({
          members: [
            {
              status: 'authorized',
              cc_hot_id: null,
              cc_cold_id: null,
              cc_hot_hex: null,
              cc_cold_hex: cold,
              expiration_epoch: 700,
              cc_hot_has_script: null,
              cc_cold_has_script: false,
            },
          ],
          quorum: { numerator: 2, denominator: 3 },
        }),
      }),
      network: preprod,
      env: testEnv,
    });
    const json = (await res.json()) as {
      committee: { members: { coldHex: string | null; hasScript: boolean; expirationEpoch: number | null; name: string | null }[] };
    };
    expect(json.committee.members).toEqual([{ coldHex: cold, hasScript: false, expirationEpoch: 700, name: null }]);
  });

  // The names are cosmetic, the chain data next to them is what the form
  // validates against, so a D1 hiccup on the name reads must not 503 the whole
  // context and block the submit.
  it('still answers 200 with unnamed members when the D1 name reads reject', async () => {
    const cold = 'd'.repeat(56);
    const realDb = env.DB;
    const failingNamesDb = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (sql.includes('cc_member_name') || sql.includes('committee_member') || sql.includes('committee_hot_key')) {
              throw new Error('D1_ERROR: names read failed');
            }
            return realDb.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1Database;

    const res = await handleActionContext(ctx('NoConfidence'), {
      koios: mockKoios({
        committeeContext: async () => ({
          members: [
            {
              status: 'authorized',
              cc_hot_id: null,
              cc_cold_id: null,
              cc_hot_hex: null,
              cc_cold_hex: cold,
              expiration_epoch: 700,
              cc_hot_has_script: null,
              cc_cold_has_script: false,
            },
          ],
          quorum: { numerator: 2, denominator: 3 },
        }),
      }),
      network: preprod,
      env: { ...testEnv, DB: failingNamesDb } as Cloudflare.Env,
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      committee: { members: { coldHex: string | null; hasScript: boolean; expirationEpoch: number | null; name: string | null }[] };
    };
    expect(json.committee.members).toEqual([{ coldHex: cold, hasScript: false, expirationEpoch: 700, name: null }]);
  });

  it('resolves the current name through a rotated hot key: the newer vote under the newer hot key wins', async () => {
    const cold = 'e'.repeat(56);
    const oldHot = 'f'.repeat(56);
    const newHot = '1'.repeat(56);
    await seedHotKey(oldHot, cold);
    await seedHotKey(newHot, cold);
    await seedCcName(oldHot, 'Old Name', 100);
    await seedCcName(newHot, 'New Name', 200);

    const res = await handleActionContext(ctx('UpdateCommittee'), {
      koios: mockKoios({
        committeeContext: async () => ({
          members: [
            {
              status: 'authorized',
              cc_hot_id: null,
              cc_cold_id: null,
              cc_hot_hex: newHot,
              cc_cold_hex: cold,
              expiration_epoch: 700,
              cc_hot_has_script: null,
              cc_cold_has_script: false,
            },
          ],
          quorum: { numerator: 2, denominator: 3 },
        }),
      }),
      network: preprod,
      env: testEnv,
    });
    const json = (await res.json()) as {
      committee: { members: { coldHex: string | null; hasScript: boolean; expirationEpoch: number | null; name: string | null }[] };
    };
    expect(json.committee.members).toEqual([{ coldHex: cold, hasScript: false, expirationEpoch: 700, name: 'New Name' }]);
  });

  it('resolves a name declared only under a retired hot key, through the current hot key sharing the same cold key', async () => {
    const cold = '2'.repeat(56);
    const oldHot = '3'.repeat(56);
    const newHot = '4'.repeat(56);
    await seedHotKey(oldHot, cold);
    await seedHotKey(newHot, cold);
    await seedCcName(oldHot, 'Retired Vote Author', 100);
    // newHot never voted with a name attached, only a lookup through the
    // shared cold key can find it, a direct hot-key lookup on the current
    // hot key would answer null here.

    const res = await handleActionContext(ctx('UpdateCommittee'), {
      koios: mockKoios({
        committeeContext: async () => ({
          members: [
            {
              status: 'authorized',
              cc_hot_id: null,
              cc_cold_id: null,
              cc_hot_hex: newHot,
              cc_cold_hex: cold,
              expiration_epoch: 700,
              cc_hot_has_script: null,
              cc_cold_has_script: false,
            },
          ],
          quorum: { numerator: 2, denominator: 3 },
        }),
      }),
      network: preprod,
      env: testEnv,
    });
    const json = (await res.json()) as {
      committee: { members: { coldHex: string | null; hasScript: boolean; expirationEpoch: number | null; name: string | null }[] };
    };
    expect(json.committee.members).toEqual([{ coldHex: cold, hasScript: false, expirationEpoch: 700, name: 'Retired Vote Author' }]);
  });

  it('includes constitution.scriptHash from the last ratified row, null when there is none', async () => {
    const withScript = row({
      proposal_type: 'NewConstitution',
      ratified_epoch: 300,
      proposal_description: {
        tag: 'NewConstitution',
        contents: [null, { anchor: { url: 'https://example.com/con.json' }, script: 'deadbeef' }],
      },
    });

    const res = await handleActionContext(ctx('NewConstitution'), {
      koios: mockKoios({ lastRatifiedProposal: async () => [withScript] }),
      network: preprod,
      env: testEnv,
    });
    const json = (await res.json()) as { constitution: { scriptHash: string | null } };
    expect(json.constitution.scriptHash).toBe('deadbeef');

    const resNone = await handleActionContext(ctx('NewConstitution'), {
      koios: mockKoios({ lastRatifiedProposal: async () => [] }),
      network: preprod,
      env: testEnv,
    });
    const jsonNone = (await resNone.json()) as { constitution: { scriptHash: string | null } };
    expect(jsonNone.constitution.scriptHash).toBeNull();
  });

  it('falls back to the last ratified ParameterChange policy hash when no NewConstitution was ever ratified', async () => {
    const policyChange = row({
      proposal_type: 'ParameterChange',
      ratified_epoch: 300,
      proposal_description: {
        tag: 'ParameterChange',
        contents: [null, null, 'fa24fb305126805cf2164c161d852a0e7330cf988f1fe558cf7d4a64'],
      },
    });

    const res = await handleActionContext(ctx('NewConstitution'), {
      koios: mockKoios({
        lastRatifiedProposal: async (types) =>
          types.includes('NewConstitution' as never) ? [] : [policyChange],
      }),
      network: preprod,
      env: testEnv,
    });
    const json = (await res.json()) as { constitution: { scriptHash: string | null } };
    expect(json.constitution.scriptHash).toBe('fa24fb305126805cf2164c161d852a0e7330cf988f1fe558cf7d4a64');
  });

  it('picks the newer of a ratified NewConstitution and a ratified ParameterChange', async () => {
    const constitutionRow = row({
      proposal_type: 'NewConstitution',
      ratified_epoch: 400,
      proposal_description: {
        tag: 'NewConstitution',
        contents: [null, { anchor: { url: 'https://example.com/con.json' }, script: 'aa'.repeat(28) }],
      },
    });
    const policyChange = row({
      proposal_type: 'ParameterChange',
      ratified_epoch: 300,
      proposal_description: {
        tag: 'ParameterChange',
        contents: [null, null, 'fa24fb305126805cf2164c161d852a0e7330cf988f1fe558cf7d4a64'],
      },
    });

    const res = await handleActionContext(ctx('NewConstitution'), {
      koios: mockKoios({
        lastRatifiedProposal: async (types) =>
          types.includes('NewConstitution' as never) ? [constitutionRow] : [policyChange],
      }),
      network: preprod,
      env: testEnv,
    });
    const json = (await res.json()) as { constitution: { scriptHash: string | null } };
    expect(json.constitution.scriptHash).toBe('aa'.repeat(28));

    const newerPolicy = { ...policyChange, ratified_epoch: 500 };
    const res2 = await handleActionContext(ctx('NewConstitution'), {
      koios: mockKoios({
        lastRatifiedProposal: async (types) =>
          types.includes('NewConstitution' as never) ? [constitutionRow] : [newerPolicy],
      }),
      network: preprod,
      env: testEnv,
    });
    const json2 = (await res2.json()) as { constitution: { scriptHash: string | null } };
    expect(json2.constitution.scriptHash).toBe('fa24fb305126805cf2164c161d852a0e7330cf988f1fe558cf7d4a64');
  });
});
