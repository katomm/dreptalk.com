/**
 * The one deploy switch for CIP-179 surveys: TESSERA_BACKEND_URL presence.
 * gov-sync is the only caller of the URL; the app reads presence alone, and
 * everything it gates hangs together on that reading, the category exists
 * and the answering panel renders only where the mirror runs, because the
 * mirror is what a page shows and what an answer comes back through. The two
 * deployment copies of the value (the app's and gov-sync's, per network) are
 * held equal by deployVars.test.ts.
 */
export function surveysEnabled(env: Pick<Cloudflare.Env, 'TESSERA_BACKEND_URL'>): boolean {
  return Boolean(env.TESSERA_BACKEND_URL);
}
