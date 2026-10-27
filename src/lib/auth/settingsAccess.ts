/// <reference types="@cloudflare/workers-types" />
// What a signed-in user may see under /settings/: the facts every settings page
// needs for its own gate and the shell needs for the tab bar, read once per
// request with the lookups in parallel.
import { getSelfDrepId } from '../db/users.js';
import { isSeeded } from '../db/drepHandles.js';
import type { GrantManagerUser } from './coProposerManage.js';

export interface SettingsAccess {
  /** The user's own synced DRep id, gates Metadata, drep.link and Danger Zone. */
  drepId: string | null;
  /** A DRep whose drep.link section is open (the launch seed has run). */
  drepLinkOpen: boolean;
}

export async function loadSettingsAccess(
  db: D1Database | undefined,
  user: GrantManagerUser & { drepId?: string | null },
): Promise<SettingsAccess> {
  if (!db) return { drepId: null, drepLinkOpen: false };
  const [drepId, seeded] = await Promise.all([getSelfDrepId(db, user), isSeeded(db)]);
  return { drepId, drepLinkOpen: drepId != null && seeded };
}
