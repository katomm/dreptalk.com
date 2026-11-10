/// <reference types="@cloudflare/workers-types" />
// The D1 store with the ingest hooks of the conformance driver. The hooks feed the production
// ingest functions, completeness goes through the production tracked columns, and the snapshot
// reads every table in full. Test only.
import type { ChainTx, Credential, EngineSnapshot, LedgerInput, Pos, QueuedEvent } from 'drep-groups';
import { bytesToHex, comparePos, credKey, LeaseLostError, memberScriptWitness, parseNativeScript, posOfCert, refKey } from 'drep-groups';
import type { DriverStore } from 'drep-groups/conformance';
import {
  bytesFromCol,
  credBytes,
  credFromKey,
  credKeyFromCol,
  decodeContext,
  decodeEvent,
  hashFromCol,
  instanceFromRow,
  posFromRow,
  versionFromRow,
  type Row,
} from '../codec.js';
import { D1Store } from '../store/d1Store.js';
import { storeLabelTxs, storeLedgerRows } from '../store/ingest.js';
import { acquireLease, writeBatch } from '../store/lease.js';
import { INGEST } from '../store/queries.js';
import { frontiers } from '../store/reads.js';

// Block times and hashes the driver's inputs do not carry: a block every 20 seconds.
const blockTime = (h: number): number => h * 20;

// Marks every tracked credential outside the bound JSON list (stored credentials in hex) complete,
// the reference store's default.
const SWEEP_COMPLETE = `UPDATE drep_group_tracked SET known = 1, history_done = 1
  WHERE (known IS NULL OR known <> 1 OR history_done <> 1) AND cred NOT IN (SELECT unhex(value) FROM json_each(?))`;
// Binds the credential and history_done.
const SET_COMPLETE = `INSERT INTO drep_group_tracked (cred, seq, known, history_done)
  VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM drep_group_tracked), 1, CAST(? AS INTEGER))
  ON CONFLICT (cred) DO UPDATE SET known = 1, history_done = excluded.history_done`;
// Binds whether to set L, L, whether to set R, R.
const SET_FRONTIERS = `UPDATE drep_group_meta SET L = CASE WHEN ? = 1 THEN CAST(? AS INTEGER) ELSE L END,
  R = CASE WHEN ? = 1 THEN CAST(? AS INTEGER) ELSE R END WHERE id = 1`;

const byPos = <T>(at: (x: T) => Pos, tie: (x: T) => string) => (a: T, b: T): number =>
  comparePos(at(a), at(b)) || (tie(a) < tie(b) ? -1 : tie(a) > tie(b) ? 1 : 0);
const byTx = <T extends { blockHeight: number; txIndex: number; txHash: string }>(a: T, b: T): number =>
  a.blockHeight - b.blockHeight || a.txIndex - b.txIndex || (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0);

export class D1DriverStore extends D1Store implements DriverStore {
  private token = '';
  private owner = '';
  /** Credentials the driver marked incomplete, every other tracked credential is complete. */
  private readonly incomplete = new Set<string>();
  /** Set by expireLease until the next acquire, the only lease loss a schedule may cause. */
  private expired = false;

  async acquireLease(owner: string): Promise<string> {
    const token = await acquireLease(this.db, owner);
    if (token === null) throw new Error(`no lease for ${owner}`);
    this.owner = owner;
    this.token = token;
    this.expired = false;
    return token;
  }

  async expireLease(): Promise<void> {
    await this.db.prepare('UPDATE drep_group_lease SET expires_at = 0 WHERE id = 1').run();
    this.expired = true;
  }

  /**
   * Runs a write with the held token, after a lease expired by the driver once more with a fresh
   * one. Any other lease loss is an error of the store and fails the schedule.
   */
  private async held<T>(write: (token: string) => Promise<T>): Promise<T> {
    try {
      return await write(this.token);
    } catch (e) {
      if (!(e instanceof LeaseLostError) || !this.expired) throw e;
      await this.acquireLease(this.owner);
      return write(this.token);
    }
  }

