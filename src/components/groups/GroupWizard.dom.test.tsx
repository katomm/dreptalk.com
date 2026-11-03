// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { drepIdForCredential } from '@/lib/groups/ids.js';

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

import GroupWizard from './GroupWizard.js';

const key = (c: string) => c.repeat(56);
const V = key('a');
const B = key('b');
const C = key('c');
const E = key('e');
const drep = (k: string) => drepIdForCredential({ kind: 'key', hash: k });
const HASH = '7'.repeat(64);
const ANCHOR = { url: `https://dreptalk.com/group-profile/${HASH}.json`, dataHash: HASH };

type Reply = { url: RegExp; body: unknown; status?: number };
const calls: Array<{ url: string; body: unknown }> = [];
const registered = (k: string, name: string): Reply => ({
  url: new RegExp(`check-drep\\?id=${drep(k)}$`),
  body: { registered: true, script: false, keyHash: k, name },
});
const PROFILE: Reply = { url: /\/api\/groups\/profile$/, body: { url: ANCHOR.url, hash: HASH } };

function show(replies: Reply[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const r = replies.find((x) => x.url.test(url));
      return r ? Response.json(r.body, { status: r.status ?? 200 }) : Response.json({ error: 'unexpected' }, { status: 500 });
    }),
  );
  render(<GroupWizard network="preprod" viewer={{ drepId: drep(V), keyHash: V }} serverSlot={1_000_000} />);
}

const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next' }));

async function addFounder(k: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Add a founder by DRep id' }), { target: { value: drep(k) } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
}

async function profileStep(name = 'Council') {
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: name } });
  next();
  await screen.findByRole('button', { name: 'Build and sign' });
}

const createBody = () => calls.find((c) => c.url.endsWith('/api/groups/actions'))?.body as { intent: unknown; selected: string[] };

afterEach(() => {
  cleanup();
  calls.length = 0;
  signTx.mockClear();
  submitTx.mockClear();
  buildGroupTx.mockClear();
  vi.unstubAllGlobals();
});

