import type { SeatView } from "../durable-objects/seat-shard";
import { MAX_HOLDS_PER_USER, HOLD_DURATION_MS, SECTIONS, sectionOf } from "./config";

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
  const holdId = crypto.randomUUID();
  const expiresAt = Date.now() + HOLD_DURATION_MS;

  const userHold = userHoldFor(env, eventId, userId);
  const reserved = await userHold.tryReserve(holdId, seatId, expiresAt, MAX_HOLDS_PER_USER);
  if (!reserved.ok) return { ok: false, reason: "too_many_holds" };

  const seatResult = await shardFor(env, eventId, section).holdSeat(
    seatId,
    userId,
    holdId,
    HOLD_DURATION_MS,
  );

  if (!seatResult.ok) {
    await userHold.release(holdId);
    return { ok: false, reason: seatResult.reason ?? "unavailable" };
  }

  return { ok: true, holdId, expiresAt: seatResult.expiresAt! };
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
