/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for POST /api/drep/multisig.
// Calls the exported POST handler directly with a synthetic APIContext so
// the test runs inside the real Workers runtime (D1 via cloudflare:test)
// without needing an HTTP server or the Astro middleware chain.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { nativeScriptHash, parseNativeScriptJson } from '@/lib/cardano/nativeScript';
import { encodeBech32 } from '@/lib/crypto/bech32';
import { hexToBytes } from '@/lib/crypto/hex';
import { DREP_SCRIPT_HEADER } from '@/lib/cardano/identity';
import { getPendingMultisig } from '@/lib/db/pendingMultisigTx';

// ---------------------------------------------------------------------------
// Koios mock: vi.mock is hoisted, so the factory runs before any imports.
// We expose a mutable ref so individual tests can swap the scriptInfo response.
// ---------------------------------------------------------------------------

const koiosMock = {
  scriptInfo: vi.fn<[string], Promise<{ script_hash: string; type: string; value: unknown } | null>>(),
};

vi.mock('@/lib/koios/client', () => ({
  createKoiosClient: () => koiosMock,
}));

// ---------------------------------------------------------------------------
// Evolution SDK mock: the endpoint decodes the tx CBOR and checks the body
// hash plus the voting-procedure content. We stub the relevant functions so
// tests can run without a real CBOR-encoded transaction.
//
// fromCBORHexImpl is replaced per-test via evoCbor.fromCBORHex.mockImplementation
// to control what the decoded tx looks like.
// ---------------------------------------------------------------------------

const evoCbor = {
  fromCBORHex: vi.fn<[string], unknown>(),
  toHash: vi.fn<[unknown], unknown>(),
  toHex: vi.fn<[unknown], string>(),
  scriptHashToHex: vi.fn<[unknown], string>(),
};

vi.mock('@evolution-sdk/evolution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@evolution-sdk/evolution')>();
  return {
    ...actual,
    Transaction: {
      ...actual.Transaction,
      fromCBORHex: (...args: unknown[]) => evoCbor.fromCBORHex(...args),
    },
    TransactionBody: {
      ...actual.TransactionBody,
      toHash: (...args: unknown[]) => evoCbor.toHash(...args),
    },
    TransactionHash: {
      ...actual.TransactionHash,
      toHex: (...args: unknown[]) => evoCbor.toHex(...args),
    },
    ScriptHash: {
      ...actual.ScriptHash,
      toHex: (...args: unknown[]) => evoCbor.scriptHashToHex(...args),
    },
  };
});

// Import the handler AFTER the mocks are registered (vitest hoists vi.mock above
// the import, but placing it here makes the dependency order explicit).
import { POST } from '../index';

// ---------------------------------------------------------------------------
// Script fixture: a known native-script whose hash we compute at module load.
// Any single-sig script works; we pick a stable key hash so the hash is
// deterministic across runs without needing a real key derivation.
// ---------------------------------------------------------------------------

const SIG_KEY_HASH = 'a'.repeat(56); // 28-byte key hash (lowercase hex, 56 chars)
const SCRIPT_VALUE = { type: 'any', scripts: [{ type: 'sig', keyHash: SIG_KEY_HASH }] };
const PARSED_SCRIPT = parseNativeScriptJson(SCRIPT_VALUE)!;
const SCRIPT_HASH = nativeScriptHash(PARSED_SCRIPT);

// Encodes a script hash hex as a CIP-129 bech32 drep1 script id (header 0x23).
function scriptDrepIdFromHash(scriptHashHex: string): string {
  const payload = new Uint8Array(29);
  payload[0] = DREP_SCRIPT_HEADER;
  payload.set(hexToBytes(scriptHashHex), 1);
  return encodeBech32('drep', payload);
}

const SCRIPT_DREP_ID = scriptDrepIdFromHash(SCRIPT_HASH);

const GA_ID = `${'b'.repeat(64)}#0`;
const TX_CBOR = 'c'.repeat(128); // arbitrary hex string (real decode is mocked)
const BODY_HASH = 'd'.repeat(64); // 32-byte hash hex
const USER_ID = 'script-drep-user-1';
const NOW = 1_752_000_000;

