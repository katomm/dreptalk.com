import { describe, expect, it, vi } from 'vitest';
import {
  createTesseraClient,
  MAX_REFS_PER_CALL,
  TesseraHttpError,
  TesseraNetworkMismatchError,
} from './client';

const TX_A = 'a'.repeat(64);
const TX_B = 'b'.repeat(64);
const KEY_A = `${TX_A}:0`;
const KEY_B = `${TX_B}:1`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const healthBody = { ok: true, network: 'preprod' };

const tip = { epoch: 300, slot: 90000000, time: 1780000000, epochSlot: 5000, govActionLifetime: 6 };

const surveySet = {
  surveys: [{ ref: { txHash: TX_A, index: 0 } }],
  cancellations: [],
  govLinks: [{ surveyKey: KEY_A, actionId: 'gov_action1xyz', endEpoch: 299, title: 'Budget' }],
  tip,
  responseCounts: { [KEY_A]: 12 },
  finalState: {},
  fetchedAt: 1780000100,
};

const surveyPage = {
  ...surveySet,
  counts: { all: 3, linked: 1, active: 2, sealed: 0, public: 3, mine: 0 },
  nextCursor: null,
};

// A finalized tally artifact as the preprod backend served it (survey
// 1200298c…:0, one counted DRep responder), recorded verbatim so the decode
// is held to the shape Tessera actually emits, not to one written from memory.
const LIVE_ARTIFACT_HASH = 'a9f7815126da1f45e8c2d760c66064b22ff7446d689088435918e3337a316027';
const liveArtifact = {
  tally: {
    rulesetHash: 'c11a980bc23a6fdfb8fb5878d4764225dc46b1a2010b43da8c68b918cf7bbc97',
    network: 'preprod',
    survey: {
      txId: '1200298ce001b907801909c18e6a4d55eee587e1bc3c1d4b24cfc4662ecd2d23',
      index: 0,
      endEpoch: 309,
    },
    sealed: false,
    perRole: [
      {
        role: 0,
        total: '934790092603250',
        responders: [
          {
            credential: 'key:3982112c16446e50a58cdff82a8b48689a7d893759bc7e30a1e4e86d',
            weight: '0',
            txHash: '4eb204e4245cbd9c02acfd41fe10ed840e13175f39f22ce1fcd27f3896ac8eef',
            responseIndex: 0,
          },
        ],
        questions: [
          {
            kind: 'options',
            unit: 'singleChoice',
            options: [{ index: 0, weight: '0', count: 1 }],
            answeredCount: 1,
            answeredWeight: '0',
          },
        ],
      },
    ],
  },
  provenance: {
    source: { provider: 'koios', baseUrl: 'https://preprod.koios.rest/api/v1' },
    fetchedAt: 1787962379,
    byRole: [{ role: 0, endpoint: 'drep_voting_power_history' }],
    govLinks: [],
  },
};

// Routes health to the guard and everything else to `body`, so each test
// declares only the data request it is about.
function fetchWithHealth(body: unknown, status = 200, health: unknown = healthBody) {
  return vi.fn((url: RequestInfo | URL) =>
    Promise.resolve(
      String(url).endsWith('/health') ? jsonResponse(health) : jsonResponse(body, status),
    ),
  );
}

// Mirrors real fetch: the pending stage, headers or body, rejects with the
// signal's reason on abort.
function stalledFetch(stage: 'headers' | 'body') {
  return vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/health')) return Promise.resolve(jsonResponse(healthBody));
    const signal = init?.signal;
    if (stage === 'headers') {
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason));
      });
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener('abort', () => controller.error(signal.reason));
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  });
}

function client(fetchImpl: typeof fetch, network = 'preprod') {
  return createTesseraClient({
    baseUrl: 'https://tessera.example.dev/',
    network,
    fetchImpl,
  });
}

