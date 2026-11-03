// The build and submit flow every DRep group action shares, from the group page and from the
// founding wizard: the wallet that pays the fee, the panel that lists who signs, building the
// transaction in the browser, opening its signing link, and completing it in one wallet step when
// the initiator is the only signer. The outcome is either a submitted transaction or a link.
import { encodePayload, type NativeScript } from 'drep-groups';
import { useCallback, useRef, useState } from 'react';
import { CopyButton } from '@/components/CopyButton.js';
import WalletConnection from '@/components/WalletConnection.js';
import type { CardanoNetwork } from '@/lib/config/network.js';
import { txExplorerUrl } from '@/lib/config/network.js';
import type { WalletApi } from '@/lib/governance/walletUtxos.js';
import { expectedPayload, type GroupIntent, type GroupState, signerSetSatisfies, uniq } from '@/lib/groups/actions.js';
import { ACTION_TTL_SECONDS } from '@/lib/groups/constants.js';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import { assertWalletNetwork } from '@/lib/wallet/networkGuard.js';
import { rememberWallet, useCardanoWallets } from '@/lib/wallet/useCardanoWallets.js';
import { readableError } from '@/lib/wallet/walletError.js';

export type EnabledWalletApi = WalletApi & { getNetworkId(): Promise<number> };

export type Outcome = { link: string } | { submitted: string } | { slotTaken: string | null };

export const SLOT_HELD = 'Another management action is open, so the policy cannot be changed until it is resolved or expires.';

export const muted = { color: 'var(--muted)', fontSize: '0.875rem', margin: 0 } as const;
export const h2 = { fontSize: '1.0625rem', margin: '0 0 0.5rem' } as const;
export const stack = { display: 'flex', flexDirection: 'column', gap: '0.5rem' } as const;