describe('GroupWizard founding alone', () => {
  it('founds an open group in one wallet step', async () => {
    show([
      PROFILE,
      { url: /\/api\/groups\/actions$/, body: { id: 'c1' } },
      { url: /\/witness$/, body: { accepted: [V], ignored: [], satisfied: true } },
      { url: /\/submit$/, body: { assembledTxHex: '84bb' } },
      { url: /\/submitted$/, body: { ok: true } },
    ]);
    fireEvent.click(screen.getByRole('radio', { name: /Open group/ }));
    expect(screen.getByText(/fixed once the group is founded/)).toBeTruthy();
    next();
    expect((screen.getByRole('radio', { name: 'Found alone' }) as HTMLInputElement).checked).toBe(true);
    next();
    expect(screen.getByText(/1 of 1 must sign/)).toBeTruthy();
    // An open group has no admission policy to separate.
    expect(screen.queryByRole('checkbox', { name: /separate admission policy/ })).toBeNull();
    next();
    await profileStep();
    expect(calls.find((c) => c.url.endsWith('/api/groups/profile'))?.body).toEqual({ name: 'Council' });
    expect(screen.getByText('Must sign: You')).toBeTruthy();
    expect(screen.getByText(/in one wallet step/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Build and sign' }));
    await waitFor(() => expect(submitTx).toHaveBeenCalledWith('84bb'));
    expect(signTx).toHaveBeenCalledWith('84aa', true);
    expect(createBody()).toEqual({
      intent: { kind: 'group_create', mode: 'open', control: { keys: [V], n: 1 }, admission: null, founders: [drep(V)], profile: ANCHOR },
      unsignedTxCbor: '84aa',
      selected: [],
    });
    const built = buildGroupTx.mock.calls[0][0] as { requiredSigners: string[]; tipSlot: number };
    expect(built.requiredSigners).toEqual([V]);
    expect(built.tipSlot).toBeGreaterThanOrEqual(1_000_000);
    expect(built.tipSlot).toBeLessThanOrEqual(1_000_000 + 600);
    expect(screen.getByText(/shows as confirming/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Build and sign' })).toBeNull();
  });

  it('offers a separate admission policy with its own keys and threshold', async () => {
    show([PROFILE, registered(E, 'Erin'), { url: /\/api\/groups\/actions$/, body: { id: 'c3' } }]);
    next();
    next();
    fireEvent.click(screen.getByRole('checkbox', { name: /separate admission policy/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Add an admission key by DRep id' }), { target: { value: drep(E) } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('checkbox', { name: 'Erin' })).toBeTruthy();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Admission threshold' }), { target: { value: '1' } });
    next();
    await profileStep();
    // The extra admission key signs the founding, so it is no longer a one step founding.
    expect(screen.getByText('Must sign: You, Erin')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Build and sign' }));
    expect(await screen.findByText(/\/groups\/sign\/c3\//)).toBeTruthy();
    expect(signTx).not.toHaveBeenCalled();
    expect(createBody().intent).toEqual({
      kind: 'group_create',
      mode: 'permissioned',
      control: { keys: [V], n: 1 },
      admission: { keys: [V, E], n: 1 },
      founders: [drep(V)],
      profile: ANCHOR,
    });
  });
});

describe('GroupWizard founding together', () => {
  it('founds a permissioned group with every founder as a signer and gives the signing link', async () => {
    show([PROFILE, registered(B, 'Bob'), registered(C, 'Carol'), { url: /\/api\/groups\/actions$/, body: { id: 'c2' } }]);
    next();
    fireEvent.click(screen.getByRole('radio', { name: 'Found together with other DReps' }));
    await addFounder(B);
    expect(await screen.findByText('Bob')).toBeTruthy();
    await addFounder(C);
    expect(await screen.findByText('Carol')).toBeTruthy();
    next();
    expect(screen.getByText(/2 of 3 must sign \(67%\)/)).toBeTruthy();
    next();
    await profileStep();
    expect(screen.getByText('Every founder signs the founding transaction, also when the threshold is lower.')).toBeTruthy();
    expect(screen.getByText('Must sign: You, Bob, Carol')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Build and sign' }));
    expect(await screen.findByText(/\/groups\/sign\/c2\//)).toBeTruthy();
    expect(signTx).not.toHaveBeenCalled();
    expect(createBody()).toMatchObject({
      intent: {
        kind: 'group_create',
        mode: 'permissioned',
        control: { keys: [V, B, C], n: 2 },
        admission: 'same',
        founders: [drep(V), drep(B), drep(C)],
        profile: ANCHOR,
      },
      selected: [],
    });
  });

  it('asks for another founder before going on', () => {
    show();
    next();
    fireEvent.click(screen.getByRole('radio', { name: 'Found together with other DReps' }));
    next();
    expect(screen.getByText('Add at least one other founder, or found the group alone.')).toBeTruthy();
    expect(screen.queryByRole('spinbutton', { name: 'Threshold' })).toBeNull();
  });
});

describe('GroupWizard refusals', () => {
  it('refuses script DReps, unregistered keys and the own DRep as further founders', async () => {
    show([{ url: /check-drep/, body: { registered: false, script: false, keyHash: B, name: null } }]);
    next();
    fireEvent.click(screen.getByRole('radio', { name: 'Found together with other DReps' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Add a founder by DRep id' }), {
      target: { value: drepIdForCredential({ kind: 'script', hash: key('f') }) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText(/Script DReps cannot be founders or admins/)).toBeTruthy();
    expect(calls).toHaveLength(0);
    await addFounder(B);
    expect(await screen.findByText(/This DRep is not registered/)).toBeTruthy();
    await addFounder(V);
    expect(await screen.findByText('This DRep is already listed.')).toBeTruthy();
  });

  it('refuses a threshold of 0 and one above the number of founders', async () => {
    show([registered(B, 'Bob')]);
    next();
    fireEvent.click(screen.getByRole('radio', { name: 'Found together with other DReps' }));
    await addFounder(B);
    await screen.findByText('Bob');
    next();
    const n = screen.getByRole('spinbutton', { name: 'Threshold' });
    fireEvent.change(n, { target: { value: '0' } });
    expect(screen.getByText('The threshold must be at least 1.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(n, { target: { value: '3' } });
    expect(screen.getByText('The threshold cannot be higher than the number of keys (2).')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks for a group name before storing the profile', () => {
    show();
    next();
    next();
    next();
    next();
    expect(screen.getByText('Give the group a name.')).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});