describe('surveyList', () => {
  it('decodes a page and builds the query from the params', async () => {
    const fetchImpl = fetchWithHealth(surveyPage);
    const result = await client(fetchImpl).surveyList({ filter: 'linked', limit: 200 });

    expect(result.ready).toBe(true);
    if (!result.ready) return;
    expect(result.value.counts.linked).toBe(1);
    expect(result.value.govLinks[0].endEpoch).toBe(299);
    expect(result.value.responseCounts[KEY_A]).toBe(12);
    // A backend predating the audited counts serves none; the field must
    // then be absent rather than the decode failing.
    expect(result.value.countedByRole).toBeUndefined();
    expect(result.value.nextCursor).toBeNull();
    // The trailing slash of the base URL must not double.
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://tessera.example.dev/api/surveys?filter=linked&limit=200',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('passes the cursor through and surfaces resync', async () => {
    const fetchImpl = fetchWithHealth({ ...surveyPage, resync: true, nextCursor: 'c2' });
    const result = await client(fetchImpl).surveyList({ filter: 'linked', cursor: 'c1' });

    expect(result).toMatchObject({ ready: true, value: { resync: true, nextCursor: 'c2' } });
    expect(String(fetchImpl.mock.calls[1][0])).toContain('cursor=c1');
  });

  it('decodes the audited per-role counts, role keyed by its integer', async () => {
    const fetchImpl = fetchWithHealth({
      ...surveyPage,
      countedByRole: { [KEY_A]: { '0': 7, '1': 2 }, [KEY_B]: {} },
    });
    const result = await client(fetchImpl).surveyList();
    expect(result.ready).toBe(true);
    if (!result.ready) return;
    expect(result.value.countedByRole?.[KEY_A]['0']).toBe(7);
    expect(result.value.countedByRole?.[KEY_B]).toEqual({});
  });

  it('rejects a body missing the envelope fields', async () => {
    const { counts: _counts, ...withoutCounts } = surveyPage;
    const fetchImpl = fetchWithHealth(withoutCounts);
    await expect(client(fetchImpl).surveyList()).rejects.toThrow();
  });
});

