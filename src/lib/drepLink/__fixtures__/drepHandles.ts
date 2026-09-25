// Shared fixtures for the drep.link workers tests. Test-only, never imported by
// production code.
export function drepArgs(drepId: string, name: string | null, status: 'registered' | 'deregistered' = 'registered') {
  return {
    drepId, hex: null, hasScript: false, status, active: true, deposit: null,
    votingPower: null, expiresEpochNo: null, name, bio: null, imageUrl: null,
    imageContentHash: null, imageStoredUrl: null, imageFetchFailedAt: null, links: null,
    motivations: null, qualifications: null, paymentAddress: null, doNotList: false,
    anchorUrl: null, anchorHash: null, anchorStatus: 'no-anchor', profileExtractVersion: 0, lastSyncedAt: 0, createdAt: 0,
  };
}

export async function insertHandle(
  db: D1Database,
  handle: string,
  drepId: string,
  extra: { primary?: boolean; releasedAt?: number | null; source?: string; createdAt?: number } = {},
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO drep_handles (handle, drep_id, source, is_primary, released_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(handle, drepId, extra.source ?? 'seed', extra.primary === false ? 0 : 1, extra.releasedAt ?? null, extra.createdAt ?? 0, 0)
    .run();
}

export async function markSeeded(db: D1Database): Promise<void> {
  await db.prepare('INSERT INTO drep_handle_seed (id, seeded_at) VALUES (1, 0)').run();
}
