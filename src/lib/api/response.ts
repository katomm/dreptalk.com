// Shared helpers for API route handlers.

/**
 * Builds a JSON Response with the correct content-type header.
 * Optional extra headers are merged after content-type.
 */
export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

/**
 * Extracts the runtime environment bindings from Astro locals.
 * Returns an empty object when the runtime env is not present (e.g. during local dev).
 */
export function runtimeEnv(locals: App.Locals): Record<string, unknown> {
  return (locals.runtime?.env ?? {}) as Record<string, unknown>;
}
