// URL of a stored avatar for a given on-screen size. Stored avatars go up to
// 256px (enough for the 96px profile hero on 2x screens), which is several
// times what a list row shows. Up to AVATAR_THUMB_EDGE / 2 on screen, the small
// rendition from /api/avatar/<hash>/thumb covers 2x screens at a fraction of
// the bytes.

/** Edge length in px of the small avatar rendition. */
export const AVATAR_THUMB_EDGE = 96;

/** Avatar URL for a stored content hash shown at `displaySize` CSS px. */
export function avatarUrl(hash: string, displaySize: number): string {
  return displaySize * 2 <= AVATAR_THUMB_EDGE ? `/api/avatar/${hash}/thumb` : `/api/avatar/${hash}`;
}
