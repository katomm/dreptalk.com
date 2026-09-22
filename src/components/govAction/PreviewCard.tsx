// The body of the review modal: the action as the action page will render it.
//
// Two halves with two different trust stories. The Markdown fields come back
// from /api/preview as HTML the server's own sanitizing renderer produced, and
// are injected with dangerouslySetInnerHTML exactly as the forum's editor
// preview does. Everything else (the title, the author line, the reference
// labels, every value in the on-chain changes card) is a React text node, so
// markup typed into those fields renders as the characters it is. A reference
// only becomes a link when resolveAnchorUrl accepts its scheme, which is the
// same allowlist the action page's ReferencesCard links through.
//
// The on-chain card mirrors GaOnchainChanges.astro's structure, class names
// and labels rather than sharing it: an Astro component cannot render inside a
// React island, and the Astro component's styles are scoped to it, so the look
// is reproduced with inline styles here. That is the same trade-off the forum
// preview makes. The content is NOT mirrored: it comes from the one shared
// decoder, so the two cards cannot disagree about what a payload means.
import type { CSSProperties, ReactNode } from 'react';
import { CopyButton } from '@/components/CopyButton.js';
import { resolveAnchorUrl } from '@/lib/governance/anchorUrl.js';
import type { CommitteeMemberChange, OnchainChanges } from '@/lib/governance/onchain.js';

export interface PreviewCardProps {
  title: string;
  /** Server-rendered HTML per metadata field, keyed as the request sent them. */
  html: { abstract?: string; motivation?: string; rationale?: string };
  /** The raw Markdown of the two body fields, for the extractor's identical-text dedupe. */
  motivationMd: string;
  rationaleMd: string;
  authorLine: string;
  missing: string[];
  references: readonly { label: string; uri: string }[];
  onchain: OnchainChanges | null;
  /** Cold-key hex to display name, from the chain context the form is showing. */
  committeeNames?: Map<string, string>;
}

const labelStyle: CSSProperties = {
  fontSize: '0.8125rem',
  fontWeight: 600,
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  margin: '0 0 0.4rem',
};

const cardStyle: CSSProperties = {
  margin: '0 0 1.25rem',
  border: '1px solid var(--border)',
  borderRadius: '0.5rem',
  padding: '1rem 1.125rem',
  background: 'var(--surface)',
};

const rowsStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.4rem',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  gap: '0.5rem',
  fontSize: '0.875rem',
};

const nameStyle: CSSProperties = { fontWeight: 600, color: 'var(--fg)' };
const valStyle: CSSProperties = { marginLeft: 'auto', display: 'inline-flex', alignItems: 'baseline', gap: '0.4rem' };
const newStyle: CSSProperties = { color: 'var(--fg)', fontWeight: 600 };
const oldStyle: CSSProperties = { color: 'var(--muted)', textDecoration: 'line-through' };
const mutedStyle: CSSProperties = { color: 'var(--muted)' };
const monoStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '0.78rem',
  wordBreak: 'break-all',
  overflowWrap: 'anywhere',
};
const groupStyle: CSSProperties = {
  fontSize: '0.72rem',
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
};

/** One "Added"/"Removed" committee row, with the member's name when the context knows it. */
function MemberRow({
  member,
  label,
  names,
}: {
  member: CommitteeMemberChange;
  label: string;
  names?: Map<string, string>;
}) {
  const name = member.coldKeyHex ? names?.get(member.coldKeyHex) : undefined;
  return (
    <li className="ocx__row" style={rowStyle}>
      <span className="ocx__name" style={nameStyle}>{label}</span>
      <span className="ocx__val" style={valStyle}>
        {name ? (
          <span className="ocx__member" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
            <span className="ocx__membername" style={nameStyle}>{name}</span>
            <span className="mono ocx__memberkey" style={{ ...monoStyle, color: 'var(--muted)', fontSize: '0.72rem' }}>
              {member.label}
            </span>
            <CopyButton value={member.coldKeyHex} label="Copy committee member id" />
          </span>
        ) : (
          <span className="mono" style={monoStyle}>
            {member.label}
            <CopyButton value={member.coldKeyHex || member.label} label="Copy committee member id" />
          </span>
        )}
        {member.termEpoch !== null && (
          <span className="ocx__group" style={groupStyle}> term to epoch {member.termEpoch}</span>
        )}
      </span>
    </li>
  );
}

