/// <reference types="@cloudflare/workers-types" />
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DREP_SCRIPT_HEADER, drepIdFromKeyHash } from '../cardano/identity.js';
import { encodeBech32 } from '../crypto/bech32.js';
import { seedGroupKey } from './__fixtures__/seedGroupKey.js';
import { groupsForPolicyKey, sessionKeyHash } from './groupSigner.js';
import { isWriter } from './roles.js';

const KEY = 'ab'.repeat(28);
const keyDrep = drepIdFromKeyHash(new Uint8Array(28).fill(0xab));
const scriptDrep = encodeBech32('drep', Uint8Array.from([DREP_SCRIPT_HEADER, ...new Uint8Array(28).fill(0xab)]));

describe('groupsForPolicyKey', () => {
  it('finds active groups by control and by admission policy', async () => {
    await seedGroupKey(env.DB, { key: KEY, tag: 0x10 });
    await seedGroupKey(env.DB, { key: KEY, tag: 0x20, inAdmission: true });
    const refs = await groupsForPolicyKey(env.DB, KEY);
    expect(refs.map((r) => r.txHash).sort()).toEqual(['10'.repeat(32), '20'.repeat(32)]);
    expect(refs.every((r) => r.index === 0)).toBe(true);
  });

  it('ignores policies of dissolved groups and other keys', async () => {
    await seedGroupKey(env.DB, { key: KEY, tag: 0x30, status: 'dissolved' });
    await seedGroupKey(env.DB, { key: 'cd'.repeat(28), tag: 0x40 });
    expect(await groupsForPolicyKey(env.DB, KEY)).toEqual([]);
  });

  it('drops a group the key resigned from in every role that lists it', async () => {
    await seedGroupKey(env.DB, { key: KEY, tag: 0x50, resignedControl: true });
    await seedGroupKey(env.DB, { key: KEY, tag: 0x60, inAdmission: true, resignedAdmission: true });
    await seedGroupKey(env.DB, { key: KEY, tag: 0x70, inBoth: true, resignedControl: true, resignedAdmission: true });
    expect(await groupsForPolicyKey(env.DB, KEY)).toEqual([]);
  });

  it('keeps a group while one role still lists the key without a resignation', async () => {
    await seedGroupKey(env.DB, { key: KEY, tag: 0x50, inBoth: true, resignedAdmission: true });
    await seedGroupKey(env.DB, { key: KEY, tag: 0x60, inBoth: true, resignedControl: true });
    const refs = await groupsForPolicyKey(env.DB, KEY);
    expect(refs.map((r) => r.txHash).sort()).toEqual(['50'.repeat(32), '60'.repeat(32)]);
  });
});

describe('group signer roles', () => {
  it('gives a group signer no writer rights', () => {
    expect(isWriter(['group-signer'])).toBe(false);
  });

  it('returns the key hash for key DRep and group signer sessions only', () => {
    expect(sessionKeyHash({ id: 'u', roles: ['drep'], drepId: keyDrep })).toBe(KEY);
    expect(sessionKeyHash({ id: 'u', roles: ['group-signer'], drepId: keyDrep })).toBe(KEY);
    expect(sessionKeyHash({ id: 'u', roles: ['member'], drepId: keyDrep })).toBeNull();
    expect(sessionKeyHash({ id: 'u', roles: ['drep'], drepId: null })).toBeNull();
    expect(sessionKeyHash({ id: 'u', roles: ['drep'] })).toBeNull();
    expect(sessionKeyHash(null)).toBeNull();
    expect(sessionKeyHash({ id: 'u', roles: ['drep'], drepId: scriptDrep })).toBeNull();
  });
});
