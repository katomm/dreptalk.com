// Smoke test: verifies that D1 (DB) and KV (SESSIONS) bindings are available
// and functional in the Workers runtime pool. The migration must be applied
// by the global setup (test-setup.workers.ts) before this runs.
import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('D1 binding smoke test', () => {
  it('inserts and reads back a user row', async () => {
    const now = Date.now();
    const id = `smoke-test-${now}`;

    await env.DB
      .prepare(
        'INSERT INTO users (id, role, status, display_name, created_at, last_verified_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(id, 'member', 'active', 'Smoke Test User', now, now)
      .run();

    const row = await env.DB
      .prepare('SELECT id, display_name, role FROM users WHERE id = ?')
      .bind(id)
      .first<{ id: string; display_name: string; role: string }>();

    expect(row).not.toBeNull();
    expect(row!.id).toBe(id);
    expect(row!.display_name).toBe('Smoke Test User');
    expect(row!.role).toBe('member');
  });

  it('confirms the system seed row exists', async () => {
    const row = await env.DB
      .prepare('SELECT id, role FROM users WHERE id = ?')
      .bind('system')
      .first<{ id: string; role: string }>();

    expect(row).not.toBeNull();
    expect(row!.role).toBe('system');
  });
});

describe('KV binding smoke test', () => {
  it('puts and gets a key in SESSIONS', async () => {
    await env.SESSIONS.put('smoke-session-key', 'smoke-session-value');
    const val = await env.SESSIONS.get('smoke-session-key');
    expect(val).toBe('smoke-session-value');
  });
});
