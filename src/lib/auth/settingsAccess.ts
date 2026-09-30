/// <reference types="@cloudflare/workers-types" />
// What a signed-in user may see under /settings/: the facts every settings page
// needs for its own gate and the shell needs for the tab bar, read once per
// request with the three lookups in parallel.
import { getSelfDrepId } from '../db/users.js';
import { isSeeded } from '../db/drepHandles.js';
import { requireGrantManager, type GrantManagerUser } from './coProposerManage.js';

export interface SettingsAccess {
  /** The user's own synced DRep id, gates Metadata, drep.link and Danger Zone. */
  drepId: string | null;
  /** Manages co-proposer grants, the same guard the management routes enforce. */
  isProposer: boolean;
  /** A DRep whose drep.link section is open (the launch seed has run). */
  drepLinkOpen: boolean;
}

export async function loadSettingsAccess(
  db: D1Database | undefined,
  user: GrantManagerUser & { drepId?: string | null },
): Promise<SettingsAccess> {
  if (!db) return { drepId: null, isProposer: false, drepLinkOpen: false };
  const [drepId, grantGuard, seeded] = await Promise.all([
    getSelfDrepId(db, user),
    requireGrantManager(db, user),
    isSeeded(db),
  ]);
  return { drepId, isProposer: 'row' in grantGuard, drepLinkOpen: drepId != null && seeded };
}
