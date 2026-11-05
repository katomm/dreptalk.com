// Pure view helpers for the DRep group pages. A group reads as an affiliation of DReps who each
// vote on their own. Stored display JSON is depth limited when it is written, so the recursion
// over a script stays bounded.
import type { StatusNote } from '../db/drepGroups.js';
import { truncateIdMiddle } from '../forum/view.js';
import { LISTED_MIN_MEMBERS } from './constants.js';

export type ScriptView =
  | { kind: 'sig'; keyHash: string }
  | { kind: 'all' | 'any'; children: ScriptView[] }
  | { kind: 'nOfK'; n: string; children: ScriptView[] }
  | { kind: 'after' | 'before'; slot: string }
  | { kind: 'tooDeep' };

function fromRaw(x: unknown): ScriptView | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const children = (): ScriptView[] | null => {
    if (!Array.isArray(o.scripts)) return null;
    const c = o.scripts.map(fromRaw);
    return c.every((v): v is ScriptView => v !== null) ? c : null;
  };
  switch (o.type) {
    case 'sig':
      return typeof o.keyHash === 'string' ? { kind: 'sig', keyHash: o.keyHash } : null;
    case 'all':
    case 'any': {
      const c = children();
      return c ? { kind: o.type, children: c } : null;
    }
    case 'nOfK': {
      const c = children();
      return c ? { kind: 'nOfK', n: String(o.n), children: c } : null;
    }
    case 'after':
    case 'before':
      return { kind: o.type, slot: String(o.slot) };
    case 'tooDeep':
      return { kind: 'tooDeep' };
    default:
      return null;
  }
}

export function scriptFromJson(json: string | undefined): ScriptView | null {
  if (!json) return null;
  try {
    return fromRaw(JSON.parse(json));
  } catch {
    return null;
  }
}

export function policyKeyHashes(s: ScriptView | null): string[] {
  if (!s) return [];
  if (s.kind === 'sig') return [s.keyHash];
  return 'children' in s ? s.children.flatMap(policyKeyHashes) : [];
}

/** The first 8 and last 4 characters of a long hash or id. */
export const shortHash = (h: string): string => truncateIdMiddle(h, 8, 4);

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** A member count in words for copy: "one member", "two members", "12 members". */
export function memberCountWords(n: number): string {
  return `${NUMBER_WORDS[n] ?? String(n)} ${n === 1 ? 'member' : 'members'}`;
}

/** A member count in figures for a list row: "1 member", "3 members". */
export const memberCount = (n: number): string => `${n} ${n === 1 ? 'member' : 'members'}`;

/** The listing threshold in words, from LISTED_MIN_MEMBERS: "at least one member". */
export const LISTED_RULE = `at least ${memberCountWords(LISTED_MIN_MEMBERS)}`;

/** A policy in words, keys by DRep name where known. Keys in `admins` are marked as group admins. */
export function describePolicy(s: ScriptView | null, names: Map<string, string>, admins?: ReadonlySet<string>): string {
  if (!s) return 'Unknown policy';
  const name = (k: string) => `${names.get(k) ?? shortHash(k)}${admins?.has(k) ? ' (group admin)' : ''}`;
  const part = (x: ScriptView): string => {
    switch (x.kind) {
      case 'sig':
        return name(x.keyHash);
      case 'after':
        return `valid from slot ${x.slot}`;
      case 'before':
        return `valid until slot ${x.slot}`;
      case 'all':
        return `all of: ${x.children.map(part).join(', ')}`;
      case 'any':
        return `any of: ${x.children.map(part).join(', ')}`;
      case 'nOfK':
        return `${x.n} of ${x.children.length}: ${x.children.map(part).join(', ')}`;
      case 'tooDeep':
        return 'Policy too deeply nested to display';
    }
  };
  return part(s);
}

export function modeLabel(mode: string): string {
  return mode === 'permissioned' ? 'Permissioned, confirmed by the group' : 'Open, self-declared';
}

export function reasonLabel(reason: string | null): string {
  switch (reason) {
    case 'left':
      return 'Left';
    case 'removed':
      return 'Removed';
    case 'retired':
      return 'DRep retired';
    case 'dissolved':
      return 'Group dissolved';
    default:
      return '';
  }
}

export function eventLabel(tag: string | null): string {
  switch (tag) {
    case 'create':
      return 'Group created';
    case 'update':
      return 'Policies or profile updated';
    case 'dissolve':
      return 'Group dissolved';
    case 'join':
      return 'Joined';
    case 'approve':
      return 'Membership approved';
    case 'leave':
      return 'Left';
    case 'remove':
      return 'Removed';
    default:
      return 'Unreadable event';
  }
}

/** A group action of the signing table in a word, for the lists of actions in progress. */
export const ACTION_KIND_LABEL: Readonly<Record<string, string>> = {
  group_create: 'Founding',
  group_join: 'Join',
  group_leave: 'Leave',
  group_approve: 'Approval',
  group_remove: 'Removal',
  group_update: 'Policy update',
  group_dissolve: 'Dissolution',
};

/** Where an unresolved group action stands. A submitted one is confirming until the chain confirms it. */
export const ACTION_STATUS_LABEL: Readonly<Record<string, string>> = {
  collecting: 'collecting signatures',
  submitted: 'confirming',
  cancelled: 'cancelled, held until it expires',
};

/** The words of an action whose fee input another transaction spent, its own can never be valid. */
export const INPUT_SPENT_TEXT = 'This transaction can no longer be submitted, a coin it spends was used by another transaction.';
export const INPUT_SPENT_STATUS = 'can no longer be submitted';
/** Why a new action cannot be paid when open actions hold every coin of the wallet. */
export const FUNDS_HELD =
  "Your wallet's funds are held by another open action. Wait until it is confirmed, cancel it, or add another coin to this wallet.";

export function addressStatusLabel(status: 'invalid' | 'declared' | 'script-controlled'): string {
  return status === 'script-controlled' ? 'Controlled by' : status === 'declared' ? 'Declared address' : 'Invalid address';
}

/** The note shown above the members while stored group data is being corrected or rebuilt. */
export function statusNoteLabel(note: StatusNote): string | null {
  switch (note) {
    case 'correcting':
      return 'Group data is being corrected after a chain reorganization. Some entries may be out of date for a few minutes.';
    case 'rebuilding':
      return 'Group data is being rebuilt. Lists fill up again over the next runs.';
    default:
      return null;
  }
}

type MemberSectionKind = 'all' | 'active' | 'pending' | 'former';

/** The URL parameter that carries the cursor of a member section. */
export const sectionParam = (kind: MemberSectionKind): string => (kind === 'all' ? 'members' : kind);

/**
 * The member lists of a group page with their cursors. A closing group shows one list of all its
 * memberships, any other group one list per kind, each paged on its own.
 */
export function memberSections(
  group: { closing: boolean },
  params: URLSearchParams,
): Array<{ kind: MemberSectionKind; after: string | null }> {
  const kinds: MemberSectionKind[] = group.closing ? ['all'] : ['active', 'pending', 'former'];
  return kinds.map((kind) => ({ kind, after: params.get(sectionParam(kind)) }));
}

const HOSTED_AVATAR = /\/api\/avatar\/([0-9a-f]{64})(?:\/thumb)?\/?$/;

/**
 * The content hash of a group image that DRepTalk hosts, read off a profile image URL ending in
 * /api/avatar/<hash>. The page then loads it from its own origin. Any other image is left out, the
 * page's CSP loads images from its own origin only, so the identicon shows instead.
 */
export function hostedAvatarHash(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return HOSTED_AVATAR.exec(u.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}
