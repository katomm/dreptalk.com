// Icon row for a profile's recognized platform links (see socialLinks.ts).
// Monochrome brand glyphs (Simple Icons path data via socialIcons.ts), one
// small round button per link, the link's own label as the accessible name.
// A React component so the public profile page (which server-renders it, no
// hydration) and the settings live preview share one implementation. Styles
// live in global.css (.slinks) for the same reason.
import type { SocialLink } from '@/lib/dreps/socialLinks.js';
import { SOCIAL_ICON_PATHS } from '@/lib/dreps/socialIcons.js';

export default function SocialLinkIcons({ links }: { links: SocialLink[] }) {
  if (links.length === 0) return null;
  return (
    <ul className="slinks">
      {links.map((l) => (
        <li key={l.kind}>
          {/* biome-ignore lint/a11y/useAnchorContent: the aria-label carries the accessible name; the svg glyph is decorative */}
          <a
            className="slinks__btn"
            href={l.uri}
            rel="nofollow noopener"
            target="_blank"
            aria-label={l.label}
            title={l.label}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
              <path d={SOCIAL_ICON_PATHS[l.kind]} />
            </svg>
          </a>
        </li>
      ))}
    </ul>
  );
}
