/// <reference types="@cloudflare/workers-types" />
// Wires the D1 usage signal (db/users.bumpLastSeen) to the session store's
// best-effort onCreate/onRenew callbacks. Fire-and-forget via waitUntil so it
// never blocks the response. Guards both the synchronous waitUntil call and the
// async D1 promise so a storage hiccup can never affect authentication and never
// surfaces as an unhandled-rejection Worker error.
import { waitUntil } from 'cloudflare:workers';
import { bumpLastSeen } from '../db/users.js';

export function sessionActivityHook(db: D1Database): (userId: string) => void {
  return (userId) => {
    try {
      waitUntil(bumpLastSeen(db, userId, Date.now()).catch(() => undefined));
    } catch {
      // Activity tracking must never affect authentication.
    }
  };
}
