// Sample binds of every registered statement of the DRep groups store, placeholders only, for the
// query plan check.
import {
  COMMIT,
  COMMIT_TRAILING,
  COMMIT_WIDTH,
  INGEST,
  INGEST_TRAILING,
  INGEST_WIDTH,
  JOB,
  JOB_TRAILING,
  JOB_WIDTH,
  OWN,
  OWN_WIDTH,
  PHASE_ORDER,
  PHASE_PARTS,
  phaseProbes,
  type Q,
  REC_KEYED,
  REC_KEYED_TRAILING,
  REC_KEYED_WIDTH,
  type RecoveryMode,
} from '../store/queries.js';

// The binds of every recovery part's page and probe and every phase's advance statement, by the names they are registered under.
function recoveryBinds(): Record<string, unknown[]> {
  const binds: Record<string, unknown[]> = {};
  for (const mode of Object.keys(PHASE_PARTS) as RecoveryMode[]) {
    for (const phase of PHASE_ORDER[mode]) {
      if (phase === 'cursors') continue;
      const probes = phaseProbes(mode, phase);
      binds[`rec_${mode}_${phase}_advance`] = [...probes.flatMap((p) => (p.cut ? [1] : [])), phase, phase];
      for (const p of PHASE_PARTS[mode][phase] ?? []) {
        const name = `rec_${mode}_${phase}_${p.name}`;
        binds[`${name}_probe`] = p.cut ? [1] : [];
        p.stmts.forEach((s, i) => {
          binds[`${name}_${i}`] = [
            ...Array.from({ length: s.lead ?? 0 }, () => 1),
            ...Array.from({ length: s.pages ?? 1 }, () => [...(p.cut ? [1] : []), 10]).flat(),
          ];
        });
      }
    }
  }
  return binds;
}

// Placeholder values of a stored tx hash and credential.
const TX = new Uint8Array(32);
const CRED = new Uint8Array(29);

