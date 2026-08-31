import { describe, expect, it, vi } from 'vitest';
import {
  MAX_REFS_PER_CALL,
  TesseraHttpError,
  TesseraNetworkMismatchError,
  createTesseraClient,
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
  finalizedCancelled: [],
  fetchedAt: 1780000100,
};

const surveyPage = {
  ...surveySet,
  counts: { all: 3, linked: 1, active: 2, sealed: 0, public: 3, mine: 0 },
  nextCursor: null,
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

describe('surveyBundle', () => {
  const bundle = {
    survey: { ref: { txHash: TX_A, index: 0 } },
    responses: [{ responseIndex: 0 }],
    cancellations: [],
    govLinks: [],
    tip,
    verdicts: { [`${TX_B}:0`]: true },
    nextCursor: 'next',
    fetchedAt: 1780000100,
  };

  it('decodes a bundle page and splits the key into the path', async () => {
    const fetchImpl = fetchWithHealth(bundle);
    const result = await client(fetchImpl).surveyBundle(KEY_A, 'cur');

    expect(result.ready).toBe(true);
    if (!result.ready) return;
    expect(result.value.verdicts[`${TX_B}:0`]).toBe(true);
    expect(result.value.nextCursor).toBe('next');
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://tessera.example.dev/api/surveys/${TX_A}/0?cursor=cur`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('refuses a malformed key without a request', async () => {
    const fetchImpl = fetchWithHealth(bundle);
    await expect(client(fetchImpl).surveyBundle('nope')).rejects.toThrow(/malformed survey key/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('responsesByTx', () => {
  it('decodes and unwraps the response list', async () => {
    const fetchImpl = fetchWithHealth({
      responses: [
        { surveyKey: KEY_A, responseIndex: 0, role: 0, credential: `key:${'c'.repeat(56)}`, slot: 5 },
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
    const fetchImpl = fetchWithHealth({ error: 'unknown survey' }, 404);
    await expect(client(fetchImpl).surveyBundle(KEY_A)).rejects.toThrow(/tessera request failed: 404/);
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
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://tessera.example.dev/health',
    ]);
  });

  it('checks /health once per client across data requests', async () => {
    const fetchImpl = fetchWithHealth(surveyPage);
    const c = client(fetchImpl);

    await c.surveyList();
    await c.surveyList();

    const urls = fetchImpl.mock.calls.map((call) => String(call[0]));
    expect(urls.filter((u) => u.endsWith('/health'))).toHaveLength(1);
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
