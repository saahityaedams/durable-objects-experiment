import type { SeatView } from "../durable-objects/seat-shard";
import { MAX_HOLDS_PER_USER, SECTIONS, sectionOf, timings } from "./config";

function shardFor(env: Env, eventId: string, section: string) {
  return env.SEAT_SHARD.getByName(`${eventId}:section:${section}`);
}

function userHoldFor(env: Env, eventId: string, userId: string) {
  return env.USER_HOLD.getByName(`${eventId}:user:${userId}`);
}

export async function ensureEventSeeded(env: Env, eventId: string): Promise<void> {
  await Promise.all(
    SECTIONS.map((section) =>
      shardFor(env, eventId, section.name).seed(
        eventId,
        section.name,
        section.rows,
        section.seatsPerRow,
        section.price,
      ),
    ),
  );
}

export async function listSeats(
  env: Env,
  eventId: string,
  viewerId?: string,
): Promise<SeatView[]> {
  await ensureEventSeeded(env, eventId);
  const bySection = await Promise.all(
    SECTIONS.map((section) => shardFor(env, eventId, section.name).listSeats(viewerId)),
  );
  return bySection.flat().sort((a, b) => a.section.localeCompare(b.section) || a.row - b.row || a.number - b.number);
}

export type HoldOutcome =
  | { ok: true; holdId: string; expiresAt: number }
  | { ok: false; reason: "too_many_holds" | "unavailable" | "not_found" | "already_booked" };

export async function holdSeat(
  env: Env,
  eventId: string,
  seatId: string,
  userId: string,
): Promise<HoldOutcome> {
  const section = sectionOf(seatId);
  const holdDurationMs = timings(env).holdDurationMs;
  const expiresAt = Date.now() + holdDurationMs;

  const userHold = userHoldFor(env, eventId, userId);
  const reserved = await userHold.tryReserve(
    crypto.randomUUID(),
    seatId,
    expiresAt,
    MAX_HOLDS_PER_USER,
  );
  if (!reserved.ok) return { ok: false, reason: "too_many_holds" };
  // Either the fresh id, or the id of a hold this user already has on the seat.
  const holdId = reserved.holdId;

  const shard = shardFor(env, eventId, section);
  let seatResult = await shard.holdSeat(seatId, userId, holdId, holdDurationMs);
  if (!seatResult.ok && seatResult.reason === "not_found") {
    // Inventory is created lazily on first read; a hold can arrive before
    // anyone has opened the seat map (e.g. right after a deploy). Seeding is
    // idempotent, so seed and retry once; a genuinely bad seat id still fails.
    await ensureEventSeeded(env, eventId);
    seatResult = await shard.holdSeat(seatId, userId, holdId, holdDurationMs);
  }

  if (!seatResult.ok) {
    await userHold.release(holdId);
    return { ok: false, reason: seatResult.reason ?? "unavailable" };
  }

  // The shard is the source of truth: if it already had this user's hold
  // under another id, drop the slot we just reserved and hand back its id.
  if (seatResult.holdId !== holdId) await userHold.release(holdId);

  return { ok: true, holdId: seatResult.holdId!, expiresAt: seatResult.expiresAt! };
}

export async function releaseHold(
  env: Env,
  eventId: string,
  seatId: string,
  userId: string,
  holdId: string,
): Promise<void> {
  const section = sectionOf(seatId);
  await shardFor(env, eventId, section).releaseHold(seatId, holdId);
  await userHoldFor(env, eventId, userId).release(holdId);
}

export type ConfirmOutcome = { ok: true } | { ok: false; reason: "unavailable" | "not_found" };

export async function confirmBooking(
  env: Env,
  eventId: string,
  seatId: string,
  userId: string,
  holdId: string,
): Promise<ConfirmOutcome> {
  const section = sectionOf(seatId);
  const result = await shardFor(env, eventId, section).confirmBooking(seatId, holdId, userId);
  if (!result.ok) return { ok: false, reason: result.reason === "not_found" ? "not_found" : "unavailable" };
  await userHoldFor(env, eventId, userId).release(holdId);
  return { ok: true };
}
