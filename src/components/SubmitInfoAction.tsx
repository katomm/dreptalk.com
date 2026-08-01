// React island: client-side, non-custodial InfoAction governance-action
// submission flow. preprod-only, experimental internal tool (unlinked page).
//
// Non-custodial: the wallet signs and submits; the server never sees a
// private key. The flow: (1) fetch the current gov action deposit so the user
// knows what they are committing, (2) connect a plain CIP-30 wallet (no CIP-95;
// a proposal needs no DRep key), (3) collect the CIP-108 fields with an
// optional author signature, (4) host the metadata via the /api/gov-action
// routes, (5) build/sign/submit the propose tx via submitInfoAction. Mirrors
// DRepService/VotePanel for wallet selection, connect, and phase handling.
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import { CopyButton } from '@/components/CopyButton.js';
import { useCardanoWallets, rememberWallet } from '@/lib/wallet/useCardanoWallets.js';
import { submitInfoAction } from '@/lib/governance/infoActionTx.js';
import {
  INFO_TITLE_MAX,
  INFO_ABSTRACT_MAX,
  INFO_MOTIVATION_MAX,
  INFO_RATIONALE_MAX,
} from '@/lib/governance/infoActionLimits.js';
import type { CardanoNetwork } from '@/lib/config/network.js';
import { txExplorerUrl } from '@/lib/config/network.js';
import { readableError } from '@/lib/wallet/walletError.js';
import { assertWalletNetwork } from '@/lib/wallet/networkGuard.js';
import { inputStyle, labelStyle } from '@/components/drepFormStyles.js';
import WalletConnection from '@/components/WalletConnection.js';

// Mirrors the un-exported AUTHOR_NAME_MAX in infoActionMetadataHandler.ts; kept
// in sync manually since that constant is server-internal.
const AUTHOR_NAME_MAX = 120;

// Mirrors the un-exported REFERENCE_LABEL_MAX / REFERENCE_URI_MAX / REFERENCES_MAX
// in infoActionMetadataHandler.ts; kept in sync manually since those constants
// are server-internal (like AUTHOR_NAME_MAX above).
const REFERENCE_LABEL_MAX = 200;
const REFERENCE_URI_MAX = 2048;
const REFERENCES_MAX = 10;

// The real CIP-30 DataSignature shape (COSE_Sign1 signature + COSE_Key). The
// drepTx WalletApi omits signData entirely (no tx builder there calls it), so
// this island defines its own fuller CIP-30 surface. It is a structural
// superset of drepTx's WalletApi, so passing it to submitInfoAction needs no
// cast.
type DataSignature = { signature: string; key: string };

interface Cip30Api {
  // Never called again on an already-enabled api; typed as never so a stray
  // call anywhere below this point is a compile error, not a runtime bug.
  enable?: never;
  getNetworkId(): Promise<number>;
  getRewardAddresses(): Promise<string[]>;
  getUsedAddresses(): Promise<string[]>;
  getUnusedAddresses(): Promise<string[]>;
  getUtxos(): Promise<string[]>;
  signData(addressHex: string, payloadHex: string): Promise<DataSignature>;
  signTx(txHex: string, partial: boolean): Promise<string>;
  submitTx(txHex: string): Promise<string>;
}

interface InfoActionFields {
  title: string;
  abstract: string;
  motivation: string;
  rationale: string;
}

// A row in the References editor below. Kept as a local, unadorned shape
// (not the server's Cip108Reference) so this island never imports
// cip108Canonical.ts, which would drag the jsonld/URDNA2015 engine into the
// client bundle; the server adds the fixed '@type': 'Other' field.
interface ReferenceRow {
  label: string;
  uri: string;
}

type DepositState =
  | { status: 'loading' }
  | { status: 'ready'; lovelace: bigint }
  | { status: 'error'; message: string };

type Phase =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'form' }
  | { status: 'submitting' }
  | { status: 'success'; txHash: string; authored: boolean }
  // `connected` distinguishes a connect-step error (show the wallet picker
  // again) from a submit-step error (keep the filled form on screen).
  | { status: 'error'; message: string; connected: boolean };

