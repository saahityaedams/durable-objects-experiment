export const SECTIONS = [
  { name: "A", label: "Floor (A)", rows: 4, seatsPerRow: 8, price: 180 },
  { name: "B", label: "Balcony (B)", rows: 4, seatsPerRow: 8, price: 90 },
] as const;

export const MAX_HOLDS_PER_USER = 3;
export const HOLD_DURATION_MS = 4 * 60 * 1000;
export const QUEUE_WARMUP_MS = 20_000;
export const QUEUE_TICK_MS = 2_000;
export const QUEUE_BATCH_SIZE = 4;
export const ADMISSION_TOKEN_TTL_MS = 3 * 60 * 1000;

export interface Timings {
  queueWarmupMs: number;
  queueTickMs: number;
  queueBatchSize: number;
  admissionTtlMs: number;
  holdDurationMs: number;
}

/**
 * Timings with optional overrides from the environment. Production uses the
 * constants above; the Playwright suite shortens them (see playwright.config.ts)
 * so a full queue -> hold -> expiry cycle runs in seconds.
 */
export function timings(env: object): Timings {
  const vars = env as Record<string, unknown>;
  const num = (key: string, fallback: number) => {
    const value = Number(vars[key]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    queueWarmupMs: num("QUEUE_WARMUP_MS", QUEUE_WARMUP_MS),
    queueTickMs: num("QUEUE_TICK_MS", QUEUE_TICK_MS),
    queueBatchSize: num("QUEUE_BATCH_SIZE", QUEUE_BATCH_SIZE),
    admissionTtlMs: num("ADMISSION_TOKEN_TTL_MS", ADMISSION_TOKEN_TTL_MS),
    holdDurationMs: num("HOLD_DURATION_MS", HOLD_DURATION_MS),
  };
}

export const DEMO_EVENT_ID = "cf-live-2026";

export function seatIdOf(section: string, row: number, number: number) {
  return `${section}-${row}-${number}`;
}

export function sectionOf(seatId: string) {
  const section = seatId.split("-")[0];
  if (!section) throw new Error(`Invalid seatId: ${seatId}`);
  return section;
}
