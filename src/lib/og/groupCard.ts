// Open Graph card model for one DRep group at /groups/:id/. Same layout as the DRep card: name,
// short id and an excerpt of the description beside the group image, then the stat row. Shared by
// the /og/group/:id.png route (renders it) and the group page (versions its og:image URL).
import { clipExcerpt, truncateIdMiddle } from '../forum/view.js';
import { formatAdaCompact } from '../format/ada.js';
import type { DrepCardModel } from './model.js';
import { BRAND_ACCENT } from './theme.js';
import { ogCardVersion } from './version.js';

export interface GroupCardInput {
  groupId: string;
  name: string | null;
  description: string | null;
  mode: 'open' | 'permissioned';
  status: 'active' | 'dissolved';
  members: number;
  memberPower: string;
  closing: boolean;
  imageHash: string | null;
}

/** Everything the card shows, so the URL changes whenever the card would. */
export function groupCardVersion(g: GroupCardInput): string {
  return ogCardVersion([g.name ?? '', g.description ?? '', g.mode, g.status, g.members, g.memberPower, g.closing ? 1 : 0, g.imageHash ?? '']);
}

export function groupCardModel(g: GroupCardInput, opts: { avatarDataUrl: string }): DrepCardModel {
  const idShort = truncateIdMiddle(g.groupId);
  const name = g.name?.trim();
  const members = g.closing ? 'Closing' : String(g.members);
  return {
    accent: BRAND_ACCENT,
    name: name ? clipExcerpt(name, 40) : idShort,
    idShort: name ? idShort : null,
    // One line of the description, its paragraphs joined, as the page meta description does.
    bio: g.description ? clipExcerpt(g.description.replace(/\s+/g, ' ').trim(), 120) : null,
    avatarDataUrl: opts.avatarDataUrl,
    stats: [
      { value: formatAdaCompact(g.memberPower) ?? '0 ₳', label: 'voting power of members', icon: 'power' },
      { value: members, label: g.members === 1 ? 'member' : 'members', icon: 'members' },
      {
        value: g.status === 'dissolved' ? 'Dissolved' : g.mode === 'open' ? 'Open' : 'Permissioned',
        label: g.status === 'dissolved' ? '' : g.mode === 'open' ? 'anyone can join' : 'admins approve',
        icon: 'mode',
      },
    ],
  };
}