export interface SubmitInfoActionProps {
  network: CardanoNetwork;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Parses the passthrough `gov_action_deposit` Koios field (number or numeric string) to lovelace. */
function parseDepositLovelace(raw: unknown): bigint | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return BigInt(Math.trunc(raw));
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return BigInt(raw);
  return null;
}

/** Lovelace (bigint or numeric string) formatted as an ADA amount. */
function formatAda(lovelace: bigint | string): string {
  const value = typeof lovelace === 'bigint' ? lovelace : BigInt(lovelace);
  return (Number(value) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// Matches the exact message thrown by submitInfoAction's funding-shortfall
// guard (see infoActionTx.ts), so the required/available numbers can be
// reformatted in ADA and the "no UTxOs at all" case can get its own wording.
const INSUFFICIENT_FUNDS_RE = /^Insufficient tADA for the deposit: need (\d+) lovelace, wallet has (\d+)\.$/;

/**
 * Maps a submitInfoAction failure to a readable message. The network guard
 * already ran at connect time, so by the time this fires the wallet is
 * confirmed to be on preprod; a zero-UTxO shortfall on a preprod wallet is far
 * more often "this is a Preview wallet, not Preprod" than "genuinely empty",
 * so that case gets its own wording instead of the generic insufficient-funds
 * message. Anything else (including a wallet-rejected signTx) falls back to
 * the shared CIP-30 error reader.
 */
function mapSubmitError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const m = INSUFFICIENT_FUNDS_RE.exec(raw);
  if (m) {
    const [, requiredLovelace, availableLovelace] = m;
    if (availableLovelace === '0') {
      return 'No preprod UTxOs found for this wallet (is it a Preview wallet? Preview and Preprod are separate testnets with separate funds).';
    }
    return `Insufficient tADA: this proposal needs about ${formatAda(requiredLovelace)} tADA (deposit plus fee headroom), but your wallet only has ${formatAda(availableLovelace)} tADA.`;
  }
  return readableError(err);
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

const textAreaStyle: CSSProperties = { ...inputStyle, lineHeight: '1.6', resize: 'vertical', fontFamily: 'inherit' };
const helpStyle: CSSProperties = { display: 'block', fontSize: '0.8125rem', color: 'var(--muted)', margin: '0 0 0.375rem' };
const labelRowStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.5rem' };
const counterStyle: CSSProperties = { fontSize: '0.75rem', color: 'var(--muted)', flexShrink: 0 };

/** A labelled field with a live "used / max" counter and a helper line, matching DrepProfileFields' CountedField. */
function CountedField(props: { id: string; label: string; count: number; max: number; help: string; children: ReactNode }) {
  return (
    <div>
      <div style={labelRowStyle}>
        <label htmlFor={props.id} style={labelStyle}>{props.label}</label>
        <span style={counterStyle}>{props.count} / {props.max}</span>
      </div>
      <span style={helpStyle}>{props.help}</span>
      {props.children}
    </div>
  );
}

function InfoIcon() {
  return (
    <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

/** Deposit callout shown above the connect/form flow, regardless of wallet state. */
function DepositInfo({ deposit }: { deposit: DepositState }) {
  return (
    <div className={`callout callout--${deposit.status === 'error' ? 'error' : 'info'}`} role="status">
      {deposit.status === 'error' ? <ErrorIcon /> : <InfoIcon />}
      <div className="callout__body">
        {deposit.status === 'loading' && <p style={{ margin: 0 }}>Loading the current governance action deposit...</p>}
        {deposit.status === 'error' && <p style={{ margin: 0 }}>{deposit.message}</p>}
        {deposit.status === 'ready' && (
          <>
            <p style={{ margin: '0 0 0.5rem', fontWeight: 600 }}>
              Governance action deposit: {formatAda(deposit.lovelace)} tADA
            </p>
            <ul style={{ margin: 0, paddingLeft: '1.1rem', color: 'var(--muted)', fontSize: '0.8125rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <li>This is the current on-chain governance action deposit.</li>
              <li>The transaction is built with the SDK&apos;s live protocol parameters at submit time; those are authoritative and may differ slightly from this figure.</li>
              <li>The deposit is refunded to your reward address once the action is ratified, enacted, or expires.</li>
              <li>Your wallet needs at least this much tADA, plus a small network fee, to submit.</li>
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// React component
// ---------------------------------------------------------------------------

export default function SubmitInfoAction({ network }: SubmitInfoActionProps) {
  const { wallets, selected, setSelected } = useCardanoWallets();
  const [phase, setPhase] = useState<Phase>({ status: 'idle' });
  const [deposit, setDeposit] = useState<DepositState>({ status: 'loading' });

  // Cached CIP-30 api: avoids a second enable() IPC round trip on submit,
  // mirroring DRepService/VotePanel's enabledApiRef pattern.
  const enabledApiRef = useRef<Cip30Api | null>(null);

  // CIP-108 form fields.
  const [title, setTitle] = useState('');
  const [abstract, setAbstract] = useState('');
  const [motivation, setMotivation] = useState('');
  const [rationale, setRationale] = useState('');
  const [signAsAuthor, setSignAsAuthor] = useState(false);
  const [authorName, setAuthorName] = useState('');
  const [references, setReferences] = useState<ReferenceRow[]>([]);

  // Deposit is informational chain data, independent of wallet connection;
  // load it once on mount so it is ready before the user reaches the form.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithTimeout(`${window.location.origin}/api/koios/epoch_params?limit=1`);
        if (!res.ok) throw new Error(`epoch_params request failed (${res.status})`);
        const rows = (await res.json()) as Array<{ gov_action_deposit?: unknown }>;
        const lovelace = parseDepositLovelace(rows[0]?.gov_action_deposit);
        if (lovelace === null) throw new Error('gov_action_deposit missing from response');
        if (!cancelled) setDeposit({ status: 'ready', lovelace });
      } catch {
        if (!cancelled) {
          setDeposit({
            status: 'error',
            message: 'Could not load the current governance action deposit. Please reload the page.',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const busy = phase.status === 'connecting' || phase.status === 'submitting';

  // ------------------------------------------------------------------
  // References row editor (optional, like GovTool's reference links).
  // ------------------------------------------------------------------
  function updateReference(i: number, patch: Partial<ReferenceRow>) {
    setReferences((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeReference(i: number) {
    setReferences((rows) => rows.filter((_, idx) => idx !== i));
  }
  function addReference() {
    setReferences((rows) => (rows.length < REFERENCES_MAX ? [...rows, { label: '', uri: '' }] : rows));
  }

  // ------------------------------------------------------------------
  // Step 1: connect wallet, run network guard. Plain CIP-30 enable, no CIP-95
  // extension: submitting a proposal needs no DRep key.
  // ------------------------------------------------------------------
  async function handleConnect() {
    const walletInfo = wallets.find((w) => w.key === selected);
    if (!walletInfo) return;

    setPhase({ status: 'connecting' });

    let api: Cip30Api;
    try {
      api = (await walletInfo.raw.enable()) as unknown as Cip30Api;
    } catch (err) {
      setPhase({ status: 'error', message: readableError(err), connected: false });
      return;
    }

    // Fail clearly before any tx is built when the wallet is on the wrong
    // network (e.g. Mainnet instead of Preprod).
    try {
      await assertWalletNetwork(api, network);
    } catch (err) {
      setPhase({ status: 'error', message: readableError(err), connected: false });
      return;
    }

    enabledApiRef.current = api;
    rememberWallet(selected);
    setPhase({ status: 'form' });
  }

  // ------------------------------------------------------------------
  // Step 2: submit. Prepare + sign the author witness (if toggled), host the
  // metadata, then build/sign/submit the propose tx.
  // ------------------------------------------------------------------
  async function handleSubmit() {
    const api = enabledApiRef.current;
    if (!api) {
      setPhase({ status: 'error', message: 'Wallet connection was lost. Please reconnect.', connected: false });
      return;
    }
    if (deposit.status !== 'ready') {
      setPhase({
        status: 'error',
        message: 'The current deposit amount has not finished loading. Please wait a moment and try again.',
        connected: true,
      });
      return;
    }

    const fields: InfoActionFields = {
      title: title.trim(),
      abstract: abstract.trim(),
      motivation: motivation.trim(),
      rationale: rationale.trim(),
    };
    if (!fields.title || !fields.abstract || !fields.motivation || !fields.rationale) {
      setPhase({ status: 'error', message: 'Please fill in every field.', connected: true });
      return;
    }
    const trimmedAuthorName = authorName.trim();
    if (signAsAuthor && !trimmedAuthorName) {
      setPhase({ status: 'error', message: 'Enter a name to sign as the author, or turn off "Sign as author".', connected: true });
      return;
    }

    // Trimmed, non-empty rows only. Sent identically to both the prepare and
    // finalize calls below so the hash the wallet signs matches what is
    // finally anchored.
    const referencePayload = references
      .map((r) => ({ label: r.label.trim(), uri: r.uri.trim() }))
      .filter((r) => r.label && r.uri);

    setPhase({ status: 'submitting' });

    try {
      // The reward address is required regardless of author signing: it is
      // where the deposit refund lands, and (when signing) the address the
      // CIP-108 witness proves ownership of.
      const rewardAddresses = await api.getRewardAddresses();
      const rewardAddressHex = rewardAddresses[0];
      if (!rewardAddressHex) {
        setPhase({
          status: 'error',
          message: 'Your wallet exposes no reward address, so it cannot receive the deposit refund. Please use a different wallet.',
          connected: true,
        });
        return;
      }

      let author: { name: string; keyHex: string; signatureHex: string } | undefined;
      if (signAsAuthor) {
        const prepareRes = await fetchWithTimeout(`${window.location.origin}/api/gov-action/metadata/prepare`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...fields, ...(referencePayload.length > 0 ? { references: referencePayload } : {}) }),
        });
        if (!prepareRes.ok) {
          const body = (await prepareRes.json().catch(() => null)) as { error?: string } | null;
          setPhase({
            status: 'error',
            message: body?.error
              ? `Could not prepare the metadata for signing: ${body.error}.`
              : 'Could not prepare the metadata for signing. Please try again.',
            connected: true,
          });
          return;
        }
        const { bodyHash } = (await prepareRes.json()) as { bodyHash: string };

        // bodyHash is already the hex encoding of the 32 raw bytes to sign;
        // pass it straight through as the CIP-30 Bytes argument. Do not
        // re-encode it as a UTF-8 string first.
        let sig: DataSignature;
        try {
          sig = await api.signData(rewardAddressHex, bodyHash);
        } catch (err) {
          setPhase({ status: 'error', message: readableError(err), connected: true });
          return;
        }
        author = { name: trimmedAuthorName, keyHex: sig.key, signatureHex: sig.signature };
      }

      const metaRes = await fetchWithTimeout(`${window.location.origin}/api/gov-action/metadata`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...fields,
          ...(author ? { author } : {}),
          ...(referencePayload.length > 0 ? { references: referencePayload } : {}),
        }),
      });
      if (!metaRes.ok) {
        const body = (await metaRes.json().catch(() => null)) as { error?: string } | null;
        setPhase({
          status: 'error',
          message: body?.error ? `Could not host the metadata: ${body.error}.` : 'Could not host the metadata. Please try again.',
          connected: true,
        });
        return;
      }
      const { anchorUrl, anchorHash } = (await metaRes.json()) as { anchorUrl: string; anchorHash: string };

      // The wallet builds, signs (deposit + fee shown here), and submits.
      const { txHash } = await submitInfoAction({
        walletApi: api,
        network,
        origin: window.location.origin,
        rewardAddressHex,
        anchorUrl,
        anchorHashHex: anchorHash,
        govActionDepositLovelace: deposit.lovelace,
      });

      setPhase({ status: 'success', txHash, authored: signAsAuthor });
    } catch (err) {
      setPhase({ status: 'error', message: mapSubmitError(err), connected: true });
    }
  }

  function reset() {
    enabledApiRef.current = null;
    setPhase({ status: 'idle' });
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  // Mirrors submitInfoAction's own guard: this flow only ever works on
  // preprod, so fail visibly rather than let the user fill out the form and
  // hit the guard only after connecting a wallet.
  if (network !== 'preprod') {
    return (
      <div className="callout callout--info" role="status" style={{ maxWidth: '32rem' }}>
        <InfoIcon />
        <div className="callout__body">Submitting a governance action is available on preprod only.</div>
      </div>
    );
  }

  if (phase.status === 'success') {
    return (
      <div style={{ maxWidth: '32rem' }}>
        <div className="callout callout--success" role="status">
          <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <div className="callout__body">
            <p style={{ margin: '0 0 0.35rem', fontWeight: 600 }}>Proposal submitted</p>
            <p style={{ margin: '0 0 0.5rem', overflowWrap: 'anywhere' }}>
              Transaction:{' '}
              <a
                href={txExplorerUrl(network, phase.txHash)}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--accent)', wordBreak: 'break-all' }}
              >
                {phase.txHash}
              </a>
              <CopyButton value={phase.txHash} label="Copy transaction hash" />
            </p>
            {phase.authored && (
              <p style={{ margin: '0 0 0.5rem', color: 'var(--muted)', fontSize: '0.875rem' }}>Signed with wallet key.</p>
            )}
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
              The action appears in DRepTalk and on explorers only after the next gov-sync run, and after the
              metadata document propagates on the IPFS gateway.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '40rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <DepositInfo deposit={deposit} />

      {wallets.length === 0 ? (
        <div className="callout callout--info" role="status">
          <InfoIcon />
          <div className="callout__body">
            No Cardano wallet extension detected. Please install one (e.g. Lace, Eternl, Typhon).
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
          {/* Wallet picker: shown until the form phase is reached, or on a
              connect-step error (not yet connected). */}
          {(phase.status === 'idle' || phase.status === 'connecting' || (phase.status === 'error' && !phase.connected)) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
              <WalletConnection
                wallets={wallets}
                selected={selected}
                onSelect={setSelected}
                disabled={busy}
                label="Signing wallet"
              />
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handleConnect()}
                disabled={busy}
                style={{ alignSelf: 'flex-start' }}
              >
                {phase.status === 'connecting' ? 'Connecting...' : phase.status === 'error' ? 'Try again' : 'Connect wallet'}
              </button>
            </div>
          )}

          {/* Connect-step error (not connected): state the problem. */}
          {phase.status === 'error' && !phase.connected && (
            <div className="callout callout--error" role="alert">
              <ErrorIcon />
              <div className="callout__body">{phase.message}</div>
            </div>
          )}

          {/* Form: shown once connected. Stays mounted during submit and on a
              submit-time error so the inputs are never lost. */}
          {(phase.status === 'form' || phase.status === 'submitting' || (phase.status === 'error' && phase.connected)) && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleSubmit();
              }}
              style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}
            >
              <CountedField id="ia-title" label="Title" count={title.length} max={INFO_TITLE_MAX} help="Short, descriptive title for the proposal.">
                <input
                  id="ia-title"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={INFO_TITLE_MAX}
                  required
                  disabled={busy}
                  style={inputStyle}
                  placeholder="Proposal title"
                />
              </CountedField>

              <CountedField id="ia-abstract" label="Abstract" count={abstract.length} max={INFO_ABSTRACT_MAX} help="Brief summary of what this proposal is about.">
                <textarea
                  id="ia-abstract"
                  value={abstract}
                  onChange={(e) => setAbstract(e.target.value)}
                  maxLength={INFO_ABSTRACT_MAX}
                  rows={4}
                  required
                  disabled={busy}
                  style={textAreaStyle}
                  placeholder="What is this proposal about?"
                />
              </CountedField>

              <CountedField id="ia-motivation" label="Motivation" count={motivation.length} max={INFO_MOTIVATION_MAX} help="Why this proposal is needed.">
                <textarea
                  id="ia-motivation"
                  value={motivation}
                  onChange={(e) => setMotivation(e.target.value)}
                  maxLength={INFO_MOTIVATION_MAX}
                  rows={8}
                  required
                  disabled={busy}
                  style={textAreaStyle}
                  placeholder="Why is this proposal needed?"
                />
              </CountedField>

              <CountedField id="ia-rationale" label="Rationale" count={rationale.length} max={INFO_RATIONALE_MAX} help="Detailed reasoning behind the proposal.">
                <textarea
                  id="ia-rationale"
                  value={rationale}
                  onChange={(e) => setRationale(e.target.value)}
                  maxLength={INFO_RATIONALE_MAX}
                  rows={10}
                  required
                  disabled={busy}
                  style={textAreaStyle}
                  placeholder="Explain the reasoning in detail..."
                />
              </CountedField>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <span style={labelStyle}>References (optional)</span>
                <span style={helpStyle}>Link to supporting documents or discussions, like GovTool&apos;s reference links.</span>
                {references.map((ref, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional inputs owned by index; there is no stable id
                  <div key={i} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <input
                      type="text"
                      value={ref.label}
                      onChange={(e) => updateReference(i, { label: e.target.value })}
                      placeholder="Label (e.g. Forum discussion)"
                      maxLength={REFERENCE_LABEL_MAX}
                      disabled={busy}
                      style={{ ...inputStyle, flex: '0 0 12rem' }}
                      aria-label={`Reference ${i + 1} label`}
                    />
                    <input
                      type="url"
                      value={ref.uri}
                      onChange={(e) => updateReference(i, { uri: e.target.value })}
                      placeholder="https://..."
                      maxLength={REFERENCE_URI_MAX}
                      disabled={busy}
                      style={{ ...inputStyle, flex: 1, minWidth: 0 }}
                      aria-label={`Reference ${i + 1} URL`}
                    />
                    <button
                      type="button"
                      onClick={() => removeReference(i)}
                      disabled={busy}
                      aria-label={`Remove reference ${i + 1}`}
                      style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: busy ? 'not-allowed' : 'pointer', fontSize: '0.8125rem', padding: '0 0.25rem', flexShrink: 0, textDecoration: 'underline' }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                {references.length < REFERENCES_MAX && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                    <button
                      type="button"
                      onClick={addReference}
                      disabled={busy}
                      style={{ background: 'transparent', color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: '0.375rem', padding: '0.375rem 0.75rem', fontSize: '0.875rem', cursor: busy ? 'not-allowed' : 'pointer' }}
                    >
                      Add reference
                    </button>
                    <span style={{ fontSize: '0.8125rem', color: 'var(--muted)' }}>You can add up to {REFERENCES_MAX} references.</span>
                  </div>
                )}
              </div>

              <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: '0.875rem' }}>
                <input
                  type="checkbox"
                  checked={signAsAuthor}
                  onChange={(e) => setSignAsAuthor(e.target.checked)}
                  disabled={busy}
                  style={{ marginTop: '0.15rem' }}
                />
                <span>
                  Sign as author
                  <span style={{ display: 'block', color: 'var(--muted)', fontSize: '0.8125rem', marginTop: '0.15rem' }}>
                    Signs the metadata with your wallet&apos;s reward key. The document then shows &quot;Signed with wallet
                    key&quot;; the name below is self-declared, not independently verified.
                  </span>
                </span>
              </label>

              {signAsAuthor && (
                <CountedField id="ia-author-name" label="Author name" count={authorName.length} max={AUTHOR_NAME_MAX} help="Shown alongside the wallet-key signature.">
                  <input
                    id="ia-author-name"
                    type="text"
                    value={authorName}
                    onChange={(e) => setAuthorName(e.target.value)}
                    maxLength={AUTHOR_NAME_MAX}
                    disabled={busy}
                    style={inputStyle}
                    placeholder="Your name"
                  />
                </CountedField>
              )}

              {/* Submit-time error: keep the form so the user can retry. */}
              {phase.status === 'error' && phase.connected && (
                <div className="callout callout--error" role="alert">
                  <ErrorIcon />
                  <div className="callout__body">
                    {phase.message}{' '}
                    <button
                      type="button"
                      onClick={reset}
                      style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, font: 'inherit', textDecoration: 'underline' }}
                    >
                      Use a different wallet
                    </button>
                  </div>
                </div>
              )}

              <div>
                <button type="submit" className="btn btn-primary" disabled={busy || deposit.status !== 'ready'}>
                  {phase.status === 'submitting' ? 'Awaiting wallet...' : 'Submit proposal'}
                </button>
              </div>

              {phase.status === 'submitting' && (
                <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
                  Please review and approve the transaction in your wallet.
                </p>
              )}
            </form>
          )}
        </div>
      )}
    </div>
  );
}
