/// <reference types="@cloudflare/workers-types" />
// DRep groups with mainnet switched on in the network list, injected for this file only. The
// workers tests run without a CARDANO_NETWORK binding, so currentNetwork() is mainnet here. Every
// groups surface reads the one list, so the switch turns them all on together.
import { describe, expect, it, vi } from 'vitest';
import { currentNetwork } from '@/lib/api/response';
import { navFor, navLinksFor } from '@/lib/config/nav';
import { matchStaticEntries } from '@/lib/search/staticEntries';
import { drepPhases } from '@/lib/sync/phases/dreps';
import { governancePhases } from '@/lib/sync/phases/governance';
import { GET as held } from '@/pages/api/groups/actions/held';
import { GET as state } from '@/pages/api/groups/[id]/state';
import { GROUPS_SCAN_AFTER_SLOT } from './constants.js';
import { drepGroupsAvailable } from './gate.js';
import { wallClockSlot } from './groupTx.js';
import { addressNetwork, groupIdString } from './ids.js';
import { myGroupsLink } from './myGroups.js';
import { ALICE, CAROL, call, PERM, seedPermissioned, sessionOf } from '@/pages/api/groups/actions/__tests__/fixtures';

vi.mock('./gate.js', async (orig) => {
  const real = await orig<typeof import('./gate.js')>();
  const on = ['preprod', 'mainnet'] as const;
  return { DREP_GROUPS_NETWORKS: on, drepGroupsAvailable: (n: Parameters<typeof real.drepGroupsAvailable>[0]) => real.drepGroupsAvailable(n, on) };
});

describe('DRep groups switched on for mainnet', () => {
  it('runs on mainnet', () => {
    expect(currentNetwork().network).toBe('mainnet');
    expect(drepGroupsAvailable('mainnet')).toBe(true);
  });

  it('shows the groups in nav and search on mainnet', () => {
    expect(navLinksFor('mainnet').map((l) => l.href)).toContain('/groups/');
    const dreps = navFor('mainnet').find((e) => e.label === 'DReps');
    expect(dreps && 'items' in dreps ? dreps.items.map((l) => l.label) : []).toContain('DRep groups');
    expect(matchStaticEntries('groups', false, 'mainnet').map((e) => e.href)).toContain('/groups/');
  });

  it('runs the gov-sync groups ingest and the group cleanups on mainnet', () => {
    const ctx = { cfg: { network: 'mainnet' } } as never;
    const gated = [...governancePhases, ...drepPhases].filter((p) => ['drep-groups', 'group-profile-docs-gc', 'group-action-retention'].includes(p.name));
    expect(gated).toHaveLength(3);
    for (const p of gated) expect(p.when?.(ctx)).toBe(true);
  });

  it('serves the group state with a mainnet slot and the account menu entry', async () => {
    await seedPermissioned();
    const id = groupIdString(PERM.ref);
    const res = await call<{ serverSlot: number }>(state, null, { id });
    expect(res.status).toBe(200);
    expect(Math.abs(res.json.serverSlot - wallClockSlot('mainnet'))).toBeLessThanOrEqual(2);
    expect(Math.abs(res.json.serverSlot - wallClockSlot('preprod'))).toBeGreaterThan(1_000_000);
    // Carol's request to join is pending, the menu links her group.
    expect(await myGroupsLink({} as App.Locals, 'mainnet', CAROL.drepId)).toEqual({ href: `/groups/${id}/`, label: 'My groups' });
    expect((await call(held, sessionOf('u1', ALICE))).status).toBe(200);
  });

  it('checks mainnet addresses and starts the mainnet label scan at the Conway hard fork', () => {
    expect(addressNetwork('mainnet')).toBe('mainnet');
    expect(addressNetwork('preprod')).toBe('testnet');
    // Shelley epoch 208 starts at slot 4492800, Conway epoch 507 is 299 epochs of 432000 slots later.
    expect(GROUPS_SCAN_AFTER_SLOT.mainnet).toBe(4_492_800 + 299 * 432_000 - 1);
    expect(GROUPS_SCAN_AFTER_SLOT.preprod).toBeNull();
  });
});
