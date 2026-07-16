// Live preview of how a DRep profile will look once saved. Mirrors the public
// profile page (src/pages/dreps/[drepId].astro): avatar, name, bio, named
// links (host fallback for an empty label), motivations, qualifications, and
// payment address. doNotList is not shown, matching the public page. Driven by
// the in-progress form value so it updates as the DRep edits.
import type { CSSProperties } from 'react';
import { CopyButton } from '@/components/CopyButton.js';
import type { DrepProfileValue } from '@/components/DrepProfileFields.js';
import { linkDisplayLabel } from '@/lib/dreps/linkLabel.js';
import { identiconDataUri } from '@/lib/identity/identicon.js';

interface DrepProfilePreviewProps {
  value: DrepProfileValue;
  /** Identicon seed: the DRep id, matching the public profile fallback. */
  seed: string;
}

const AVATAR_SIZE = 64;

/**
 * Only http(s) links become clickable in the preview. The server drops anything
 * else before storing, so this just keeps a javascript:/data: URL the editor is
 * still holding from rendering as a live href (self-XSS hardening).
 */
function isHttpHref(uri: string): boolean {
  try {
    const { protocol } = new URL(uri);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

const cardStyle: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius, 14px)',
  background: 'var(--surface)',
  padding: '1.25rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
};

const sectionTitle: CSSProperties = {
  margin: '0 0 0.2rem',
  fontSize: '0.9375rem',
  fontWeight: 600,
};

const bodyText: CSSProperties = {
  margin: 0,
  fontSize: '0.9375rem',
  lineHeight: 1.6,
  color: 'var(--fg)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
};

export default function DrepProfilePreview({ value, seed }: DrepProfilePreviewProps) {
  const links = value.links.filter((l) => l.uri.trim());
  const avatarSrc = value.image?.url
    ? value.image.url
    : identiconDataUri(seed, AVATAR_SIZE);

  return (
    <div>
      <p style={{ margin: '0 0 0.5rem', fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted)' }}>
        Preview
      </p>
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <img
            src={avatarSrc}
            alt=""
            width={AVATAR_SIZE}
            height={AVATAR_SIZE}
            style={{ width: AVATAR_SIZE, height: AVATAR_SIZE, borderRadius: '50%', objectFit: 'cover', border: '1px solid var(--border)', flexShrink: 0 }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', minWidth: 0 }}>
            <span style={{ fontSize: '1.125rem', fontWeight: 700, color: value.name.trim() ? 'var(--fg)' : 'var(--muted)', overflowWrap: 'anywhere' }}>
              {value.name.trim() || 'Your DRep name'}
            </span>
            <span style={{ alignSelf: 'flex-start', fontSize: '0.6875rem', fontWeight: 600, color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 12%, transparent)', borderRadius: '999px', padding: '0.05rem 0.5rem' }}>
              DRep
            </span>
          </div>
        </div>

        {value.bio.trim() && <p style={bodyText}>{value.bio}</p>}

        {links.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            {links.map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: preview rows have no stable id; order is the identity
              <li key={i} style={{ fontSize: '0.9375rem' }}>
                {isHttpHref(l.uri.trim()) ? (
                  <a href={l.uri.trim()} rel="nofollow noopener" target="_blank" style={{ color: 'var(--accent)' }}>
                    {linkDisplayLabel(l)}
                  </a>
                ) : (
                  <span style={{ color: 'var(--muted)' }}>{linkDisplayLabel(l)}</span>
                )}
              </li>
            ))}
          </ul>
        )}

        {value.motivations.trim() && (
          <div>
            <h3 style={sectionTitle}>Motivations</h3>
            <p style={bodyText}>{value.motivations}</p>
          </div>
        )}

        {value.qualifications.trim() && (
          <div>
            <h3 style={sectionTitle}>Qualifications</h3>
            <p style={bodyText}>{value.qualifications}</p>
          </div>
        )}

        {value.paymentAddress.trim() && (
          <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--muted)' }}>
            Payment address:{' '}
            <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' }}>
              {value.paymentAddress.trim()}
            </span>
            <CopyButton value={value.paymentAddress.trim()} label="Copy payment address" />
          </p>
        )}
      </div>

      <div
        style={{
          marginTop: '0.75rem',
          border: '1px solid var(--border)',
          background: 'color-mix(in srgb, var(--accent) 5%, var(--surface))',
          borderRadius: 'var(--radius, 14px)',
          padding: '0.875rem 1rem',
        }}
      >
        <p style={{ margin: '0 0 0.25rem', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--accent)' }}>
          These details are stored on-chain
        </p>
        <p style={{ margin: '0 0 0.5rem', fontSize: '0.8125rem', lineHeight: 1.5, color: 'var(--muted)' }}>
          They are public and can be viewed on explorers and by anyone in the Cardano ecosystem.
        </p>
        <a href="/help/managing-your-drep/" style={{ fontSize: '0.8125rem', color: 'var(--accent)' }}>
          Learn more about CIP-119
        </a>
      </div>
    </div>
  );
}
