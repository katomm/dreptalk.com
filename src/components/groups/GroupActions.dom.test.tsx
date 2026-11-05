// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { majorityScript } from 'drep-groups';
import { scriptDisplayJson } from '@/lib/groups/codec.js';
import { drepIdForCredential, groupIdString } from '@/lib/groups/ids.js';

const signTx = vi.fn(async (_tx: string, _partial: boolean) => 'a0');
const submitTx = vi.fn(async (_tx: string) => 'e'.repeat(64));
const WALLET = {
  key: 'w',
  name: 'Test wallet',
  icon: '',
  supportsCip95: true,
  raw: { name: 'Test wallet', icon: '', enable: async () => ({ getNetworkId: async () => 0, signTx, submitTx }) },
};
vi.mock('@/lib/wallet/useCardanoWallets.js', () => ({
  useCardanoWallets: () => ({ wallets: [WALLET], selected: 'w', setSelected: () => {} }),
  rememberWallet: () => {},
}));
vi.mock('@/lib/wallet/networkGuard.js', () => ({ assertWalletNetwork: async () => {} }));
const buildGroupTx = vi.fn(async (_o: unknown) => ({ unsignedTxHex: '84aa', bodyHashHex: 'c'.repeat(64) }));
vi.mock('@/lib/groups/groupTx.js', () => ({ buildGroupTx: (o: unknown) => buildGroupTx(o), wallClockSlot: () => 1_000_900 }));

import GroupActions, { type GroupActionView } from './GroupActions.js';

const key = (c: string) => c.repeat(56);
const A = key('a');
const B = key('b');
const C = key('c');
const D = key('d');
const E = key('e');
const drep = (k: string) => drepIdForCredential({ kind: 'key', hash: k });
const NAMES: Record<string, string> = { [A]: 'Alice', [B]: 'Bob', [C]: 'Carol', [D]: 'Dave', [E]: 'Erin' };
const GID = groupIdString({ txHash: '10'.repeat(32), index: 0 });
const CAROL_JOIN = `${'30'.repeat(32)}#0`;

function policy(keys: string[], n: number) {
  const m = majorityScript(keys, n);
  return { hash: m.hash, json: scriptDisplayJson(m.script), keys: [...m.keys] };
}

const member = (k: string) => ({ drepId: drep(k), keyHash: k, name: NAMES[k] });

function view(o: Partial<GroupActionView> = {}): GroupActionView {
  const control = policy([A, B], 1);
  return {
    groupId: GID,
    mode: 'permissioned',
    status: 'active',
    seq: '0',
    serverSlot: 1_000_000,
    control,
    admission: control,
    names: NAMES,
    activeKeyMembers: [member(A), member(B)],
    activeMembers: [],
    pending: [],
    openControl: null,
    rows: [],
    viewer: null,
    ...o,
  };
}

const viewer = (k: string, join: { joinId: string; state: 'pending' | 'active' } | null = null) => ({ keyHash: k, drepId: drep(k), join });

type Reply = { url: RegExp; body: unknown; status?: number };
const calls: Array<{ url: string; body: unknown }> = [];

function show(v: GroupActionView, replies: Reply[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/state')) return Response.json(v);
      const r = replies.find((x) => x.url.test(url));
      return r ? Response.json(r.body, { status: r.status ?? 200 }) : Response.json({ error: 'unexpected' }, { status: 500 });
    }),
  );
  render(<GroupActions groupId={GID} network="preprod" />);
}

afterEach(() => {
  cleanup();
  calls.length = 0;
  signTx.mockClear();
  submitTx.mockClear();
  buildGroupTx.mockClear();
  vi.unstubAllGlobals();
});

