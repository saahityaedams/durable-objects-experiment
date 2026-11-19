import { expect, type APIRequestContext, type TestInfo } from "@playwright/test";
import { TEST_TIMINGS } from "../playwright.config";

export { TEST_TIMINGS };

export interface QueueStatus {
  status: "waiting" | "admitted";
  saleOpensAt: number;
  waitingAhead: number | null;
  waitingTotal: number;
  admissionToken: string | null;
  admissionExpiresAt: number | null;
}

export interface Seat {
  seat_id: string;
  status: "available" | "held" | "booked";
  isMine: boolean;
  [key: string]: unknown;
}

/** A fresh event per test: its own queue, its own 64 seats. */
export function freshEventId(testInfo: TestInfo) {
  const slug = testInfo.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
  return `pw-${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function queueStatus(
  request: APIRequestContext,
  eventId: string,
  userId: string,
): Promise<QueueStatus> {
  const res = await request.get(`/api/events/${eventId}/queue/status?userId=${userId}`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}

/** Joins (or re-polls) the queue until admitted; returns the admission token. */
export async function waitForAdmission(
  request: APIRequestContext,
  eventId: string,
  userId: string,
  timeoutMs = 30_000,
): Promise<string> {
  let token: string | null = null;
  await expect
    .poll(
      async () => {
        const s = await queueStatus(request, eventId, userId);
        token = s.admissionToken;
        return s.status;
      },
      { timeout: timeoutMs, intervals: [200] },
    )
    .toBe("admitted");
  return token!;
}

export async function holdSeat(
  request: APIRequestContext,
  eventId: string,
  seatId: string,
  userId: string,
  admissionToken: string,
) {
  // The local dev server occasionally drops a connection when a stampede
  // test lands on top of the browser tests. Holding a seat you already hold
  // is idempotent, so retrying after a transport error is safe; real HTTP
  // responses are never retried.
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await request.post(`/api/events/${eventId}/seats/${seatId}/hold`, {
        data: { userId, admissionToken },
      });
      return { status: res.status(), body: (await res.json()) as { ok: boolean; reason?: string; holdId?: string } };
    } catch (err) {
      if (attempt >= 3 || !/ECONNRESET|socket hang up/.test(String(err))) throw err;
    }
  }
}

export async function checkout(
  request: APIRequestContext,
  eventId: string,
  seatId: string,
  userId: string,
  holdId: string,
) {
  const res = await request.post(`/api/events/${eventId}/checkout`, {
    data: { userId, seatId, holdId },
  });
  return { status: res.status(), body: (await res.json()) as { ok: boolean; reason?: string } };
}

export async function listSeats(request: APIRequestContext, eventId: string, userId?: string) {
  const qs = userId ? `?userId=${userId}` : "";
  const res = await request.get(`/api/events/${eventId}/seats${qs}`);
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { seats: Seat[] }).seats;
}

export const newUserId = () => crypto.randomUUID();

/** Decodes the (unverified) payload of an admission token. */
export function tokenPayload(token: string): { userId: string; exp: number } {
  const body = token.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(body, "base64").toString("utf8"));
}
