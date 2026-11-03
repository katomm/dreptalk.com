/// <reference types="@cloudflare/workers-types" />
// Seeds one group row whose control (and optionally admission) policy contains a key.
import { hashBytes } from '../../groups/codec.js';

const hex = (n: number, len: number): string => n.toString(16).padStart(2, '0').repeat(len);

export async function seedGroupKey(
  db: D1Database,
  args: { key: string; tag: number; status?: string; inAdmission?: boolean },
): Promise<void> {
  const { key, tag, status = 'active', inAdmission = false } = args;
  const group = hashBytes(hex(tag, 32));
  const script = hashBytes(hex(tag, 28));
  const other = hashBytes(hex(tag + 1, 28));
  await db
    .prepare('INSERT OR IGNORE INTO drep_group_policy_keys (key, script) VALUES (?, ?)')
    .bind(hashBytes(key), script)
    .run();
  await db
    .prepare(
      `INSERT INTO drep_groups (group_tx, group_ix, cur_h, cur_ti, cur_ph, cur_ix, cur_tx, mode, control, admission, seq, status,
         created_h, created_ti, created_ph, created_ix, created_tx)
       VALUES (?1, 0, 90, 0, 2, 0, ?1, 'permissioned', ?2, ?3, '0', ?4, 90, 0, 2, 0, ?1)`,
    )
    .bind(group, inAdmission ? other : script, inAdmission ? script : null, status)
    .run();
}