describe('GroupActions buttons by role', () => {
  it('offers nothing to a visitor without a DRep login, but shows a confirming action', async () => {
    show(view({ rows: [{ id: null, kind: 'group_create', status: 'submitted' }] }));
    expect(await screen.findByText(/Founding: confirming/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link', { name: /signing page/ })).toBeNull();
  });

  it('says an action in progress whose coin another transaction spent can no longer be submitted', async () => {
    show(view({ rows: [{ id: 'r1', kind: 'group_approve', status: 'collecting', inputSpent: true }] }));
    expect(await screen.findByText(/can no longer be submitted$/)).toBeTruthy();
    expect(
      screen.getByText('This transaction can no longer be submitted, a coin it spends was used by another transaction. Cancel it and start it again.'),
    ).toBeTruthy();
    expect(screen.queryByText(/collecting signatures/)).toBeNull();
  });

  it('lets a key DRep join an open group as a self-declared member', async () => {
    show(view({ mode: 'open', admission: null, viewer: viewer(C) }));
    expect(await screen.findByRole('button', { name: 'Join' })).toBeTruthy();
    expect(screen.getByText(/self-declared/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request to join' })).toBeNull();
  });

  it('lets a key DRep request to join a permissioned group', async () => {
    show(view({ viewer: viewer(C) }));
    expect(await screen.findByRole('button', { name: 'Request to join' })).toBeTruthy();
    expect(screen.getByText(/confirmed by the group/)).toBeTruthy();
  });

  it('lets a pending member leave and says leaving is always possible', async () => {
    show(view({ viewer: viewer(C, { joinId: CAROL_JOIN, state: 'pending' }) }));
    expect(await screen.findByRole('button', { name: 'Leave' })).toBeTruthy();
    expect(screen.getByText(/Leaving is always possible with your own signature, also while your request is pending/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /join/i })).toBeNull();
    cleanup();
    // While the own leave is open it is shown with its signing page and Leave is not offered again.
    show(view({ viewer: viewer(C, { joinId: CAROL_JOIN, state: 'pending' }), rows: [{ id: 'r1', kind: 'group_leave', status: 'collecting' }] }));
    expect(await screen.findByText(/Leave: collecting signatures/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Leave' })).toBeNull();
    expect(screen.getByText(/Leave: collecting signatures/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the signing page' }).getAttribute('href')).toBe('/groups/sign/r1/');
  });

  it('gives admins the request queue with approve and remove, members do not get it', async () => {
    const pending = [{ joinId: CAROL_JOIN, drepId: drep(C), name: 'Carol' }];
    show(view({ pending, viewer: viewer(A, { joinId: `${'01'.repeat(32)}#1`, state: 'active' }) }));
    expect(await screen.findByRole('checkbox', { name: 'Carol' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    cleanup();
    show(view({ pending, viewer: viewer(D, { joinId: `${'02'.repeat(32)}#1`, state: 'active' }) }));
    expect(await screen.findByRole('button', { name: 'Leave' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});

describe('GroupActions initiation rules', () => {
  const separate = { control: policy([A], 1), admission: policy([B], 1), activeKeyMembers: [member(A), member(B)] };
  const carol = [{ joinId: CAROL_JOIN, drepId: drep(C), name: 'Carol' }];

  it('lets a control only key approve just with the update, and not remove', async () => {
    show(view({ ...separate, pending: carol, viewer: viewer(A, { joinId: `${'01'.repeat(32)}#1`, state: 'active' }) }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Carol' }));
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /Also update the management policy/ })).toBeNull();
    expect(screen.getByText(/only together with an update/)).toBeTruthy();
    expect(screen.getByText(/2 of 2 must sign/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('gives an admission only key approve and remove but no policy update', async () => {
    show(
      view({
        ...separate,
        activeKeyMembers: [member(A), member(B), member(C)],
        pending: [{ joinId: `${'40'.repeat(32)}#0`, drepId: drep(D), name: 'Dave' }],
        viewer: viewer(B, { joinId: `${'02'.repeat(32)}#1`, state: 'active' }),
      }),
    );
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(screen.getByText(/still managed by/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Update the policy' })).toBeNull();
  });
});

describe('GroupActions combined update offer', () => {
  it('carries 3 of 4 to 4 of 5 when Carol is approved, with more than half and decline', async () => {
    const control = policy([A, B, D, E], 3);
    show(
      view({
        control,
        admission: control,
        activeKeyMembers: [member(A), member(B), member(D), member(E)],
        pending: [{ joinId: CAROL_JOIN, drepId: drep(C), name: 'Carol' }],
        viewer: viewer(A, { joinId: `${'01'.repeat(32)}#1`, state: 'active' }),
      }),
    );
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Carol' }));
    expect(screen.getByText(/4 of 5 must sign \(80%\)/)).toBeTruthy();
    expect(screen.getByText(/Each newly listed admin has to sign the update/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'More than half' }));
    expect(screen.getByText(/3 of 5 must sign \(60%\)/)).toBeTruthy();
    // Declining the update leaves a plain approval.
    fireEvent.click(screen.getByRole('checkbox', { name: /Also update the management policy/ }));
    expect(screen.queryByText(/of 5 must sign/)).toBeNull();
  });

  it('names an applicant in the offer by the name of the request, which the policy names lack', async () => {
    // The state route names the policy keys only, the applicant's name comes with the request.
    const names = { [A]: 'Alice', [B]: 'Bob' };
    show(
      view({
        names,
        pending: [{ joinId: CAROL_JOIN, drepId: drep(C), name: 'Carol' }],
        viewer: viewer(A, { joinId: `${'01'.repeat(32)}#1`, state: 'active' }),
      }),
    );
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Carol' }));
    expect(screen.getAllByRole('checkbox', { name: 'Carol' })).toHaveLength(2);
    expect(screen.getByText('Each newly listed admin has to sign the update: Carol.')).toBeTruthy();
  });

  it('holds the offer back while another management action is open', async () => {
    show(
      view({
        pending: [{ joinId: CAROL_JOIN, drepId: drep(C), name: 'Carol' }],
        openControl: { id: 'u9' },
        viewer: viewer(A, { joinId: `${'01'.repeat(32)}#1`, state: 'active' }),
      }),
    );
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Carol' }));
    expect(screen.getByText(/Another management action is open/)).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /Also update the management policy/ })).toBeNull();
  });
});

describe('GroupActions drift notice', () => {
  const drifted = { activeKeyMembers: [member(A), member(B), member(C)] };
  const TEXT = 'The group is still managed by: Alice, Bob. Members not in the policy: Carol.';

  it('shows members the drift text without the button', async () => {
    show(view({ ...drifted, viewer: viewer(C, { joinId: CAROL_JOIN, state: 'active' }) }));
    expect(await screen.findByText(TEXT)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Update the policy' })).toBeNull();
  });

  it('shows no notice to a pending request', async () => {
    show(view({ ...drifted, viewer: viewer(D, { joinId: `${'40'.repeat(32)}#0`, state: 'pending' }) }));
    expect(await screen.findByRole('button', { name: 'Leave' })).toBeTruthy();
    expect(screen.queryByText(/still managed by/)).toBeNull();
  });

  it('names admins who are no longer members also next to members outside the policy', async () => {
    show(view({ activeKeyMembers: [member(A), member(C)], viewer: viewer(A, { joinId: `${'01'.repeat(32)}#1`, state: 'active' }) }));
    expect(await screen.findByText('The group is still managed by: Alice, Bob. Members not in the policy: Carol. No longer members: Bob.')).toBeTruthy();
  });

  it('gives admins the button, pre-filled with every active key member', async () => {
    show(view({ ...drifted, viewer: viewer(A, { joinId: `${'01'.repeat(32)}#1`, state: 'active' }) }));
    expect(await screen.findByText(TEXT)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Update the policy' }));
    // 1 of 2 carried to three keys.
    expect(screen.getByText(/2 of 3 must sign \(67%\)/)).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Carol' })).toBeTruthy();
  });

  it('shows no notice in an open group', async () => {
    show(view({ ...drifted, mode: 'open', admission: null, viewer: viewer(A, { joinId: `${'01'.repeat(32)}#1`, state: 'active' }) }));
    expect(await screen.findByRole('button', { name: 'Leave' })).toBeTruthy();
    expect(screen.queryByText(/still managed by/)).toBeNull();
  });
});

describe('GroupActions leave warning', () => {
  it('warns an admin whose leave leaves the threshold unreachable', async () => {
    show(view({ control: policy([A, B], 2), admission: null, mode: 'open', viewer: viewer(A, { joinId: `${'01'.repeat(32)}#1`, state: 'active' }) }));
    expect(await screen.findByText(/can no longer reach its threshold/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update the policy first' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Leave' })).toBeTruthy();
  });

  it('does not warn when the remaining admins still reach it', async () => {
    show(view({ control: policy([A, B], 1), admission: null, mode: 'open', viewer: viewer(A, { joinId: `${'01'.repeat(32)}#1`, state: 'active' }) }));
    expect(await screen.findByRole('button', { name: 'Leave' })).toBeTruthy();
    expect(screen.queryByText(/can no longer reach its threshold/)).toBeNull();
  });
});

describe('GroupActions member removal', () => {
  const BOB_JOIN = `${'02'.repeat(32)}#1`;
  const SCRIPT_MEMBER = drepIdForCredential({ kind: 'script', hash: key('f') });
  const activeMembers = [
    { joinId: `${'01'.repeat(32)}#1`, drepId: drep(A), name: 'Alice' },
    { joinId: BOB_JOIN, drepId: drep(B), name: 'Bob' },
    { joinId: `${'03'.repeat(32)}#0`, drepId: SCRIPT_MEMBER, name: 'Script council' },
  ];
  const both = policy([A, B], 2);

  it('lets an admin remove an active member after a confirmation naming them', async () => {
    show(
      view({ control: both, admission: both, activeMembers, viewer: viewer(A, { joinId: activeMembers[0].joinId, state: 'active' }) }),
      [{ url: /\/api\/groups\/actions$/, body: { id: 'r5' } }],
    );
    expect(await screen.findByRole('button', { name: 'Remove Bob' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Script council' })).toBeTruthy();
    // The admin leaves with Leave, not by removing themselves.
    expect(screen.queryByRole('button', { name: 'Remove Alice' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Bob' }));
    expect(screen.getByText('Remove Bob from the group? Their delegations do not change.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/Remove Bob from the group/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Build and sign' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Bob' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Build and sign' }));
    expect(await screen.findByText(/\/groups\/sign\/r5\//)).toBeTruthy();
    expect(signTx).not.toHaveBeenCalled();
    const post = calls.find((c) => c.url.endsWith('/api/groups/actions'));
    expect(post?.body).toMatchObject({ intent: { kind: 'group_remove', group: GID, joins: [BOB_JOIN] }, selected: [A, B] });
  });

  it('picks active members as signers before a former member still in the policy, and marks the former one', async () => {
    const members = [activeMembers[0], { joinId: `${'05'.repeat(32)}#1`, drepId: drep(C), name: 'Carol' }, activeMembers[2]];
    const drifted = policy([A, B, C], 2);
    show(
      view({
        control: drifted,
        admission: drifted,
        activeKeyMembers: [member(A), member(C)],
        activeMembers: members,
        viewer: viewer(A, { joinId: members[0].joinId, state: 'active' }),
      }),
      [{ url: /\/api\/groups\/actions$/, body: { id: 'r6' } }],
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Script council' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove' }));
    expect((await screen.findByRole('checkbox', { name: 'Signer Carol' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Signer Bob (no longer a member)' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Build and sign' }));
    expect(await screen.findByText(/\/groups\/sign\/r6\//)).toBeTruthy();
    const post = calls.find((c) => c.url.endsWith('/api/groups/actions'));
    expect(post?.body).toMatchObject({ selected: [A, C] });
  });

  it('gives a member who is not an admin no remove control', async () => {
    show(view({ activeMembers, viewer: viewer(D, { joinId: `${'04'.repeat(32)}#1`, state: 'active' }) }));
    expect(await screen.findByRole('button', { name: 'Leave' })).toBeTruthy();
    expect(screen.queryAllByRole('button', { name: /^Remove/ })).toHaveLength(0);
  });

  it('gives the admins of an open group no remove control', async () => {
    show(view({ mode: 'open', admission: null, activeMembers, viewer: viewer(A, { joinId: activeMembers[0].joinId, state: 'active' }) }));
    expect(await screen.findByRole('button', { name: 'Leave' })).toBeTruthy();
    expect(screen.queryAllByRole('button', { name: /^Remove/ })).toHaveLength(0);
  });
});

describe('GroupActions building', () => {
  it('completes a key DRep join in one wallet step', async () => {
    show(view({ mode: 'open', admission: null, viewer: viewer(C) }), [
      { url: /\/api\/groups\/actions$/, body: { id: 'j1' } },
      { url: /\/witness$/, body: { accepted: [C], ignored: [], satisfied: true } },
      { url: /\/submit$/, body: { assembledTxHex: '84bb' } },
      { url: /\/submitted$/, body: { ok: true } },
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'Join' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Build and sign' }));
    await waitFor(() => expect(submitTx).toHaveBeenCalledWith('84bb'));
    expect(screen.getByText(/shows as confirming/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Build and sign' })).toBeNull();
    const built = buildGroupTx.mock.calls[0][0] as { requiredSigners: string[]; tipSlot: number };
    expect(built.requiredSigners).toEqual([C]);
    // The browser clock runs 15 minutes fast, the validity end follows the server's slot.
    expect(built.tipSlot).toBeGreaterThanOrEqual(1_000_000);
    expect(built.tipSlot).toBeLessThanOrEqual(1_000_000 + 600);
    expect(signTx).toHaveBeenCalledWith('84aa', true);
    const post = calls.find((c) => c.url.endsWith('/api/groups/actions'));
    expect(post?.body).toMatchObject({ intent: { kind: 'group_join', group: GID, member: drep(C) }, unsignedTxCbor: '84aa', selected: [] });
  });

  it('shows the signing link when more than the initiator must sign', async () => {
    const both = policy([A, B], 2);
    show(
      view({
        control: both,
        admission: both,
        activeKeyMembers: [member(A), member(B)],
        pending: [{ joinId: CAROL_JOIN, drepId: drep(C), name: 'Carol' }],
        viewer: viewer(A, { joinId: `${'01'.repeat(32)}#1`, state: 'active' }),
      }),
      [{ url: /\/api\/groups\/actions$/, body: { id: 'a7' } }],
    );
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Carol' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Also update the management policy/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Build and sign' }));
    expect(await screen.findByText(/\/groups\/sign\/a7\//)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Build and sign' })).toBeNull();
    expect((screen.getByRole('checkbox', { name: 'Carol' }) as HTMLInputElement).checked).toBe(false);
    expect(signTx).not.toHaveBeenCalled();
    const post = calls.find((c) => c.url.endsWith('/api/groups/actions'));
    expect(post?.body).toMatchObject({ intent: { kind: 'group_approve', group: GID, joins: [CAROL_JOIN] }, selected: [A, B] });
  });
});
