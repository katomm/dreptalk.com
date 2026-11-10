// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { majorityScript } from 'drep-groups';
import type { GroupIntent } from '@/lib/groups/actions.js';
import { scriptDisplayJson } from '@/lib/groups/codec.js';
import { drepIdForCredential, groupIdString } from '@/lib/groups/ids.js';

const WALLET = {
  key: 'w',
  name: 'Test wallet',
  icon: '',
  supportsCip95: true,
  raw: { name: 'Test wallet', icon: '', enable: async () => ({ getNetworkId: async () => 0, signTx: async () => 'a0', submitTx: async () => 'e'.repeat(64) }) },
};
vi.mock('@/lib/wallet/useCardanoWallets.js', () => ({
  useCardanoWallets: () => ({ wallets: [WALLET], selected: 'w', setSelected: () => {} }),
  rememberWallet: () => {},
}));
vi.mock('@/lib/wallet/networkGuard.js', () => ({ assertWalletNetwork: async () => {} }));
vi.mock('@/lib/groups/groupTx.js', () => ({ buildGroupTx: async () => ({ unsignedTxHex: '84aa', bodyHashHex: 'c'.repeat(64) }), wallClockSlot: () => 1_000_000 }));

import GroupActions, { type GroupActionView } from './GroupActions.js';
import PolicyEditor, { type PolicyEditorProps } from './PolicyEditor.js';

const key = (c: string) => c.repeat(56);
const A = key('a');
const B = key('b');
const E = key('e');
const drep = (k: string) => drepIdForCredential({ kind: 'key', hash: k });
const NAMES: Record<string, string> = { [A]: 'Alice', [B]: 'Bob', [E]: 'Erin' };
const GID = groupIdString({ txHash: '10'.repeat(32), index: 0 });
const SCRIPT_ID = drepIdForCredential({ kind: 'script', hash: key('f') });
const HASH = '7'.repeat(64);

type Reply = { url: RegExp; body: unknown; status?: number };
const calls: Array<{ url: string; body: unknown }> = [];
function stubFetch(replies: Reply[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const r = replies.find((x) => x.url.test(url));
      return r ? Response.json(r.body, { status: r.status ?? 200 }) : Response.json({ error: 'unexpected' }, { status: 500 });
    }),
  );
}

const onContinue = vi.fn((_i: GroupIntent, _l: string, _n: Map<string, string>) => {});
function editor(o: Partial<PolicyEditorProps> = {}, replies: Reply[] = []) {
  stubFetch(replies);
  render(
    <PolicyEditor
      groupId={GID}
      current={{ n: 1, k: 2 }}
      controlKeys={[A, B]}
      resignedControl={[]}
      sameAdmission
      listed={new Set([A, B])}
      memberKeys={[A, B]}
      nameOf={(k) => NAMES[k] ?? k.slice(0, 8)}
      profile={{ name: 'Council', description: 'DReps who vote together.', website: 'https://c.test', image: 'https://dreptalk.com/drep-images/c.png' }}
      initial={null}
      slotHeld={false}
      canUpdate
      canDissolve
      resignKey={A}
      resignFreezes={false}
      groupName="Council"
      onContinue={onContinue}
      onClose={() => {}}
      {...o}
    />,
  );
}

afterEach(() => {
  cleanup();
  calls.length = 0;
  onContinue.mockClear();
  vi.unstubAllGlobals();
});

