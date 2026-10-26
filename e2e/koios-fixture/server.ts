// A stand-in for the Koios REST API, used by the mock tier of the end-to-end
// tests. The app's server routes read Koios directly, out of reach of
// Playwright's request interception, so the dev server is pointed here through
// KOIOS_BASE_URL instead. Each test posts a scenario first, the server answers
// from it, and every request it has no answer for is recorded as a miss.
//
// Runs with Node's built-in type stripping: `node e2e/koios-fixture/server.ts`.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface ScenarioUtxo {
  /** bech32 address the output sits at. */
  address: string;
  txHash: string;
  index: number;
  lovelace: string;
}

export interface Scenario {
  /** DRep ids (bech32) that drep_info reports as registered and active. Any other id gets no row. */
  activeDreps?: string[];
  /** account_info rows by stake address. An address left out gets no row. */
  accounts?: Record<string, Record<string, unknown>>;
  /** Outputs address_info reports. */
  utxos?: ScenarioUtxo[];
  /** Fields merged over the captured preprod epoch_params row. */
  protocolParams?: Record<string, unknown>;
  /** proposal_list rows by return address (stake address). An address left out has proposed nothing. */
  proposals?: Record<string, ScenarioProposal[]>;
}

export interface ScenarioProposal {
  /** `<tx hash>#<index>` of the action. */
  id: string;
  /** bech32 `gov_action1...` id. */
  proposalId: string;
  type: string;
}

interface Miss {
  method: string;
  path: string;
  body: string;
}

const PORT = Number(process.env.E2E_KOIOS_PORT ?? 4399);
const BASE_PARAMS = JSON.parse(readFileSync(new URL('./epoch-params.json', import.meta.url), 'utf8')) as Record<string, unknown>;

let scenario: Scenario = {};
let misses: Miss[] = [];

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function list(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function drepRow(drepId: string): Record<string, unknown> {
  return {
    drep_id: drepId,
    hex: '',
    has_script: false,
    deposit: '500000000',
    drep_status: 'registered',
    active: true,
    expires_epoch_no: Number(BASE_PARAMS.epoch_no) + 20,
    amount: '0',
    meta_url: null,
    meta_hash: null,
  };
}

function addressRows(addresses: string[]): Record<string, unknown>[] {
  return addresses.flatMap((address) => {
    const outputs = (scenario.utxos ?? []).filter((u) => u.address === address);
    if (outputs.length === 0) return [];
    const balance = outputs.reduce((sum, u) => sum + BigInt(u.lovelace), 0n);
    return [
      {
        address,
        balance: balance.toString(),
        stake_address: null,
        script_address: false,
        utxo_set: outputs.map((u) => ({
          tx_hash: u.txHash,
          tx_index: String(u.index),
          block_time: '1750000000',
          block_height: '1',
          value: u.lovelace,
          datum_hash: null,
          inline_datum: null,
          reference_script: null,
          asset_list: [],
        })),
      },
    ];
  });
}

function proposalRows(returnAddress: string): Record<string, unknown>[] {
  return (scenario.proposals?.[returnAddress] ?? []).map((p) => {
    const [txHash, index] = p.id.split('#');
    return {
      proposal_id: p.proposalId,
      proposal_tx_hash: txHash,
      proposal_index: Number(index),
      proposal_type: p.type,
      return_address: returnAddress,
    };
  });
}

// Answers for the Koios endpoints the app and the SDK call during the tested
// flows. Returns undefined for an endpoint without an answer.
function answer(method: string, endpoint: string, query: URLSearchParams, body: Record<string, unknown>): unknown {
  if (method === 'GET' && endpoint === 'epoch_params') return [{ ...BASE_PARAMS, ...scenario.protocolParams }];
  // The proposer login asks which actions a stake address returns deposits
  // to. Any other proposal_list query has no rows on this fixture chain.
  if (method === 'GET' && endpoint === 'proposal_list') {
    const filter = query.get('return_address');
    return filter?.startsWith('eq.') ? proposalRows(filter.slice(3)) : [];
  }
  if (method !== 'POST') return undefined;
  switch (endpoint) {
    case 'drep_info': {
      const active = new Set(scenario.activeDreps ?? []);
      return list(body, '_drep_ids').filter((id) => active.has(id)).map(drepRow);
    }
    case 'account_info':
      return list(body, '_stake_addresses').flatMap((addr) => {
        const row = scenario.accounts?.[addr];
        return row ? [{ stake_address: addr, delegated_pool: null, delegated_drep: null, total_balance: '0', ...row }] : [];
      });
    // Certificate history of a stake key. Test wallets have none on this
    // fixture chain, so the answer is empty for every address.
    case 'account_update_history':
      return [];
    case 'address_info':
      return addressRows(list(body, '_addresses'));
    default:
      return undefined;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const method = req.method ?? 'GET';
  const text = method === 'GET' ? '' : await readBody(req);

  if (url.pathname.startsWith('/__fixture/')) {
    const action = url.pathname.slice('/__fixture/'.length);
    if (action === 'scenario' && method === 'POST') {
      scenario = parseJson(text) as Scenario;
      misses = [];
      return send(res, 200, { ok: true });
    }
    if (action === 'misses') return send(res, 200, misses);
    return send(res, 404, { error: `unknown control path ${url.pathname}` });
  }

  const endpoint = url.pathname.replace(/^\/api\/v1\//, '');
  const result = answer(method, endpoint, url.searchParams, parseJson(text));
  if (result === undefined) {
    misses.push({ method, path: `${url.pathname}${url.search}`, body: text.slice(0, 500) });
    return send(res, 501, { error: `no fixture for ${method} ${url.pathname}` });
  }
  return send(res, 200, result);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`koios fixture listening on http://127.0.0.1:${PORT}`);
});
