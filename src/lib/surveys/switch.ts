/**
 * The one deploy switch for CIP-179 surveys: TESSERA_BACKEND_URL presence.
 * gov-sync is the only caller of the URL; the app reads presence alone, and
 * everything it gates hangs together on that reading — the category exists,
 * the answering panel renders and the record API accepts a row only where the
 * mirror runs, because the mirror is what settles or ages an answer. The two
 * deployment copies of the value (the app's preprod config and gov-sync's
 * preprod env) are held equal by deployVars.test.ts.
 */
export function surveysEnabled(env: Pick<Cloudflare.Env, 'TESSERA_BACKEND_URL'>): boolean {
  return Boolean(env.TESSERA_BACKEND_URL);
}