describe('PolicyEditor profile', () => {
  it('stores the edited profile and continues with an update of the profile alone', async () => {
    editor({}, [{ url: /\/api\/groups\/profile$/, body: { url: `https://dreptalk.com/group-profile/${HASH}.json`, hash: HASH } }]);
    const name = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
    expect(name.value).toBe('Council');
    fireEvent.change(name, { target: { value: 'New council' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review and sign' }));
    await waitFor(() => expect(onContinue).toHaveBeenCalled());
    expect(calls[0].body).toEqual({
      name: 'New council',
      description: 'DReps who vote together.',
      website: 'https://c.test',
      image: 'https://dreptalk.com/drep-images/c.png',
    });
    expect(onContinue.mock.calls[0][0]).toEqual({
      kind: 'group_update',
      group: GID,
      approvals: [],
      profile: { url: `https://dreptalk.com/group-profile/${HASH}.json`, dataHash: HASH },
    });
  });

  it('asks for a name before storing anything', async () => {
    editor({ profile: null });
    fireEvent.click(screen.getByRole('button', { name: 'Review and sign' }));
    expect(await screen.findByText('Give the group a name.')).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('asks for a description and an image before storing anything', async () => {
    editor({ profile: { name: 'Council', website: 'https://c.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review and sign' }));
    expect(await screen.findByText('Add a description.')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), { target: { value: 'DReps who vote together.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review and sign' }));
    expect(await screen.findByText('Add an image.')).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});

describe('PolicyEditor management policy', () => {
  it('changes the threshold and keeps admission following the control policy', () => {
    editor();
    fireEvent.click(screen.getByRole('button', { name: 'Change admins or threshold' }));
    expect(screen.getByText('This is the current policy.')).toBeTruthy();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Threshold' }), { target: { value: '2' } });
    expect(screen.getByText(/2 of 2 must sign \(100%\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review and sign' }));
    expect(onContinue.mock.calls[0][0]).toEqual({ kind: 'group_update', group: GID, approvals: [], control: { keys: [A, B], n: 2 }, admission: 'same' });
  });

  it('refuses a threshold of 0 and one above the number of admins', () => {
    editor();
    fireEvent.click(screen.getByRole('button', { name: 'Change admins or threshold' }));
    const n = screen.getByRole('spinbutton', { name: 'Threshold' });
    fireEvent.change(n, { target: { value: '0' } });
    expect(screen.getByText('The threshold must be at least 1.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Review and sign' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(n, { target: { value: '3' } });
    expect(screen.getByText('The threshold cannot be higher than the number of keys (2).')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Review and sign' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses script DReps and unregistered keys as admins and names a newly listed admin as a signer', async () => {
    editor({}, [
      { url: new RegExp(`check-drep\\?id=${drep(key('9'))}`), body: { registered: false, script: false, keyHash: key('9'), name: null } },
      { url: new RegExp(`check-drep\\?id=${drep(E)}`), body: { registered: true, script: false, keyHash: E, name: 'Erin' } },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Change admins or threshold' }));
    const field = screen.getByRole('textbox', { name: 'Add an admin by DRep id' });

    fireEvent.change(field, { target: { value: SCRIPT_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText(/Script DReps cannot be founders or admins/)).toBeTruthy();
    expect(calls).toHaveLength(0);

    fireEvent.change(field, { target: { value: drep(key('9')) } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText(/This DRep is not registered/)).toBeTruthy();

    fireEvent.change(field, { target: { value: drep(B) } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('This DRep is already listed.')).toBeTruthy();

    fireEvent.change(field, { target: { value: drep(E) } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('checkbox', { name: 'Erin' })).toBeTruthy();
    expect(screen.getByText('Each newly listed admin has to sign the update: Erin.')).toBeTruthy();
    // 1 of 2 carried to three keys.
    expect(screen.getByText(/2 of 3 must sign/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review and sign' }));
    expect(onContinue.mock.calls[0][0]).toMatchObject({ control: { keys: [A, B, E], n: 2 } });
  });

  it('offers a key that resigned from control without ticking it', () => {
    editor({ resignedControl: [B], listed: new Set([A]) });
    fireEvent.click(screen.getByRole('button', { name: 'Change admins or threshold' }));
    expect((screen.getByRole('checkbox', { name: 'Alice' }) as HTMLInputElement).checked).toBe(true);
    const bob = screen.getByRole('checkbox', { name: 'Bob' }) as HTMLInputElement;
    expect(bob.checked).toBe(false);
    fireEvent.click(bob);
    expect(screen.getByText('Each newly listed admin has to sign the update: Bob.')).toBeTruthy();
  });

  it('waits while another management action holds the slot', () => {
    editor({ slotHeld: true });
    expect(screen.getByText(/Another management action is open/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review and sign' })).toBeNull();
  });
});

describe('PolicyEditor dissolve', () => {
  it('needs an explicit confirmation and says that delegations do not change', () => {
    editor();
    fireEvent.click(screen.getByRole('button', { name: 'Dissolve the group' }));
    expect(screen.getByText("This cannot be undone. Members' delegations do not change.")).toBeTruthy();
    const go = screen.getByRole('button', { name: 'Review and sign' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /Yes, dissolve this group/ }));
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    expect(onContinue.mock.calls[0].slice(0, 2)).toEqual([{ kind: 'group_dissolve', group: GID }, 'Dissolve the group']);
  });

  it('is not offered when the key may not dissolve', () => {
    editor({ canDissolve: false });
    expect(screen.queryByRole('button', { name: 'Dissolve the group' })).toBeNull();
  });
});

describe('PolicyEditor on the group page', () => {
  function policy(keys: string[], n: number) {
    const m = majorityScript(keys, n);
    return { hash: m.hash, json: scriptDisplayJson(m.script), keys: [...m.keys] };
  }
  const control = policy([A, B], 1);
  const v: GroupActionView = {
    groupId: GID,
    mode: 'permissioned',
    status: 'active',
    seq: '0',
    serverSlot: 1_000_000,
    control,
    admission: control,
    resignedControl: [],
    resignedAdmission: [],
    names: NAMES,
    activeKeyMembers: [A, B].map((k) => ({ drepId: drep(k), keyHash: k, name: NAMES[k] })),
    activeMembers: [],
    pending: [],
    openControl: null,
    rows: [],
    viewer: { keyHash: A, drepId: drep(A), join: { joinId: `${'01'.repeat(32)}#1`, state: 'active' } },
  };

  it('opens for an admin and lists a newly added admin as a mandatory signer', async () => {
    stubFetch([
      { url: /\/state$/, body: v },
      { url: /check-drep/, body: { registered: true, script: false, keyHash: E, name: 'Erin' } },
    ]);
    render(<GroupActions groupId={GID} network="preprod" profile={{ name: 'Council' }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage the group' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change admins or threshold' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Add an admin by DRep id' }), { target: { value: drep(E) } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByRole('checkbox', { name: 'Erin' });
    fireEvent.click(screen.getByRole('button', { name: 'Review and sign' }));
    expect(await screen.findByText('Must sign: Erin')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Build and sign' })).toBeTruthy();
  });

  it('shows the name of an admin added by id in the draft panel', async () => {
    const Z = key('9');
    stubFetch([
      { url: /\/state$/, body: v },
      { url: /check-drep/, body: { registered: true, script: false, keyHash: Z, name: 'Zoltan' } },
    ]);
    render(<GroupActions groupId={GID} network="preprod" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage the group' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change admins or threshold' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Add an admin by DRep id' }), { target: { value: drep(Z) } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByRole('checkbox', { name: 'Zoltan' });
    fireEvent.click(screen.getByRole('button', { name: 'Review and sign' }));
    expect(await screen.findByText('Must sign: Zoltan')).toBeTruthy();
  });

  const FREEZE = 'Nobody will be able to change or dissolve this group after you resign. Members can still leave.';
  const resignTab = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Manage the group' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resign as admin' }));
  };

  it('asks for the group name before the last admin able to manage the group resigns', async () => {
    const both = policy([A, B], 2);
    stubFetch([{ url: /\/state$/, body: { ...v, control: both, admission: both } }]);
    render(<GroupActions groupId={GID} network="preprod" profile={{ name: 'Council' }} />);
    await resignTab();
    expect(screen.getByText(FREEZE)).toBeTruthy();
    const go = screen.getByRole('button', { name: 'Review and sign' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    const field = screen.getByRole('textbox', { name: 'Type the group name, Council, to confirm' });
    fireEvent.change(field, { target: { value: 'Counci' } });
    expect(go.disabled).toBe(true);
    fireEvent.change(field, { target: { value: 'Council' } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    expect(await screen.findByText('Alice resigns as admin.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Build and sign' })).toBeTruthy();
  });

  it('counts the keys that already resigned from control as unable to sign', async () => {
    const three = policy([A, B, E], 2);
    stubFetch([{ url: /\/state$/, body: { ...v, control: three, admission: three, resignedControl: [B], resignedAdmission: [B] } }]);
    render(<GroupActions groupId={GID} network="preprod" profile={{ name: 'Council' }} />);
    await resignTab();
    expect(screen.getByText(FREEZE)).toBeTruthy();
  });

  it('lets one of three admins of a 2 of 3 policy resign without the warning', async () => {
    const three = policy([A, B, E], 2);
    stubFetch([{ url: /\/state$/, body: { ...v, control: three, admission: three } }]);
    render(<GroupActions groupId={GID} network="preprod" profile={{ name: 'Council' }} />);
    await resignTab();
    expect(screen.queryByText(FREEZE)).toBeNull();
    expect(screen.queryByRole('textbox', { name: /to confirm/ })).toBeNull();
    const go = screen.getByRole('button', { name: 'Review and sign' }) as HTMLButtonElement;
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    expect(await screen.findByText('Alice resigns as admin.')).toBeTruthy();
  });

  it('offers an admission only admin the resign alone, also while the management slot is held', async () => {
    stubFetch([
      {
        url: /\/state$/,
        body: { ...v, control: policy([B], 1), admission: policy([A], 1), openControl: { id: null } },
      },
    ]);
    render(<GroupActions groupId={GID} network="preprod" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage the group' }));
    expect(screen.queryByRole('button', { name: 'Edit the profile' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change admins or threshold' })).toBeNull();
    expect(screen.queryByText(/Another management action is open/)).toBeNull();
    // Without a profile name the group id is the name to type, and only a frozen control policy asks for it.
    expect(screen.queryByText(FREEZE)).toBeNull();
    expect((screen.getByRole('button', { name: 'Review and sign' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('is not offered to a key that resigned from every role', async () => {
    stubFetch([{ url: /\/state$/, body: { ...v, resignedControl: [A], resignedAdmission: [A] } }]);
    render(<GroupActions groupId={GID} network="preprod" />);
    expect(await screen.findByRole('button', { name: 'Leave' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Manage the group' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resign as admin' })).toBeNull();
  });

  it('is not offered to a member outside the policies', async () => {
    const D = key('d');
    stubFetch([{ url: /\/state$/, body: { ...v, viewer: { keyHash: D, drepId: drep(D), join: { joinId: `${'02'.repeat(32)}#1`, state: 'active' } } } }]);
    render(<GroupActions groupId={GID} network="preprod" />);
    expect(await screen.findByRole('button', { name: 'Leave' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Manage the group' })).toBeNull();
  });
});
