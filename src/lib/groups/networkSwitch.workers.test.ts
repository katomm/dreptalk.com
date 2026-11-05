/// <reference types="@cloudflare/workers-types" />
// DRep groups with the real network list: off on mainnet. The workers tests run without a
// CARDANO_NETWORK binding, so currentNetwork() is mainnet here. Every groups surface is hidden or
// answers 404 there, and none of them reads a group table, which mainnet D1 does not have yet.
import { describe, expect, it } from 'vitest';
import { currentNetwork } from '@/lib/api/response';
import { isGroupSigner } from '@/lib/auth/groupSigner';
import { navLinksFor } from '@/lib/config/nav';
import { matchStaticEntries } from '@/lib/search/staticEntries';
import { drepPhases } from '@/lib/sync/phases/dreps';
import { governancePhases } from '@/lib/sync/phases/governance';
import { GET as checkDrep } from '@/pages/api/groups/check-drep';
import { POST as profile } from '@/pages/api/groups/profile';
import { POST as openAction } from '@/pages/api/groups/actions/index';
import { GET as held } from '@/pages/api/groups/actions/held';
import { GET as actionRow } from '@/pages/api/groups/actions/[id]';
import { POST as witness } from '@/pages/api/groups/actions/[id]/witness';
import { POST as submit } from '@/pages/api/groups/actions/[id]/submit';
import { POST as submitted } from '@/pages/api/groups/actions/[id]/submitted';
import { POST as cancel } from '@/pages/api/groups/actions/[id]/cancel';
import { GET as state } from '@/pages/api/groups/[id]/state';
import { GET as hostedProfile } from '@/pages/group-profile/[hash].json';
import { DREP_GROUPS_NETWORKS, drepGroupsAvailable } from './gate.js';
import { myGroupsLink } from './myGroups.js';

const DREP = 'drep1ygqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqcwrwe';

/** A database that fails every statement, for paths that must not reach a group table. */
const noDb = new Proxy({} as D1Database, {
  get: () => () => {
    throw new Error('no query expected while DRep groups are off');
  },
});

function route(path: string, method: 'GET' | 'POST', params: Record<string, string> = {}) {
  const url = new URL(`https://dreptalk.com${path}`);
  const request = new Request(url, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
  const locals = { user: { id: 'u1', drepId: DREP, roles: ['drep'] } } as unknown as App.Locals;
  return { request, url, params, locals } as never;
}

describe('DRep groups switched off on mainnet', () => {
  it('keeps mainnet out of the network list', () => {
    expect(currentNetwork().network).toBe('mainnet');
    expect(DREP_GROUPS_NETWORKS).not.toContain('mainnet');
    expect(drepGroupsAvailable('mainnet')).toBe(false);
    expect(drepGroupsAvailable('preprod')).toBe(true);
  });

  it('answers 404 on every groups API route and the hosted profile documents', async () => {
    const id = { id: 'x' };
    const responses = await Promise.all([
      checkDrep(route('/api/groups/check-drep?drepId=x', 'GET')),
      profile(route('/api/groups/profile', 'POST')),
      openAction(route('/api/groups/actions', 'POST')),
      held(route('/api/groups/actions/held', 'GET')),
      actionRow(route('/api/groups/actions/x', 'GET', id)),
      witness(route('/api/groups/actions/x/witness', 'POST', id)),
      submit(route('/api/groups/actions/x/submit', 'POST', id)),
      submitted(route('/api/groups/actions/x/submitted', 'POST', id)),
      cancel(route('/api/groups/actions/x/cancel', 'POST', id)),
      state(route('/api/groups/group1x/state', 'GET', { id: 'group1x' })),
      hostedProfile(route(`/group-profile/${'ab'.repeat(32)}.json`, 'GET', { hash: 'ab'.repeat(32) })),
    ]);
    expect(responses.map((r) => r.status)).toEqual(responses.map(() => 404));
  });

  it('leaves the groups out of nav and search', () => {
    expect(navLinksFor('mainnet').map((l) => l.href)).not.toContain('/groups/');
    expect(matchStaticEntries('groups', true, 'mainnet').map((e) => e.href)).not.toContain('/groups/');
    expect(navLinksFor('preprod').map((l) => l.href)).toContain('/groups/');
  });

  it('gives no account menu entry and no group signer login without reading the database', async () => {
    const locals = {} as App.Locals;
    expect(await myGroupsLink(locals, 'mainnet', DREP)).toBeNull();
    expect(locals.myGroups).toBeUndefined();
    expect(await isGroupSigner(noDb, 'mainnet', { isDrep: false, active: false, reason: 'not registered' }, DREP)).toBe(false);
  });

  it('skips the gov-sync groups ingest and the group cleanups', () => {
    const ctx = { cfg: { network: 'mainnet' } } as never;
    const gated = [...governancePhases, ...drepPhases].filter((p) => ['drep-groups', 'group-profile-docs-gc', 'group-action-retention'].includes(p.name));
    expect(gated.map((p) => p.name).sort()).toEqual(['drep-groups', 'group-action-retention', 'group-profile-docs-gc']);
    for (const p of gated) expect(p.when?.(ctx)).toBe(false);
  });
});
