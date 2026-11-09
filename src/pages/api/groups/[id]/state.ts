// GET /api/groups/[id]/state
// What the action island of a group page shows to the current session: the policies, members and
// requests the actions are built from, the unresolved actions of the group and of the viewer, and
// the viewer's own membership. The page itself stays cacheable, this route is never cached.
import type { APIRoute } from 'astro';
import type { Credential } from 'drep-groups';
import { currentNetwork, jsonResponse, runtimeEnv } from '@/lib/api/response';
import { type GroupActionRow, getGroup, groupActionState } from '@/lib/db/drepGroups';
import { sessionOf } from '@/lib/groups/actionServer';
import { changesOfIntent, type GroupIntent, type GroupState } from '@/lib/groups/actions';
import { scriptFromDisplayJson } from '@/lib/groups/codec';
import { describeAction } from '@/lib/groups/describe';
import { credentialForDrepId, groupIdParam } from '@/lib/groups/ids';
import { drepGroupsAvailable } from '@/lib/groups/gate';
import { wallClockSlot } from '@/lib/groups/groupTx';

export const prerender = false;

const NO_STORE = { 'cache-control': 'no-store' };

/** The group state the words of an intent compare with, null when a policy does not parse. */
function groupStateOf(
  group: { groupId: string; mode: string; status: string; seq: string },
  s: { control: { hash: string; json: string }; admission: { hash: string; json: string } | null },
): GroupState | null {
  const ref = groupIdParam(group.groupId);
  const policy = (p: { hash: string; json: string }) => {
    const x = scriptFromDisplayJson(p.json);
    return x ? Object.assign(x, { hash: p.hash }) : null;
  };
  const control = policy(s.control);
  const admission = s.admission ? policy(s.admission) : null;
  if (!ref || !control) return null;
  return { ref, mode: group.mode === 'open' ? 'open' : 'permissioned', status: group.status === 'dissolved' ? 'dissolved' : 'active', seq: BigInt(group.seq), control, admission };
}

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
  const s = await groupActionState(db, group, { drepId: viewer?.drepId ?? null });

  // A signing link is handed out to its initiator, to the keys it lists and to the member it is about.
  const key = viewer?.keyHash?.toLowerCase() ?? null;
  const policyKeys = new Set([...s.control.keys, ...(s.admission?.keys ?? [])]);
  const linkFor = (r: GroupActionRow): string | null =>
    user && (r.createdBy === user.id || (key !== null && r.requiredSigners.includes(key)) || r.subjectKind === 'member') ? r.id : null;
  // A row the session may open is described in words, from its intent and the state read above.
  const state = groupStateOf(group, s);
  const names = new Map(s.names);
  const joinMembers = new Map<string, Credential>();
  for (const m of [...s.pending, ...s.activeMembers]) {
    const c = credentialForDrepId(m.drepId);
    if (!c) continue;
    const hash = c.hash.toLowerCase();
    if (m.name) names.set(hash, m.name);
    joinMembers.set(m.joinId.toLowerCase(), { kind: c.kind, hash });
  }
  const linesOf = (r: GroupActionRow): string[] => {
    try {
      return describeAction(changesOfIntent(JSON.parse(r.params) as GroupIntent, state, { joinMembers }), names);
    } catch {
      return [];
    }
  };
  const rows = [...s.rows, ...s.viewerRows].map((r) => {
    const id = linkFor(r);
    // A collecting row whose fee input another transaction spent can never be submitted.
    const spent = r.feeInputSpent && r.status === 'collecting';
    return { id, kind: r.kind, status: r.status, ...(spent ? { inputSpent: true } : {}), ...(id ? { lines: linesOf(r) } : {}) };
  });

  return jsonResponse(
    {
      groupId: group.groupId,
      mode: group.mode,
      status: group.closing ? 'dissolved' : group.status,
      seq: group.seq,
      // The client builds its validity end from this clock, the one the server bounds it by.
      serverSlot: wallClockSlot(currentNetwork().network),
      control: s.control,
      admission: s.admission,
      names: Object.fromEntries(s.names),
      activeKeyMembers: s.activeKeyMembers,
      activeMembers: s.activeMembers,
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
