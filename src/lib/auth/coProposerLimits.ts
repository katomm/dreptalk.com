// Client-safe co-proposer constants. Kept in their own module with no server
// imports so the redeem island (RedeemCoProposer.tsx) can import the name limit
// without pulling coProposerRedeem.ts's server graph (D1, KV, nonce, cose) into
// the client bundle, which fails to load in the browser and breaks hydration.

/** Maximum length of a co-proposer's chosen display name (trimmed). */
export const MAX_CO_PROPOSER_NAME = 60;
