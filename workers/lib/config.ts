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

export const DEMO_EVENT_ID = "cf-live-2026";
export const DEMO_EVENT_NAME = "Cloudflare Live — Workers & Durable Objects Tour";

export function seatIdOf(section: string, row: number, number: number) {
  return `${section}-${row}-${number}`;
}

export function sectionOf(seatId: string) {
  const section = seatId.split("-")[0];
  if (!section) throw new Error(`Invalid seatId: ${seatId}`);
  return section;
}
