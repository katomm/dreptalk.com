import { describe, it, expect } from 'vitest';
import { buildHealthPayload } from './health';

describe('buildHealthPayload', () => {
  it('reports ok and the resolved network', () => {
    const payload = buildHealthPayload('preprod');
    expect(payload.status).toBe('ok');
    expect(payload.network).toBe('preprod');
  });

  it('defaults the network to mainnet when unset', () => {
    expect(buildHealthPayload(undefined).network).toBe('mainnet');
  });

  it('never leaks anything beyond status and network', () => {
    expect(Object.keys(buildHealthPayload('mainnet')).sort()).toEqual([
      'network',
      'status',
    ]);
  });
});
