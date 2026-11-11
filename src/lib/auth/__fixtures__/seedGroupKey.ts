/// <reference types="@cloudflare/workers-types" />
// Seeds one group row whose control (and optionally admission) policy contains a key, optionally
// with the key resigned from a role.
import { hashBytes } from '../../groups/codec.js';

const hex = (n: number, len: number): string => n.toString(16).padStart(2, '0').repeat(len);

export async function seedGroupKey(
  db: D1Database,
  args: {
    key: string;
    tag: number;
    status?: string;
    inAdmission?: boolean;
    /** The same policy for control and admission, so the key is listed in both roles. */
    inBoth?: boolean;
    resignedControl?: boolean;
    resignedAdmission?: boolean;
  },
): Promise<void> {
  const { key, tag, status = 'active', inAdmission = false, inBoth = false } = args;
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
         created_h, created_ti, created_ph, created_ix, created_tx, resigned_control, resigned_admission)
       VALUES (?1, 0, 90, 0, 2, 0, ?1, 'permissioned', ?2, ?3, '0', ?4, 90, 0, 2, 0, ?1, ?5, ?6)`,
    )
    .bind(
      group,
      inAdmission && !inBoth ? other : script,
      inAdmission || inBoth ? script : null,
      status,
      args.resignedControl ? hashBytes(key) : new Uint8Array(0),
      args.resignedAdmission ? hashBytes(key) : new Uint8Array(0),
    )
    .run();
}