// Seed a user whose drep_id is the script DRep id and who has a 'drep' role.
async function seedScriptDrepUser(userId = USER_ID, drepId = SCRIPT_DREP_ID) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, drep_id, is_drep, is_spo, is_cc, is_proposer, role, status, created_at, last_verified_at)
     VALUES (?, ?, 1, 0, 0, 0, 'drep', 'active', ?, ?)`,
  )
    .bind(userId, drepId, NOW, NOW)
    .run();
}

// Build a synthetic APIContext for POST /api/drep/multisig.
// locals.user is injected directly, bypassing the Astro middleware.
function makeCtx(opts: {
  user: { id: string; roles: string[] } | null;
  body: Record<string, unknown>;
}) {
  const request = new Request('https://dreptalk.com/api/drep/multisig', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts.body),
  });
  const locals = { user: opts.user } as unknown as App.Locals;
  return { request, locals } as Parameters<typeof POST>[0];
}

// Valid request body using the fixture script DRep id.
function validBody(overrides: Record<string, unknown> = {}) {
  return {
    scriptDrepId: SCRIPT_DREP_ID,
    gaId: GA_ID,
    vote: 'yes',
    unsignedTxCbor: TX_CBOR,
    bodyHash: BODY_HASH,
    ...overrides,
  };
}

// A timelock ScriptInfo fixture matching the fixture script.
function timelockScriptInfo() {
  return {
    script_hash: SCRIPT_HASH,
    type: 'timelock' as const,
    value: SCRIPT_VALUE,
  };
}

// Returns a minimal fake tx whose voting procedures match GA_ID, BODY_HASH,
// vote='yes', and the given script hash as the DRep voter.
function makeFakeTx(scriptHashHex = SCRIPT_HASH) {
  const scriptHashObj = { _tag: 'ScriptHash', hash: scriptHashHex };
  const drep = { _tag: 'ScriptHashDRep', scriptHash: scriptHashObj };
  const voter = { _tag: 'DRepVoter', drep };
  const govActionId = {
    transactionId: { _tag: 'TransactionHash', hash: 'b'.repeat(64) },
    govActionIndex: 0n,
  };
  const procedure = { vote: { _tag: 'YesVote' }, anchor: null };
  const actionMap = new Map([[govActionId, procedure]]);
  const procedures = new Map([[voter, actionMap]]);
  return {
    body: {
      _tag: 'TransactionBody',
      votingProcedures: { procedures },
    },
  };
}

// Configures the evolution mocks for the happy path: fromCBORHex succeeds,
// toHash returns a sentinel, toHex returns BODY_HASH, scriptHashToHex returns
// the script hash so the voter check passes.
function setupHappyPathMocks() {
  const sentinelHash = {};
  evoCbor.fromCBORHex.mockImplementation(() => makeFakeTx());
  evoCbor.toHash.mockReturnValue(sentinelHash);
  evoCbor.toHex.mockImplementation((h) => {
    // toHex is called for two different objects: the body hash and the tx id
    // inside the voting procedures. Both must return values that match what
    // the handler compares against, so we check whether h is the sentinel.
    if (h === sentinelHash) return BODY_HASH;
    // This is the transactionId inside govActionId; match 'b'.repeat(64).
    return 'b'.repeat(64);
  });
  evoCbor.scriptHashToHex.mockReturnValue(SCRIPT_HASH);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/drep/multisig', () => {
  it('returns 401 when the caller is not logged in', async () => {
    const res = await POST(makeCtx({ user: null, body: validBody() }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when the caller is logged in but lacks the drep role', async () => {
    const res = await POST(makeCtx({
      user: { id: USER_ID, roles: ['proposer'] },
      body: validBody(),
    }));
    expect(res.status).toBe(401);
  });

  it('returns 400 on invalid input (bad gaId format)', async () => {
    await seedScriptDrepUser();
    koiosMock.scriptInfo.mockResolvedValue(timelockScriptInfo());
    const res = await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: validBody({ gaId: 'not-a-valid-ga-id' }),
    }));
    expect(res.status).toBe(400);
  });

  it('returns 403 when the session user drep_id does not match scriptDrepId', async () => {
    // Seed with a DIFFERENT drep_id so the membership check fails.
    const otherDrepId = scriptDrepIdFromHash('b'.repeat(56));
    await seedScriptDrepUser(USER_ID, otherDrepId);
    koiosMock.scriptInfo.mockResolvedValue(timelockScriptInfo());
    const res = await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: validBody(),
    }));
    expect(res.status).toBe(403);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('not a member');
  });

  it('returns 422 when koios reports a Plutus script type', async () => {
    await seedScriptDrepUser();
    koiosMock.scriptInfo.mockResolvedValue({
      script_hash: SCRIPT_HASH,
      type: 'plutusV2',
      value: null,
    });
    const res = await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: validBody(),
    }));
    expect(res.status).toBe(422);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.error).toBe('string');
    expect((body.error as string).toLowerCase()).toContain('plutus');
  });

  it('returns 422 when the native-script hash recomputed from the script value does not match the DRep id', async () => {
    // The hash in script_hash disagrees with what parseNativeScriptJson+nativeScriptHash computes.
    // To trigger the mismatch, supply a script_value that hashes to a different value.
    await seedScriptDrepUser();
    koiosMock.scriptInfo.mockResolvedValue({
      script_hash: SCRIPT_HASH,
      type: 'timelock' as const,
      // A different sig key so nativeScriptHash produces a different hash.
      value: { type: 'any', scripts: [{ type: 'sig', keyHash: 'f'.repeat(56) }] },
    });
    const res = await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: validBody(),
    }));
    expect(res.status).toBe(422);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('script hash mismatch');
  });

  it('returns 422 when koios returns null (script not found)', async () => {
    await seedScriptDrepUser();
    koiosMock.scriptInfo.mockResolvedValue(null);
    const res = await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: validBody(),
    }));
    expect(res.status).toBe(422);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('script not found');
  });

  it('returns 422 when the tx body hash does not match the supplied bodyHash', async () => {
    await seedScriptDrepUser();
    koiosMock.scriptInfo.mockResolvedValue(timelockScriptInfo());
    // fromCBORHex succeeds, but toHex for the body hash returns a different value.
    const sentinelHash = {};
    evoCbor.fromCBORHex.mockImplementation(() => makeFakeTx());
    evoCbor.toHash.mockReturnValue(sentinelHash);
    evoCbor.toHex.mockImplementation((h) => {
      if (h === sentinelHash) return 'e'.repeat(64); // wrong hash
      return 'b'.repeat(64);
    });
    evoCbor.scriptHashToHex.mockReturnValue(SCRIPT_HASH);

    const res = await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: validBody(), // bodyHash is BODY_HASH = 'd'.repeat(64)
    }));
    expect(res.status).toBe(422);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('body hash does not match transaction');
  });

  it('stores a pending multisig tx and returns an id for a valid native-script drep', async () => {
    await seedScriptDrepUser();
    koiosMock.scriptInfo.mockResolvedValue(timelockScriptInfo());
    setupHappyPathMocks();

    const res = await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: validBody(),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.id).toBe('string');
    expect((body.id as string).length).toBeGreaterThan(0);

    // Verify the row was actually written to D1.
    const row = await getPendingMultisig(env.DB, body.id as string);
    expect(row).not.toBeNull();
    expect(row!.drep_id).toBe(SCRIPT_DREP_ID);
    expect(row!.action).toBe('vote');
    expect(row!.status).toBe('collecting');
    expect(row!.unsigned_tx_cbor).toBe(TX_CBOR);
    expect(row!.body_hash).toBe(BODY_HASH);
    const params = JSON.parse(row!.action_params) as Record<string, unknown>;
    expect(params.gaId).toBe(GA_ID);
    expect(params.vote).toBe('yes');
    // Stored script is the serialized native-script JSON from the fixture.
    expect(row!.native_script).toBe(JSON.stringify(PARSED_SCRIPT));
  });

  // -------------------------------------------------------------------------
  // Voting-procedure binding: negative tests.
  // Each test drives the !foundVoteMatch 422 branch WITHOUT tripping the
  // body-hash check first. setupHappyPathMocks() wires the body-hash sentinel
  // so that check passes; only the voting-procedure content differs.
  // -------------------------------------------------------------------------

  it('returns 422 when the tx voting procedure gov action id does not match the request gaId', async () => {
    await seedScriptDrepUser();
    koiosMock.scriptInfo.mockResolvedValue(timelockScriptInfo());

    // Build a fake tx where govActionId.transactionId has a different hex
    // (all 'c' bytes instead of 'b') so txGaId != GA_ID.
    const sentinelHash = {};
    evoCbor.fromCBORHex.mockImplementation(() => {
      const fakeTx = makeFakeTx();
      // Override the transactionId hash so it does not equal 'b'.repeat(64).
      fakeTx.body.votingProcedures.procedures.forEach((actionMap) => {
        actionMap.forEach((_, govActionId) => {
          govActionId.transactionId = { _tag: 'TransactionHash', hash: 'c'.repeat(64) };
        });
      });
      return fakeTx;
    });
    evoCbor.toHash.mockReturnValue(sentinelHash);
    evoCbor.toHex.mockImplementation((h) => {
      if (h === sentinelHash) return BODY_HASH;
      // This is called for the govActionId.transactionId: return its stored hash.
      return (h as { hash: string }).hash;
    });
    evoCbor.scriptHashToHex.mockReturnValue(SCRIPT_HASH);

    const res = await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: validBody(), // gaId is still GA_ID = 'b'.repeat(64) + '#0'
    }));
    expect(res.status).toBe(422);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('transaction does not match the declared vote');
  });

  it('returns 422 when the tx vote tag maps to a different choice than the request vote', async () => {
    await seedScriptDrepUser();
    koiosMock.scriptInfo.mockResolvedValue(timelockScriptInfo());

    // Build a fake tx where the vote tag is NoVote; the request says 'yes'.
    const sentinelHash = {};
    evoCbor.fromCBORHex.mockImplementation(() => {
      const fakeTx = makeFakeTx();
      // Override the vote tag on every procedure entry.
      fakeTx.body.votingProcedures.procedures.forEach((actionMap) => {
        actionMap.forEach((procedure) => {
          procedure.vote = { _tag: 'NoVote' };
        });
      });
      return fakeTx;
    });
    evoCbor.toHash.mockReturnValue(sentinelHash);
    evoCbor.toHex.mockImplementation((h) => {
      if (h === sentinelHash) return BODY_HASH;
      return 'b'.repeat(64); // govActionId.transactionId matches GA_ID
    });
    evoCbor.scriptHashToHex.mockReturnValue(SCRIPT_HASH);

    const res = await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: validBody({ vote: 'yes' }), // request says yes, tx says no
    }));
    expect(res.status).toBe(422);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('transaction does not match the declared vote');
  });

  it('returns 422 when the tx DRep voter script hash does not match the script DRep credential', async () => {
    await seedScriptDrepUser();
    koiosMock.scriptInfo.mockResolvedValue(timelockScriptInfo());

    // The body-hash sentinel passes as usual, but scriptHashToHex returns
    // a different hash so voterScriptHash != parsedDrep.hashHex.
    const sentinelHash = {};
    evoCbor.fromCBORHex.mockImplementation(() => makeFakeTx());
    evoCbor.toHash.mockReturnValue(sentinelHash);
    evoCbor.toHex.mockImplementation((h) => {
      if (h === sentinelHash) return BODY_HASH;
      return 'b'.repeat(64);
    });
    // Return a script hash that does not equal SCRIPT_HASH.
    evoCbor.scriptHashToHex.mockReturnValue('f'.repeat(64));

    const res = await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: validBody(),
    }));
    expect(res.status).toBe(422);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('transaction does not match the declared vote');
  });

  it('includes optional anchor fields in action_params when provided', async () => {
    await seedScriptDrepUser();
    koiosMock.scriptInfo.mockResolvedValue(timelockScriptInfo());
    setupHappyPathMocks();
    const anchorUrl = 'https://example.com/rationale.json';
    const anchorHashHex = 'e'.repeat(64);

    const res = await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: validBody({ anchorUrl, anchorHashHex }),
    }));
    expect(res.status).toBe(200);
    const { id } = await res.json() as { id: string };
    const row = await getPendingMultisig(env.DB, id);
    const params = JSON.parse(row!.action_params) as Record<string, unknown>;
    expect(params.anchorUrl).toBe(anchorUrl);
    expect(params.anchorHashHex).toBe(anchorHashHex);
  });
});
