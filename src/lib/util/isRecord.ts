/** True for a plain, non-array object, the shape JSON.parse gives for `{...}`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
