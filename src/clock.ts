const TEST_NOW_ENV = "NODE_WORKSPACE_TEST_NOW";

/**
 * Current time in milliseconds.
 *
 * The environment override exists only so tests can advance past a receipt
 * boundary without sleeping. It is not a configuration surface and never
 * changes a durability or ordering decision.
 */
export function nowMs(): number {
  const raw = process.env[TEST_NOW_ENV];
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

export function nowIso(): string {
  return new Date(nowMs()).toISOString();
}