  private sweep(): D1PreparedStatement {
    return this.db.prepare(SWEEP_COMPLETE).bind(JSON.stringify([...this.incomplete].map((k) => bytesToHex(credBytes(k)))));
  }

  async ingestLabelTx(tx: ChainTx): Promise<'stored' | 'duplicate' | 'marker'> {
    // Each tx is its own discovery batch at its own height, the tx hash stands in for the block hash.
    const L = { height: tx.blockHeight, hash: tx.txHash, safeHeight: tx.blockHeight, safeTime: blockTime(tx.blockHeight) };
    const [r] = await this.held((t) => storeLabelTxs(this.db, t, [{ tx, blockHash: tx.txHash }], L, async (h) => blockTime(h)));
    await this.held((t) => writeBatch(this.db, t, [this.sweep()]));
    return r as 'stored' | 'duplicate' | 'marker';
  }

  async ingestLedgerRow(input: LedgerInput): Promise<'stored' | 'duplicate'> {
    const c = input.credential;
    // The tracked row exists before its first ledger row.
    await this.held((t) =>
      writeBatch(this.db, t, [this.db.prepare(INGEST.trackCreds(1)).bind(credBytes(credKey(c)), 1), this.sweep()]),
    );
    const script = c.kind === 'script' && input.kind === 'reg';
    const [r] = await this.held((t) =>
      storeLedgerRows(
        this.db,
        t,
        [
          {
            input,
            blockHash: input.txHash,
            blockTime: blockTime(input.blockHeight),
            witnessState: script ? 'checked' : 'na',
            // The member script from the witness set or a reference script, as the library resolves it.
            witness: script ? (memberScriptWitness(c, input.witnessScripts, input.referenceScripts)?.bytes ?? null) : null,
          },
        ],
        null,
      ),
    );
    return r as 'stored' | 'duplicate';
  }

  async setFrontiers(f: { L?: number; R?: number | null }): Promise<void> {
    const stmt = this.db
      .prepare(SET_FRONTIERS)
      .bind(f.L === undefined ? 0 : 1, f.L ?? null, f.R === undefined ? 0 : 1, f.R ?? null);
    await this.held((t) => writeBatch(this.db, t, [stmt]));
  }

  async setComplete(c: Credential, complete: boolean): Promise<void> {
    if (complete) this.incomplete.delete(credKey(c));
    else this.incomplete.add(credKey(c));
    const stmt = this.db.prepare(SET_COMPLETE).bind(credBytes(credKey(c)), complete ? 1 : 0);
    await this.held((t) => writeBatch(this.db, t, [stmt]));
  }

  // A finished fork deletes the tracked rows and with them every completeness flag, as the
  // reference store clears its flags.
  override async resetStep(mode: 'rebuild' | 'fork', budget: number, lease: string): Promise<'more' | 'done'> {
    const r = await super.resetStep(mode, budget, lease);
    if (mode === 'fork' && r === 'done') this.incomplete.clear();
    return r;
  }

