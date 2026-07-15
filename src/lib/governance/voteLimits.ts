// Shared input-contract limits for the vote endpoints and the batch UI, kept
// in one place so the API schemas, the rate limiter, and the client-side caps
// cannot drift apart.

// Max votes per multi-vote batch. Bounds the liveness IN() query and the
// record loop well below D1's 100-bound-params-per-query limit.
export const MAX_BATCH_VOTES = 50;

// The rationale hosting endpoint allows this many requests per window per IP.
export const RATIONALE_RATE_MAX = 10;
export const RATIONALE_RATE_WINDOW_SEC = 60;

// Each DISTINCT rationale text in a batch costs one hosting request
// (identical texts are hosted once, the store is content-addressed), so the
// batch UI caps distinct texts at the rate limit: a batch can never 429
// mid-hosting.
export const MAX_UNIQUE_BATCH_RATIONALES = RATIONALE_RATE_MAX;
