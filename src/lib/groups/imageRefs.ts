/// <reference types="@cloudflare/workers-types" />
// Group images DRepTalk hosts. A group image is uploaded to the shared avatar
// bucket (/api/drep/image) and only referenced by URL, from the group's synced
// profile and from the profile documents DRepTalk hosts, including ones still
// waiting for admin signatures. The avatar cleanup must count these as in use.

const HOSTED_AVATAR = /\/api\/avatar\/([0-9a-f]{64})/g;

/** Content hashes of every hosted image a group profile or hosted profile document points at. */
export async function listReferencedGroupImageHashes(db: D1Database): Promise<Set<string>> {
  const [profiles, docs] = await db.batch<{ t: string }>([
    db.prepare(`SELECT image AS t FROM drep_group_profiles WHERE image LIKE '%/api/avatar/%'`),
    db.prepare(`SELECT body AS t FROM drep_group_profile_docs WHERE body LIKE '%/api/avatar/%'`),
  ]);
  const hashes = new Set<string>();
  for (const row of [...(profiles.results ?? []), ...(docs.results ?? [])]) {
    for (const m of String(row.t).matchAll(HOSTED_AVATAR)) hashes.add(m[1]);
  }
  return hashes;
}
