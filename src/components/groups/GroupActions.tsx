// React island of a DRep group page. It reads the session's view from a session aware route, so
// the page around it stays cacheable, and lists the group actions in progress. Everything a signed
// in DRep can do here lives in the panel, which is loaded only for a session, so an anonymous
// visitor does not download the group library or the transaction builder.
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { CardanoNetwork } from '@/lib/config/network.js';
import type { GroupProfileInput } from '@/lib/groups/profileDocs.js';
import { ACTION_KIND_LABEL, ACTION_STATUS_LABEL, INPUT_SPENT_STATUS, INPUT_SPENT_TEXT } from '@/lib/groups/view.js';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import { h3, part } from './groupUi.js';

const GroupActionsPanel = lazy(() => import('./GroupActionsPanel.js'));

export interface PolicyView {
  hash: string;
  /** Display JSON of the native script. */
  json: string;
  keys: string[];
}

/** Shape returned by GET /api/groups/[id]/state. */
export interface GroupActionView {
  groupId: string;
  mode: 'open' | 'permissioned';
  status: 'active' | 'dissolved';
  seq: string;
  /** The server's wall clock slot when the state was read, the client clock may be off. */
  serverSlot: number;
  control: PolicyView;
  admission: PolicyView | null;
  /** Key hashes that resigned from the control and from the admission role. */
  resignedControl: string[];
  resignedAdmission: string[];
  /** DRep names by key hash. */
  names: Record<string, string>;
  activeKeyMembers: Array<{ drepId: string; keyHash: string; name: string | null }>;
  /** Every active member with its join, key and script DReps. */
  activeMembers: Array<{ joinId: string; drepId: string; name: string | null }>;
  pending: Array<{ joinId: string; drepId: string; name: string | null }>;
  openControl: { id: string | null } | null;
  /** Unresolved actions, those the session may open with what they do in words. `inputSpent`: a fee input was spent by another transaction, the action can no longer be submitted. */
  rows: Array<{ id: string | null; kind: string; status: string; inputSpent?: boolean; lines?: string[] }>;
  viewer: { keyHash: string | null; drepId: string | null; join: { joinId: string; state: 'pending' | 'active' } | null } | null;
}

export interface GroupActionsProps {
  groupId: string;
  network: CardanoNetwork;
  /** The group's current profile, the policy editor starts from it. */
  profile?: GroupProfileInput | null;
}

export default function GroupActions({ groupId, network, profile = null }: GroupActionsProps) {
  // The state with the performance clock reading of when it arrived.
  const [loaded, setLoaded] = useState<{ v: GroupActionView; at: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(`/api/groups/${groupId}/state`);
      if (res.ok) {
        const body = (await res.json()) as GroupActionView;
        setLoaded({ v: body, at: performance.now() });
      }
    } catch {
      // The island stays empty, the page around it is complete without it.
    }
  }, [groupId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!loaded) return null;
  const { v } = loaded;
  // The panel has something to offer only to a DRep on an active group, everyone else sees the actions in progress at most.
  const panel = v.viewer !== null && v.status === 'active' && (v.viewer.drepId !== null || v.viewer.keyHash !== null);
  if (v.rows.length === 0 && !panel) return null;

  return (
    <section className="group-manage" aria-labelledby="group-manage-heading">
      <h2 id="group-manage-heading" className="group-manage__h">
        Manage
      </h2>
      <div className="group-manage__body">
        {v.rows.length > 0 && (
          <section aria-label="Group actions in progress" style={part}>
            <h3 style={h3}>In progress</h3>
            <ul style={{ margin: 0, paddingLeft: '1.25rem', display: 'grid', gap: '0.25rem' }}>
              {v.rows.map((r, i) => (
                <li key={r.id ?? `row-${i}`}>
                  {ACTION_KIND_LABEL[r.kind] ?? r.kind}: {r.inputSpent ? INPUT_SPENT_STATUS : (ACTION_STATUS_LABEL[r.status] ?? r.status)}
                  {r.lines && r.lines.length > 0 && <span style={{ display: 'block', color: 'var(--muted)', fontSize: '0.875rem' }}>{r.lines.join(' ')}</span>}
                  {r.inputSpent && <span style={{ display: 'block', fontSize: '0.875rem' }}>{INPUT_SPENT_TEXT} Cancel it and start it again.</span>}
                  {r.id && (
                    <>
                      {' '}
                      <a href={`/groups/sign/${r.id}/`}>Open the signing page</a>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {panel && v.viewer && (
          <Suspense fallback={null}>
            <GroupActionsPanel v={v} fetchedAt={loaded.at} network={network} profile={profile} reload={load} />
          </Suspense>
        )}
      </div>
    </section>
  );
}
