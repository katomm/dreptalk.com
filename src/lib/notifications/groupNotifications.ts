// Payload parsing and copy for the two DRep group notification types
// (group_join_request, group_signature_request). Pure, no I/O, shared by the
// inbox page and the push lead so both say the same thing.

export type GroupNotificationType = 'group_join_request' | 'group_signature_request';

export interface GroupNotificationPayload {
  groupId: string;
  groupName: string | null;
  memberName?: string;
  /** The group action row id, the sign page path segment. */
  actionId?: string;
  summary?: string;
}

/** Parses a group notification payload, null for anything malformed. */
export function parseGroupNotificationPayload(raw: string | null): GroupNotificationPayload | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v.groupId !== 'string' || v.groupId === '') return null;
    const str = (x: unknown) => (typeof x === 'string' && x !== '' ? x : undefined);
    return {
      groupId: v.groupId,
      groupName: str(v.groupName) ?? null,
      memberName: str(v.memberName),
      actionId: str(v.actionId),
      summary: str(v.summary),
    };
  } catch {
    return null;
  }
}

/** The one-line sentence for a group notification, null when the payload cannot support its type. */
export function formatGroupNotificationTitle(type: GroupNotificationType, p: GroupNotificationPayload): string | null {
  const who = p.memberName ?? 'Someone';
  if (type === 'group_join_request') return `${who} asked to join ${p.groupName ?? 'your group'}`;
  if (!p.actionId) return null;
  return p.summary ? `${who} asked you to sign: ${p.summary}` : `${who} asked you to sign an action`;
}

/** The in-app path a group notification opens, null when the payload cannot support its type. */
export function groupNotificationHref(type: GroupNotificationType, p: GroupNotificationPayload): string | null {
  if (type === 'group_join_request') return `/groups/${encodeURIComponent(p.groupId)}/#requests`;
  return p.actionId ? `/groups/sign/${encodeURIComponent(p.actionId)}/` : null;
}
