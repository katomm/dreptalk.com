import { describe, it, expect } from 'vitest';
import { secretsEqual } from './secretsEqual.js';

describe('secretsEqual', () => {
  it('accepts equal secrets', async () => {
    expect(await secretsEqual('hunter2-webhook-secret', 'hunter2-webhook-secret')).toBe(true);
  });

  it('rejects differing secrets, including prefix matches and length differences', async () => {
    expect(await secretsEqual('hunter2-webhook-secret', 'hunter2-webhook-secreX')).toBe(false);
    expect(await secretsEqual('hunter2', 'hunter2-webhook-secret')).toBe(false);
    expect(await secretsEqual('', 'hunter2')).toBe(false);
  });

  it('accepts empty equals empty (callers must reject unset secrets themselves)', async () => {
    expect(await secretsEqual('', '')).toBe(true);
  });
});
