/** Minimal assert helper for Bun-driven product unit tests. */

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