export function Callout({ kind, children }: { kind: 'error' | 'info' | 'success'; children: React.ReactNode }) {
  return (
    <div className={`callout callout--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div className="callout__body">{children}</div>
    </div>
  );
}

export async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ? `${fallback} ${body.error}.` : fallback;
}

export const post = (url: string, body?: unknown) =>
  fetchWithTimeout(url, {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

/** The latest after lock of a member script, the earliest slot its transactions may be valid from. */
export function afterLock(s: NativeScript | null): number | undefined {
  if (!s) return undefined;
  if (s.type === 'after') return Number(s.slot);
  if (s.type === 'all' || s.type === 'any' || s.type === 'nOfK') {
    const locks = s.scripts.map(afterLock).filter((x): x is number => x !== undefined);
    return locks.length > 0 ? Math.max(...locks) : undefined;
  }
  return undefined;
}

export interface ActionKeys {
  mandatory: string[];
  optional: string[];
}

/** An action ready to build: the intent, its keys, the chosen optional signers and the tip slot. */
export interface ActionRun {
  intent: GroupIntent;
  state: GroupState | null;
  memberScript: NativeScript | null;
  keys: ActionKeys;
  signers: string[];
  viewerKey: string | null;
  tipSlot: number;
}

/**
 * Builds the transaction, opens its signing link and, when the viewer's key is the only required
 * signer, signs, assembles and submits it. An action that exists when a later step fails still
 * gives its link, it can be finished on its signing page.
 */
async function runGroupAction(
  api: EnabledWalletApi,
  network: CardanoNetwork,
  origin: string,
  r: ActionRun,
): Promise<{ outcome: Outcome | null; error: string | null }> {
  let id: string | null = null;
  try {
    const { buildGroupTx } = await import('@/lib/groups/groupTx.js');
    const lock = afterLock(r.memberScript);
    const required = uniq([...r.keys.mandatory, ...r.signers]);
    const interval = { invalidBefore: lock === undefined ? null : BigInt(lock), invalidHereafter: BigInt(r.tipSlot + ACTION_TTL_SECONDS) };
    if (!signerSetSatisfies(r.state, r.intent, r.memberScript, required, interval)) {
      throw new Error('The selected signers do not satisfy the policies of this action.');
    }
    const payload = encodePayload(expectedPayload(r.intent, r.state, new Map()));
    const { unsignedTxHex } = await buildGroupTx({
      walletApi: api,
      network,
      origin,
      payload,
      requiredSigners: required,
      optionalKeys: r.keys.optional,
      tipSlot: r.tipSlot,
      invalidBeforeSlot: lock,
    });
    const res = await post('/api/groups/actions', { intent: r.intent, unsignedTxCbor: unsignedTxHex, selected: r.signers });
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { id?: string | null };
      return { outcome: { slotTaken: body.id ?? null }, error: null };
    }
    if (!res.ok) throw new Error(await errorOf(res, 'Could not open the action.'));
    id = ((await res.json()) as { id: string }).id;
    const solo = !r.memberScript && r.viewerKey !== null && required.length === 1 && required[0] === r.viewerKey;
    if (!solo) return { outcome: { link: id }, error: null };
    const witnessSetHex = await api.signTx(unsignedTxHex, true);
    const witness = await post(`/api/groups/actions/${id}/witness`, { witnessSetHex });
    if (!witness.ok) throw new Error(await errorOf(witness, 'Could not add the signature.'));
    const assembled = await post(`/api/groups/actions/${id}/submit`);
    if (!assembled.ok) throw new Error(await errorOf(assembled, 'Could not assemble the transaction.'));
    const { assembledTxHex } = (await assembled.json()) as { assembledTxHex: string };
    const txHash = await api.submitTx(assembledTxHex);
    // The transaction is on its way, a failed record only delays the confirming state.
    await post(`/api/groups/actions/${id}/submitted`, { txHash }).catch(() => null);
    return { outcome: { submitted: txHash }, error: null };
  } catch (err) {
    return { outcome: id ? { link: id } : null, error: readableError(err) };
  }
}

/** The fee wallet, its connection and the run of one action. */
export function useActionRunner(network: CardanoNetwork) {
  const { wallets, selected: walletKey, setSelected: setWalletKey } = useCardanoWallets({ preferCip95: true });
  const apiRef = useRef<EnabledWalletApi | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async (): Promise<EnabledWalletApi | null> => {
    if (apiRef.current) return apiRef.current;
    const info = wallets.find((w) => w.key === walletKey);
    if (!info) {
      setError('Select a wallet to continue.');
      return null;
    }
    try {
      const api = (await info.raw.enable({ extensions: [{ cip: 95 }] })) as unknown as EnabledWalletApi;
      await assertWalletNetwork(api, network);
      apiRef.current = api;
      rememberWallet(walletKey);
      return api;
    } catch (err) {
      setError(readableError(err));
      return null;
    }
  }, [wallets, walletKey, network]);

  /** Runs the action, the outcome is null when nothing was opened. */
  const run = useCallback(
    async (r: ActionRun): Promise<Outcome | null> => {
      setError(null);
      setBusy(true);
      try {
        const api = await connect();
        if (!api) return null;
        const origin = typeof window !== 'undefined' ? window.location.origin : '';
        const done = await runGroupAction(api, network, origin, r);
        if (done.error) setError(done.error);
        return done.outcome;
      } finally {
        setBusy(false);
      }
    },
    [connect, network],
  );

  return { wallets, walletKey, setWalletKey, busy, error, setError, run };
}

export type ActionRunner = ReturnType<typeof useActionRunner>;

/**
 * Who signs an action and the wallet that pays its fee: the keys that must sign, the optional
 * keys to pick from, and the build button, enabled once the signers satisfy the action.
 */
export function DraftPanel({
  label,
  keys,
  signers,
  onSigners,
  satisfied,
  nameOf,
  viewerKey,
  runner,
  onBuild,
  onBack,
  children,
}: {
  label: string;
  keys: ActionKeys;
  signers: string[];
  onSigners: (s: string[]) => void;
  satisfied: boolean;
  nameOf: (key: string) => string;
  viewerKey: string | null;
  runner: ActionRunner;
  onBuild: () => void;
  onBack: () => void;
  children?: React.ReactNode;
}) {
  const choosable = keys.optional.filter((k) => k !== viewerKey || keys.optional.length > 1);
  const { wallets, walletKey, setWalletKey, busy } = runner;
  return (
    <section aria-label={label} style={stack}>
      <h2 style={h2}>{label}</h2>
      {children}
      {keys.mandatory.length > 0 && <p style={muted}>Must sign: {keys.mandatory.map(nameOf).join(', ')}</p>}
      {choosable.length > 0 && (
        <>
          <p style={{ margin: 0, fontWeight: 600, fontSize: '0.875rem' }}>Who signs</p>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.25rem' }}>
            {keys.optional.map((k) => (
              <li key={k}>
                <label style={{ display: 'inline-flex', gap: '0.375rem', alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    aria-label={`Signer ${nameOf(k)}`}
                    checked={signers.includes(k)}
                    onChange={() => onSigners(signers.includes(k) ? signers.filter((x) => x !== k) : uniq([...signers, k]))}
                  />
                  {nameOf(k)}
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      {!satisfied && <p style={muted}>These signers do not satisfy the policies of this action yet.</p>}
      {wallets.length === 0 ? (
        <p style={muted}>No Cardano wallet extension detected.</p>
      ) : (
        <WalletConnection wallets={wallets} selected={walletKey} onSelect={setWalletKey} disabled={busy} label="Wallet that pays the fee" />
      )}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="button" className="btn btn-primary" disabled={busy || !satisfied || wallets.length === 0} onClick={onBuild}>
          Build and sign
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onBack}>
          Back
        </button>
      </div>
    </section>
  );
}

/** The signing link, the submitted transaction or the open management action that holds the slot. */
export function OutcomeNotice({ outcome, network }: { outcome: Outcome; network: CardanoNetwork }) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  if ('link' in outcome) {
    const url = `${origin}/groups/sign/${outcome.link}/`;
    return (
      <Callout kind="info">
        Share this signing link with the other signers: {url} <CopyButton value={url} label="Copy link" />{' '}
        <a href={`/groups/sign/${outcome.link}/`}>Open the signing page</a>
      </Callout>
    );
  }
  if ('submitted' in outcome) {
    return (
      <Callout kind="success">
        Submitted. It shows as confirming until the chain confirms it.{' '}
        <a href={txExplorerUrl(network, outcome.submitted)} target="_blank" rel="noopener noreferrer">
          View transaction
        </a>
      </Callout>
    );
  }
  return (
    <Callout kind="info">
      {SLOT_HELD}
      {outcome.slotTaken && (
        <>
          {' '}
          <a href={`/groups/sign/${outcome.slotTaken}/`}>Open the signing page</a>
        </>
      )}
    </Callout>
  );
}
