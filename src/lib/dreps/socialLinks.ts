// Detect well-known platforms among a DRep's CIP-119 reference links so the
// profile can lift them into an icon row in the header. Matching is on the
// parsed hostname (exact or subdomain), never substring, so a path segment or
// a look-alike host cannot spoof a platform.

export type SocialKind =
  | 'x'
  | 'bluesky'
  | 'linkedin'
  | 'facebook'
  | 'github'
  | 'discord'
  | 'telegram'
  | 'youtube'
  | 'instagram';

const PLATFORM_DOMAINS: [SocialKind, string[]][] = [
  ['x', ['x.com', 'twitter.com']],
  ['bluesky', ['bsky.app', 'bsky.social']],
  ['linkedin', ['linkedin.com']],
  ['facebook', ['facebook.com', 'fb.com']],
  ['github', ['github.com']],
  ['discord', ['discord.gg', 'discord.com']],
  ['telegram', ['t.me', 'telegram.me']],
  ['youtube', ['youtube.com', 'youtu.be']],
  ['instagram', ['instagram.com']],
];

/** Human platform names, used for accessible labels when a link has none. */
export const SOCIAL_NAMES: Record<SocialKind, string> = {
  x: 'X',
  bluesky: 'Bluesky',
  linkedin: 'LinkedIn',
  facebook: 'Facebook',
  github: 'GitHub',
  discord: 'Discord',
  telegram: 'Telegram',
  youtube: 'YouTube',
  instagram: 'Instagram',
};

/** The platform a link points at, or null for anything unrecognized. */
export function classifySocialLink(uri: string): SocialKind | null {
  let host: string;
  try {
    const url = new URL(uri);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    host = url.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
  for (const [kind, domains] of PLATFORM_DOMAINS) {
    for (const domain of domains) {
      if (host === domain || host.endsWith(`.${domain}`)) return kind;
    }
  }
  return null;
}

export interface SocialLink {
  kind: SocialKind;
  uri: string;
  /** Accessible label: the link's own label when set, else the platform name. */
  label: string;
}

/**
 * Splits a deduped link list into recognized platform links (for the header
 * icon row, input order preserved) and the rest (still rendered as text links
 * in the About section). At most one icon per platform: extra links to the
 * same platform (e.g. a second X link pointing at a specific tweet) fall back
 * into the About list so the header stays a single unambiguous glyph per site.
 * The platforms that lost links this way come back as `overflowKinds` (unique,
 * input order), so callers like the settings preview can explain the demotion.
 */
export function splitSocialLinks(links: { label: string; uri: string }[]): {
  social: SocialLink[];
  rest: { label: string; uri: string }[];
  overflowKinds: SocialKind[];
} {
  const social: SocialLink[] = [];
  const rest: { label: string; uri: string }[] = [];
  const seenKinds = new Set<SocialKind>();
  const overflow = new Set<SocialKind>();
  for (const link of links) {
    const kind = classifySocialLink(link.uri);
    if (kind && !seenKinds.has(kind)) {
      seenKinds.add(kind);
      const label = link.label.trim().length > 0 ? link.label : SOCIAL_NAMES[kind];
      social.push({ kind, uri: link.uri, label });
    } else {
      if (kind) overflow.add(kind);
      rest.push(link);
    }
  }
  return { social, rest, overflowKinds: [...overflow] };
}