  async snapshot(): Promise<EngineSnapshot> {
    const all = async (sql: string): Promise<Row[]> => (await this.db.prepare(sql).all<Row>()).results ?? [];
    const ref = (tx: unknown, ix: unknown) => ({ txHash: hashFromCol(tx), index: Number(ix) });
    const groupCols = `group_tx, group_ix, cur_h AS at_h, cur_ti AS at_ti, cur_ph AS at_ph, cur_ix AS at_ix, cur_tx AS at_tx,
      mode, control, admission, profile_url, profile_hash, resigned_control, resigned_admission, seq, status, created_h, created_ti, created_ph, created_ix, created_tx,
      profile_set_h, profile_set_ti, profile_set_ph, profile_set_ix, profile_set_tx`;
    const script = (r: Row) => {
      const bytes = bytesFromCol(r.bytes);
      const parsed = parseNativeScript(bytes);
      if (parsed === null) throw new Error('stored script does not parse');
      return { script: parsed, bytes, at: posFromRow(r, 'at') };
    };
    const queue = (r: Row): QueuedEvent & { applied: boolean } => ({
      subject: credFromKey(credKeyFromCol(r.subject)),
      at: posFromRow(r, 'at'),
      group: r.group_tx === null ? null : ref(r.group_tx, r.group_ix),
      txHash: hashFromCol(r.tx_hash),
      event: decodeEvent(String(r.event_json)),
      applied: Number(r.applied) === 1,
    });
    const ledger = (r: Row): LedgerInput => ({
      kind: String(r.kind) as LedgerInput['kind'],
      credential: credFromKey(credKeyFromCol(r.cred)),
      txHash: hashFromCol(r.tx_hash),
      blockHeight: Number(r.block_height),
      txIndex: Number(r.tx_index),
      certIndex: Number(r.cert_index),
      witnessScripts: r.witness === null ? [] : [bytesFromCol(r.witness)],
    });
    return {
      frontiers: await frontiers(this.db),
      groups: (await all(`SELECT ${groupCols} FROM drep_groups`))
        .map(versionFromRow)
        .sort(byPos((g) => g.createdAt, (g) => refKey(g.id))),
      versions: (await all('SELECT * FROM drep_group_versions')).map(versionFromRow).sort(byPos((v) => v.at, (v) => refKey(v.id))),
      scripts: (await all('SELECT * FROM drep_group_scripts'))
        .map((r) => ({ hash: hashFromCol(r.hash), ...script(r) }))
        .sort(byPos((s) => s.at, (s) => s.hash)),
      memberScripts: (await all('SELECT * FROM drep_group_member_scripts'))
        .map((r) => ({ credential: credFromKey(credKeyFromCol(r.cred)), ...script(r) }))
        .sort(byPos((m) => m.at, (m) => credKey(m.credential))),
      instances: (await all('SELECT * FROM drep_group_instances')).map(instanceFromRow).sort(byPos((i) => i.joinedAt, (i) => refKey(i.joinId))),
      verdicts: (await all('SELECT * FROM drep_group_verdicts'))
        .map((r) => ({
          ref: ref(r.tx_hash, r.idx),
          tag: String(r.tag) as EngineSnapshot['verdicts'][number]['tag'],
          valid: Number(r.valid) === 1,
          reason: r.reason === null ? null : String(r.reason),
          at: posFromRow(r, 'at'),
          group: ref(r.group_tx, r.group_ix),
          subject: r.subject === null ? null : credFromKey(credKeyFromCol(r.subject)),
        }))
        .sort(byPos((v) => v.at, (v) => refKey(v.ref))),
      queue: (await all('SELECT * FROM drep_group_queue')).map(queue).sort(byPos((q) => q.at, (q) => q.txHash)),
      txContexts: (await all('SELECT * FROM drep_group_tx_context'))
        .map((r) => ({ txHash: hashFromCol(r.tx_hash), blockHeight: Number(r.block_height), txIndex: Number(r.tx_index), context: decodeContext(r) }))
        .sort(byTx),
      labelTxs: (await all('SELECT tx_hash, block_height, tx_index, marker FROM drep_group_txs'))
        .map((r) => ({ txHash: hashFromCol(r.tx_hash), blockHeight: Number(r.block_height), txIndex: Number(r.tx_index), marker: Number(r.marker) === 1 }))
        .sort(byTx),
      ledger: (await all('SELECT * FROM drep_group_ledger')).map(ledger).sort(byPos(posOfCert, (l) => l.txHash)),
      appliedThrough: (await all('SELECT * FROM drep_group_tracked WHERE applied_h IS NOT NULL'))
        .map((r) => ({ credential: credFromKey(credKeyFromCol(r.cred)), at: posFromRow(r, 'applied') }))
        .sort((a, b) => (credKey(a.credential) < credKey(b.credential) ? -1 : 1)),
    };
  }
}
