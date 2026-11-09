import { describe, it, expect, vi } from 'vitest';
import { createKoiosClient } from './client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function make(fetchImpl: ReturnType<typeof vi.fn>) {
  return createKoiosClient({ baseUrl: 'https://x/api/v1', fetchImpl: fetchImpl as unknown as typeof fetch });
}

const REG_TAIL =
  'action=in.(registered,deregistered)&select=drep_id,action,block_time,update_tx_hash,cert_index&order=block_time.asc,update_tx_hash.asc,cert_index.asc';

describe('koios group reads', () => {
  it('txByMetalabel requests the label after a block height', async () => {
    const rows = [{ tx_hash: 'a', block_hash: 'b', block_height: 101 }];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(rows));
    expect(await make(fetchImpl).txByMetalabel(8416, 100, 1000, 0)).toEqual(rows);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://x/api/v1/tx_by_metalabel?_label=8416&_after_block_height=100&limit=1000&offset=0',
    );
  });

  it('txCborBatch posts the hashes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ tx_hash: 'a', cbor: '84' }]));
    expect(await make(fetchImpl).txCborBatch(['a'])).toEqual([{ tx_hash: 'a', cbor: '84' }]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://x/api/v1/tx_cbor');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ _tx_hashes: ['a'] });
  });

  it('txPositionBatch posts tx_info with every flag off', async () => {
    const row = { tx_hash: 'a', block_hash: 'b', block_height: 5, tx_block_index: 2 };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([row]));
    expect(await make(fetchImpl).txPositionBatch(['a'])).toEqual([row]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://x/api/v1/tx_info');
    expect(JSON.parse(init.body)).toEqual({
      _tx_hashes: ['a'],
      _inputs: false,
      _metadata: false,
      _assets: false,
      _withdrawals: false,
      _certs: false,
      _scripts: false,
      _bytecode: false,
    });
  });

  it('txCborBatch chunks by 25 and halves on a 413', async () => {
    const hashes = Array.from({ length: 30 }, (_, i) => `h${i}`);
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      const sent: string[] = JSON.parse(init.body)._tx_hashes;
      if (sent.length > 10) return new Response('', { status: 413 });
      return jsonResponse(sent.map((h) => ({ tx_hash: h, cbor: 'c' })));
    });
    const rows = await make(fetchImpl as never).txCborBatch(hashes);
    expect(rows.map((r) => r.tx_hash).sort()).toEqual([...hashes].sort());
    expect(JSON.parse((fetchImpl.mock.calls[0][1] as { body: string }).body)._tx_hashes).toHaveLength(25);
  });

  it('txCborBatch and txPositionBatch skip the request for empty input', async () => {
    const fetchImpl = vi.fn();
    const koios = make(fetchImpl);
    expect(await koios.txCborBatch([])).toEqual([]);
    expect(await koios.txPositionBatch([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('registration reads build the expected URLs', async () => {
    const row = { drep_id: 'drep1x', action: 'registered', block_time: 9, update_tx_hash: 't', cert_index: 0 };
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse([row]));
    const koios = make(fetchImpl);
    expect(await koios.drepRegistrationsSince(9, 1000, 0)).toEqual([row]);
    await koios.drepRegistrationsForMany(['drep1x', 'drep1y'], 1000, 0);
    await koios.drepRegistrationsFor('drep1x', 1000, 1000);
    const urls = fetchImpl.mock.calls.map((c) => c[0]);
    expect(urls[0]).toBe(`https://x/api/v1/drep_updates?block_time=gte.9&${REG_TAIL}&limit=1000&offset=0`);
    expect(urls[1]).toBe(`https://x/api/v1/drep_updates?drep_id=in.(drep1x,drep1y)&${REG_TAIL}&limit=1000&offset=0`);
    expect(urls[2]).toBe(`https://x/api/v1/drep_updates?drep_id=eq.drep1x&${REG_TAIL}&limit=1000&offset=1000`);
  });

  it('blockAt returns the block or null', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ hash: 'hh', block_time: 3 }]))
      .mockResolvedValueOnce(jsonResponse([]));
    const koios = make(fetchImpl);
    expect(await koios.blockAt(7)).toEqual({ hash: 'hh', block_time: 3 });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://x/api/v1/blocks?block_height=eq.7&select=hash,block_time');
    expect(await koios.blockAt(8)).toBeNull();
  });

  it('knownDrepIds returns the ids drep_info lists, also when detached', async () => {
    const row = {
      drep_id: 'drep1a',
      hex: null,
      has_script: false,
      drep_status: 'retired',
      deposit: null,
      active: false,
      expires_epoch_no: null,
      amount: null,
      meta_url: null,
      meta_hash: null,
      registered: false,
    };
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse([row]));
    const { knownDrepIds } = make(fetchImpl);
    expect(await knownDrepIds(['drep1a', 'drep1b'])).toEqual(new Set(['drep1a']));
    fetchImpl.mockClear();
    expect(await knownDrepIds([])).toEqual(new Set());
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