/** The on-chain changes card, mirroring GaOnchainChanges.astro for the types this form can submit. */
function OnchainChangesCard({ changes, names }: { changes: OnchainChanges; names?: Map<string, string> }) {
  let body: ReactNode = null;

  if (changes.kind === 'hardfork') {
    body = (
      <p className="ocx__single" style={{ fontSize: '0.9375rem', margin: '0.4rem 0 0' }}>
        Protocol Version{' '}
        {changes.fromVersion && (
          <>
            <span className="ocx__old" style={oldStyle}>{changes.fromVersion}</span>{' '}
            <span className="ocx__arrow" style={mutedStyle}>&rarr;</span>{' '}
          </>
        )}
        {/* The version is the one field this panel has, so an unchosen one says
            so here rather than leaving the sentence hanging. */}
        {changes.toVersion ? (
          <span className="ocx__new" style={newStyle}>{changes.toVersion}</span>
        ) : (
          <span style={mutedStyle}>not chosen yet</span>
        )}
      </p>
    );
  } else if (
    changes.kind === 'committee' &&
    // Same gate as GaOnchainChanges.astro: a diff that adds nobody, removes
    // nobody and leaves the threshold alone is an empty card, not a card
    // saying nothing changed.
    (changes.added.length > 0 || changes.removed.length > 0 || changes.threshold !== null)
  ) {
    body = (
      <ul className="ocx__rows" style={rowsStyle}>
        {changes.threshold !== null && (
          <li className="ocx__row" style={rowStyle}>
            <span className="ocx__name" style={nameStyle}>New threshold</span>
            <span className="ocx__val" style={valStyle}>
              <span className="ocx__new" style={newStyle}>{changes.threshold}</span>
            </span>
          </li>
        )}
        {changes.added.map((m) => (
          <MemberRow key={`add-${m.coldKeyHex || m.label}`} member={m} label="Added" names={names} />
        ))}
        {changes.removed.map((m) => (
          <MemberRow key={`remove-${m.coldKeyHex || m.label}`} member={m} label="Removed" names={names} />
        ))}
      </ul>
    );
  } else if (changes.kind === 'constitution') {
    // The anchor URL is a placeholder until the document is published, so
    // resolveAnchorUrl refuses it and it renders as text, not as a dead link.
    const href = changes.anchorUrl ? resolveAnchorUrl(changes.anchorUrl) : null;
    body = (
      <ul className="ocx__rows" style={rowsStyle}>
        {changes.anchorUrl && (
          <li className="ocx__row" style={rowStyle}>
            <span className="ocx__name" style={nameStyle}>New constitution</span>
            <span className="ocx__val" style={valStyle}>
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer">{changes.anchorUrl}</a>
              ) : (
                <span className="mono" style={monoStyle}>{changes.anchorUrl}</span>
              )}
            </span>
          </li>
        )}
        {changes.dataHash && (
          <li className="ocx__row" style={rowStyle}>
            <span className="ocx__name" style={nameStyle}>Document hash</span>
            <span className="ocx__val mono" style={{ ...valStyle, ...monoStyle }}>
              {changes.dataHash}
              <CopyButton value={changes.dataHash} label="Copy document hash" />
            </span>
          </li>
        )}
        {changes.scriptHash && (
          <li className="ocx__row" style={rowStyle}>
            <span className="ocx__name" style={nameStyle}>Guardrails script</span>
            <span className="ocx__val mono" style={{ ...valStyle, ...monoStyle }}>
              {changes.scriptHash}
              <CopyButton value={changes.scriptHash} label="Copy script hash" />
            </span>
          </li>
        )}
      </ul>
    );
  } else if (changes.kind === 'note') {
    body = (
      <p className="ocx__note" style={{ fontSize: '0.9375rem', margin: '0.4rem 0 0', color: 'var(--muted)' }}>
        {changes.text}
      </p>
    );
  }

  // Nothing to show: an empty committee diff, or (unreachable from this form,
  // which offers neither ParameterChange nor TreasuryWithdrawals, see
  // govActionParts.ts) a params or treasury payload.
  if (body === null) return null;

  return (
    <section className="ocx" style={cardStyle}>
      <p className="ocx__label" style={{ ...labelStyle, margin: '0 0 0.6rem' }}>On-chain changes</p>
      {body}
    </section>
  );
}

