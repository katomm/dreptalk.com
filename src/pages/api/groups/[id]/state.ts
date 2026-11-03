// GET /api/groups/[id]/state
// What the action island of a group page shows to the current session: the policies, members and
// requests the actions are built from, the unresolved actions of the group and of the viewer, and
// the viewer's own membership. The page itself stays cacheable, this route is never cached.
import type { APIRoute } from 'astro';
import { currentNetwork, jsonResponse, runtimeEnv } from '@/lib/api/response';
import { type GroupActionRow, getGroup, groupActionState } from '@/lib/db/drepGroups';
import { sessionOf } from '@/lib/groups/actionServer';
import { drepGroupsAvailable } from '@/lib/groups/gate';

export const prerender = false;

const NO_STORE = { 'cache-control': 'no-store' };

export const GET: APIRoute = async ({ params, locals }) => {
  if (!drepGroupsAvailable(currentNetwork().network)) return jsonResponse({ error: 'not found' }, 404, NO_STORE);
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) return jsonResponse({ error: 'service unavailable' }, 503, NO_STORE);
  const group = await getGroup(db, (params.id ?? '').toLowerCase());
  if (!group) return jsonResponse({ error: group === undefined ? 'service unavailable' : 'not found' }, group === undefined ? 503 : 404, NO_STORE);

  const user = (locals as App.Locals).user;
  const session = user ? sessionOf(user) : { keyHash: null, drepId: null };
  const viewer = session.keyHash || session.drepId ? session : null;
  const s = await groupActionState(db, group, viewer ?? { keyHash: null, drepId: null });

  // A signing link is handed out to its initiator, to the keys it lists and to the member it is about.
  const key = viewer?.keyHash?.toLowerCase() ?? null;
  const policyKeys = new Set([...s.control.keys, ...(s.admission?.keys ?? [])]);
  const linkFor = (r: GroupActionRow): string | null =>
    user && (r.createdBy === user.id || (key !== null && r.requiredSigners.includes(key)) || r.subjectKind === 'member') ? r.id : null;
  const rows = [...s.rows, ...s.viewerRows].map((r) => ({ id: linkFor(r), kind: r.kind, status: r.status }));

  return jsonResponse(
    {
      groupId: group.groupId,
      mode: group.mode,
      status: group.closing ? 'dissolved' : group.status,
      seq: group.seq,
      control: s.control,
      admission: s.admission,
      names: Object.fromEntries(s.names),
      activeKeyMembers: s.activeKeyMembers,
      pending: s.pending,
      // Admins see the open control action they would compete with.
      openControl: s.openControl ? { id: key !== null && policyKeys.has(key) ? s.openControl.id : linkFor(s.openControl) } : null,
      rows,
      viewer: viewer ? { keyHash: key, drepId: viewer.drepId, join: s.viewerJoin } : null,
    },
    200,
    NO_STORE,
  );
};