describe('surveysByRefs', () => {
  it('decodes the named rows and joins the refs', async () => {
    const fetchImpl = fetchWithHealth({ ...surveySet, incomplete: true });
    const result = await client(fetchImpl).surveysByRefs([KEY_A, KEY_B]);

    expect(result.ready).toBe(true);
    if (!result.ready) return;
    expect(result.value.incomplete).toBe(true);
    expect(result.value.surveys).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://tessera.example.dev/api/surveys?refs=${KEY_A},${KEY_B}`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('decodes the three final states and rejects a state it cannot store', async () => {
    const decided = {
      ...surveySet,
      finalState: {
        [KEY_A]: { state: 'finalized', artifactHash: 'ab'.repeat(32) },
        [KEY_B]: { state: 'cancelled', artifactHash: 'cd'.repeat(32) },
        [`${'c'.repeat(64)}:0`]: { state: 'untalliable' },
      },
    };
    const result = await client(fetchWithHealth(decided)).surveysByRefs([KEY_A]);
    expect(result.ready).toBe(true);
    if (!result.ready) return;
    // The hash is what the sync later reads the final count by.
    expect(result.value.finalState[KEY_A]).toEqual({
      state: 'finalized',
      artifactHash: 'ab'.repeat(32),
    });
    expect(result.value.finalState[`${'c'.repeat(64)}:0`]).toEqual({ state: 'untalliable' });

    // A fourth state would freeze a row under a value no reader understands:
    // fail at the envelope, where the wire change gets reviewed.
    const unknown = { ...surveySet, finalState: { [KEY_A]: { state: 'vetoed' } } };
    await expect(client(fetchWithHealth(unknown)).surveysByRefs([KEY_A])).rejects.toThrow();
  });

  it('refuses an oversized or malformed key list without a request', async () => {
    const fetchImpl = fetchWithHealth(surveySet);
    const c = client(fetchImpl);

    const tooMany = Array.from({ length: MAX_REFS_PER_CALL + 1 }, (_, i) => `${TX_A}:${i}`);
    await expect(c.surveysByRefs(tooMany)).rejects.toThrow(RangeError);
    await expect(c.surveysByRefs([])).rejects.toThrow(RangeError);
    // `:01` is not canonical — the server would silently match nothing.
    await expect(c.surveysByRefs([`${TX_A}:01`])).rejects.toThrow(/malformed survey key/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('artifactByHash', () => {
  it('decodes a live-recorded artifact down to the per-role responders', async () => {
    const fetchImpl = fetchWithHealth(liveArtifact);
    const artifact = await client(fetchImpl).artifactByHash(LIVE_ARTIFACT_HASH);

    expect(artifact.tally.perRole).toHaveLength(1);
    expect(artifact.tally.perRole[0].role).toBe(0);
    expect(artifact.tally.perRole[0].responders).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://tessera.example.dev/api/artifacts/${LIVE_ARTIFACT_HASH}`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('rejects an artifact without the per-role tally', async () => {
    const fetchImpl = fetchWithHealth({ tally: { sealed: false }, provenance: {} });
    await expect(client(fetchImpl).artifactByHash(LIVE_ARTIFACT_HASH)).rejects.toThrow();
  });

  it("throws on the backend's 404 for a hash it never emitted", async () => {
    const fetchImpl = fetchWithHealth({ error: 'no artifact' }, 404);
    await expect(client(fetchImpl).artifactByHash(LIVE_ARTIFACT_HASH)).rejects.toThrow(
      /tessera request failed: 404/,
    );
  });

  it('refuses a malformed hash without a request', async () => {
    const fetchImpl = fetchWithHealth(liveArtifact);
    await expect(client(fetchImpl).artifactByHash('nope')).rejects.toThrow(
      /malformed artifact hash/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('responsesByTx', () => {
  it('decodes and unwraps the response list', async () => {
    const fetchImpl = fetchWithHealth({
      responses: [
        {
          surveyKey: KEY_A,
          responseIndex: 0,
          role: 0,
          credential: `key:${'c'.repeat(56)}`,
          slot: 5,
        },
      ],
    });
    const result = await client(fetchImpl).responsesByTx(TX_B);

    expect(result.ready).toBe(true);
    if (!result.ready) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0].surveyKey).toBe(KEY_A);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://tessera.example.dev/api/responses/${TX_B}`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('refuses a malformed tx hash without a request', async () => {
    const fetchImpl = fetchWithHealth({ responses: [] });
    await expect(client(fetchImpl).responsesByTx('beef')).rejects.toThrow(/malformed tx hash/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('snapshot not ready', () => {
  it("decodes the backend's 503 to a ready:false result", async () => {
    const fetchImpl = fetchWithHealth({ error: 'snapshot not ready' }, 503);
    const result = await client(fetchImpl).surveyList({ filter: 'linked' });
    expect(result).toEqual({ ready: false });
  });

  it('still throws on a 503 that is not the not-ready body (a gateway outage)', async () => {
    const fetchImpl = fetchWithHealth({ error: 'upstream timeout' }, 503);
    await expect(client(fetchImpl).surveyList()).rejects.toThrow(TesseraHttpError);
  });

  it('throws on any other non-2xx', async () => {
    const fetchImpl = fetchWithHealth({ error: 'bad request' }, 400);
    await expect(client(fetchImpl).surveysByRefs([KEY_A])).rejects.toThrow(
      /tessera request failed: 400/,
    );
  });
});

describe('network guard', () => {
  it('refuses a backend serving a different network, before any data request', async () => {
    const fetchImpl = fetchWithHealth(surveyPage, 200, { ok: true, network: 'preview' });
    const c = client(fetchImpl, 'preprod');

    await expect(c.surveyList()).rejects.toThrow(TesseraNetworkMismatchError);
    // Only /health was hit; the data request never went out, and the mismatch
    // keeps rejecting without re-checking.
    await expect(c.surveysByRefs([KEY_A])).rejects.toThrow(TesseraNetworkMismatchError);
    expect(fetchImpl.mock.calls.map(call => String(call[0]))).toEqual([
      'https://tessera.example.dev/health',
    ]);
  });

  it('checks /health once per client across data requests', async () => {
    const fetchImpl = fetchWithHealth(surveyPage);
    const c = client(fetchImpl);

    await c.surveyList();
    await c.surveyList();

    const urls = fetchImpl.mock.calls.map(call => String(call[0]));
    expect(urls.filter(u => u.endsWith('/health'))).toHaveLength(1);
  });

  it('retries the health check after a transient failure', async () => {
    let healthCalls = 0;
    const fetchImpl = vi.fn((url: RequestInfo | URL) => {
      if (String(url).endsWith('/health')) {
        healthCalls++;
        return Promise.resolve(
          healthCalls === 1 ? jsonResponse({}, 500) : jsonResponse(healthBody),
        );
      }
      return Promise.resolve(jsonResponse(surveyPage));
    });
    const c = client(fetchImpl);

    await expect(c.surveyList()).rejects.toThrow(TesseraHttpError);
    const result = await c.surveyList();
    expect(result.ready).toBe(true);
    expect(healthCalls).toBe(2);
  });
});

describe('timeout', () => {
  const opts = { baseUrl: 'https://tessera.example.dev', network: 'preprod', timeoutMs: 20 };

  it('rejects within timeoutMs when the headers never arrive', async () => {
    const c = createTesseraClient({ ...opts, fetchImpl: stalledFetch('headers') });
    await expect(c.surveyList()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects within timeoutMs when the headers arrive and the body stalls', async () => {
    const c = createTesseraClient({ ...opts, fetchImpl: stalledFetch('body') });
    await expect(c.surveyList()).rejects.toMatchObject({ name: 'AbortError' });
  });
});