/** One Markdown field as the server rendered it, injected the way the forum preview injects its own. */
function RenderedField({ html, className }: { html: string; className: string }) {
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: html is server-sanitized markdown (renderMarkdown in src/lib/markdown.ts, via /api/preview)
    <div dangerouslySetInnerHTML={{ __html: html }} className={className} style={{ fontSize: '0.9375rem' }} />
  );
}

export default function PreviewCard(props: PreviewCardProps) {
  const { html, references, onchain } = props;
  // The sync's extractor merges motivation and rationale and drops one of them
  // when both hold the identical text, so the preview does the same: otherwise
  // the modal shows a paragraph twice that the action page will show once.
  const sameBody = props.motivationMd.trim() !== '' && props.motivationMd.trim() === props.rationaleMd.trim();
  const bodyHtml = sameBody ? [html.rationale] : [html.motivation, html.rationale];
  const bodyParts = bodyHtml.filter((part): part is string => Boolean(part));

  const links = references.flatMap((r) => {
    const href = resolveAnchorUrl(r.uri);
    return href ? [{ href, host: new URL(href).host, label: r.label || r.uri }] : [];
  });

  return (
    <div>
      <p
        style={{
          margin: '0 0 0.875rem',
          fontSize: '0.8125rem',
          color: 'var(--muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          fontWeight: 600,
        }}
      >
        Preview, nothing is published yet
      </p>

      {props.missing.length > 0 && (
        <div className="callout callout--info" role="status" style={{ marginBottom: '1rem' }}>
          <div className="callout__body">
            <p style={{ margin: '0 0 0.35rem', fontWeight: 600 }}>Still missing</p>
            <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.875rem' }}>
              {props.missing.map((field) => (
                <li key={field}>{field}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* A text node on purpose: a title is plain text on the action page too,
          so markup typed into the field shows as the characters it is. */}
      <h3 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem', lineHeight: 1.3, overflowWrap: 'anywhere' }}>
        {props.title || <span style={mutedStyle}>Untitled</span>}
      </h3>

      <p style={{ margin: '0 0 1.125rem', fontSize: '0.875rem', color: 'var(--muted)' }}>{props.authorLine}</p>

      {onchain && <OnchainChangesCard changes={onchain} names={props.committeeNames} />}

      {html.abstract && (
        <div className="ga-abstract" style={{ marginTop: '0.875rem' }}>
          <p className="ga-abstract__label" style={labelStyle}>Abstract</p>
          <RenderedField html={html.abstract} className="prose ga-abstract__body" />
        </div>
      )}

      {bodyParts.length > 0 && (
        <div className="ga-rationale" style={{ marginTop: '1.125rem' }}>
          <p className="ga-rationale__label" style={labelStyle}>Motivation &amp; rationale</p>
          {/* Plain "prose", not ga-rationale__body: that class is the action
              page's collapsed state, and the preview never collapses. */}
          {bodyParts.map((part, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the two parts are positional (motivation then rationale), there is no id
            <RenderedField key={i} html={part} className="prose" />
          ))}
        </div>
      )}

      {links.length > 0 && (
        <div style={{ marginTop: '1.125rem' }}>
          <p className="sidebar-card__title" style={labelStyle}>References</p>
          <ul className="refs" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
            {links.map((l) => (
              <li key={l.href} className="refs__item" style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem', minWidth: 0 }}>
                <a
                  className="refs__link"
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  style={{ fontSize: '0.9rem', color: 'var(--accent)', overflowWrap: 'anywhere' }}
                >
                  {l.label}
                </a>
                <span className="refs__host" style={{ fontSize: '0.72rem', color: 'var(--muted)', overflowWrap: 'anywhere' }}>
                  {l.host}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