export const Q_SAMPLE_BINDS: Readonly<Record<keyof typeof Q, unknown[]>> = Object.freeze({
  leaseSeed: [],
  leaseTake: ['owner', 'token', 'owner'],
  leaseToken: [],
  leaseRelease: ['token'],
  leaseGuard: ['token'],
  leaseGuardEnd: [],
  loadInstances: [TX, 0],
  loadLatestInstances: [TX, 0, CRED],
  loadGroupsAt: [TX, 0, 1, 0, 2, 0],
  loadScriptsAt: [TX, 1, 0, 2, 0],
  loadCredentialsAt: [CRED, 1, 0, 2, 0],
  queuedJoins: [TX, 0],
  txContexts: [TX],
  scriptDisplays: [new Uint8Array(28)],
  treasuryScripts: [new Uint8Array(28)],
  drepNames: ['drep1x'],
  groupsForPolicyKey: [new Uint8Array(28)],
  ...(Object.fromEntries(
    (Object.keys(COMMIT) as Array<keyof typeof COMMIT>).map((k) => [
      k,
      Array.from({ length: COMMIT_WIDTH[k] + (COMMIT_TRAILING[k] ?? 0) }, () => 0),
    ]),
  ) as Record<keyof typeof COMMIT, unknown[]>),
  labelTxPage: [1, 0, 2, 10],
  labelTxProbe: [1, 0, 2],
  readyTracked: [1, 1, 0, 2, 0, 10],
  queueInputs: [CRED, 1, 0, 2, 0, 2, 0, 2, 0, 10],
  ledgerInputs: [CRED, 1, 0, 0, 2, 0, 0, 10],
  groupCursor: [1, 0, 2, 0, TX, 1, 0, 2, 0],
  credentialCursor: [1, 0, 2, 0, TX, 1, 0, 2, 0, 1, 0, 2, 0, 1, 0, 2, 0, 1, 0, 2, 0, CRED],
  frontiers: [],
  pendingRecovery: [],
  metaRow: [],
  operatorTruncateClear: [100],
  ...(Object.fromEntries(
    (Object.keys(INGEST) as Array<keyof typeof INGEST>).map((k) => [
      k,
      Array.from({ length: INGEST_WIDTH[k] + (INGEST_TRAILING[k] ?? 0) }, () => 0),
    ]),
  ) as Record<keyof typeof INGEST, unknown[]>),
  setL: [1, 'hash'],
  createRegCursor: [1, 0],
  regCursor: [0, 0, 1],
  historyOffset: [0, CRED],
  probeTxBlock: [100],
  probeLedgerBlock: [100],
  probeState: [1, 100],
  gateCandidates: [10],
  historyCandidates: [0, 10],
  pendingWitnesses: [0, 10],
  refetchMarkers: [10],
  storedInputs: [],
  libVersion: ['0.2.0'],
  recoverySlots: ['truncate', 1, 0, null, null, 1, 'jobs', null],
  ...recoveryBinds(),
  profileDuePage: [1, 10],
  profileDueDropStale: [1, 10],
  websiteDuePage: [1, 10],
  websiteDueDropStale: [1, 10],
  upsertProfile: [TX, 0, 'https://x.test/g.json', TX, 'ok', null, null, null, null, null, null, 1, null, null],
  profileStored: [TX, 0, TX],
  profileDueDone: [TX, 0, 'https://x.test/g.json', TX],
  profileDueRetry: [1, TX, 0, 'https://x.test/g.json', TX],
  websiteDueUpsert: [1, TX, 0, 'https://x.test/g.json', TX],
  websiteCheck: [1, 1, 1, TX, 0],
  websiteDueMove: [1, TX, 0],
  listedFirst: [10],
  listedAfter: ['100', TX, 0, 10],
  sitemapGroups: [10],
  groupRow: [TX, 0],
  memberPage: [TX, 0, 'open', -1, -1, -1, -1, 10],
  closingMemberPage: [TX, 0, -1, -1, -1, -1, 10],
  verdictPage: [TX, 0, 1, 10],
  pendingVerification: [TX, 0],
  drepGroups: ['drep1x', 10],
  groupMemberDreps: [TX, 0, TX, 0],
  recVersionsProbe: [1],
  recVersionsPage: [1, 1, 10],
  ...(Object.fromEntries(
    (Object.keys(REC_KEYED) as Array<keyof typeof REC_KEYED>).map((k) => [
      k,
      Array.from({ length: REC_KEYED_WIDTH[k] + (REC_KEYED_TRAILING[k] ?? 0) }, () => 0),
    ]),
  ) as Record<keyof typeof REC_KEYED, unknown[]>),
  recLedgerTime: [1],
  recTruncateCursors: [1, 0, 2, 0, TX, 1, null, 1, 0],
  recRebuildCursors: [],
  recForkCursors: [],
  jobPick: [],
  jobRow: [1],
  jobGroupPass: [TX, 0, -1, -1, -1, -1, 10],
  jobCredPass: [CRED, -1, -1, -1, -1, 10],
  jobVerdictPass: [TX, 0, 1, -1, -1, -1, -1, 10],
  jobPowerPass: [TX, 0, -1, -1, -1, -1, 10],
  jobProgress: ['{}', null, 0, 1],
  jobDelete: [1],
  jobDeleteAtGroupGen: [1, TX, 0, 0],
  jobDeleteAtCredGen: [1, CRED, 0],
  jobPowerSum: [TX, 0, -1, -1, -1, -1, 1, 0, 2, 0, '{}', 0, 1],
  jobPowerPublish: [1, TX, 0, 0],
  jobRecomputePublish: [0, 0, 0, 0, TX, 0, 0],
  jobDissolveDone: [TX, 0, 0],
  jobRetireDone: [CRED, 0],
  trimCount: [TX, 0, 1, 100, 10, 200],
  trimDelete: [TX, 0, 1, 100, 10, 200],
  trimGroup: [0, 0, TX, 0],
  trimNext: [TX, 0, TX, 0, TX, 0],
  trimDone: [TX, 0, TX, 0, TX, 0],
  powerQueue: [10],
  powerQueued: [],
  powerProgress: ['key', 'drep1x', 1],
  powerScanEnqueue: [],
  powerScanDone: [],
  ...(Object.fromEntries(
    (Object.keys(JOB) as Array<keyof typeof JOB>).map((k) => [
      `job_${k}`,
      Array.from({ length: JOB_WIDTH[k] + (JOB_TRAILING[k] ?? 0) }, () => 0),
    ]),
  ) as Record<`job_${keyof typeof JOB}`, unknown[]>),
  ...(Object.fromEntries(
    (Object.keys(OWN) as Array<keyof typeof OWN>).map((k) => [`own_${k}`, Array.from({ length: OWN_WIDTH[k] }, () => 0)]),
  ) as Record<`own_${keyof typeof OWN}`, unknown[]>),
  resolveOpen: [10],
  resolveNeverIncluded: [10],
  joinNotifyPage: [10],
  actionCreate: [...Array.from({ length: 16 }, () => 'x'), 1, '[]'],
  actionOpenControl: ['group1x'],
  actionFreeStale: ['id', 0, 0],
  actionPruneResolved: [0, 10],
  actionCancel: ['id', 0],
  actionGroupName: [new Uint8Array(32), 0],
});
