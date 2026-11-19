import { test, expect } from "@playwright/test";
import { freshEventId, newUserId, queueStatus, TEST_TIMINGS, tokenPayload } from "./helpers";

/**
 * Polls everyone until all are admitted and returns each person's admission
 * time, read from their token (exp = admitted_at + TTL). Poll timing can't be
 * used for ordering: one round of parallel polls can straddle an admission tick.
 */
async function admissionTimes(
  request: Parameters<typeof queueStatus>[0],
  eventId: string,
  users: string[],
) {
  const admittedAt = new Map<string, number>();
  const deadline = Date.now() + 30_000;
  while (admittedAt.size < users.length) {
    expect(Date.now(), "everyone should be admitted").toBeLessThan(deadline);
    const statuses = await Promise.all(users.map((u) => queueStatus(request, eventId, u)));
    statuses.forEach((s, i) => {
      if (s.status === "admitted" && !admittedAt.has(users[i]!)) {
        admittedAt.set(users[i]!, tokenPayload(s.admissionToken!).exp - TEST_TIMINGS.ADMISSION_TOKEN_TTL_MS);
      }
    });
    await new Promise((res) => setTimeout(res, TEST_TIMINGS.QUEUE_TICK_MS / 3));
  }
  return users.map((u) => admittedAt.get(u)!);
}

test("before doors open nobody has a position, and arriving first doesn't help", async ({ request }, testInfo) => {
  const eventId = freshEventId(testInfo);
  const users = Array.from({ length: 16 }, newUserId);
  for (const u of users) {
    const s = await queueStatus(request, eventId, u);
    expect(s.status).toBe("waiting");
    expect(s.waitingAhead).toBeNull();
    expect(s.saleOpensAt).toBeGreaterThan(Date.now());
  }

  const times = await admissionTimes(request, eventId, users);
  // Arrival order would admit them in join order. With 16 people in batches
  // of 4, a random shuffle does that by chance roughly 1 in 60 million.
  const sorted = [...times].sort((a, b) => a - b);
  expect(times).not.toEqual(sorted);
});

test("people who join after doors open are admitted in arrival order", async ({ request }, testInfo) => {
  const eventId = freshEventId(testInfo);
  // Open the doors with a crowd so the latecomers actually have to wait.
  const crowd = Array.from({ length: 12 }, newUserId);
  for (const u of crowd) await queueStatus(request, eventId, u);
  await expect
    .poll(async () => (await queueStatus(request, eventId, crowd[0]!)).saleOpensAt <= Date.now())
    .toBe(true);

  const latecomers = Array.from({ length: 12 }, newUserId);
  for (const u of latecomers) await queueStatus(request, eventId, u);

  const times = await admissionTimes(request, eventId, latecomers);
  const sorted = [...times].sort((a, b) => a - b);
  expect(times).toEqual(sorted);
});

test("an expired admission is re-queued with a fresh token, not handed out again", async ({ request }, testInfo) => {
  const eventId = freshEventId(testInfo);
  const user = newUserId();
  await expect.poll(async () => (await queueStatus(request, eventId, user)).status, { timeout: 30_000 }).toBe("admitted");
  const first = (await queueStatus(request, eventId, user)).admissionToken!;

  await new Promise((r) => setTimeout(r, TEST_TIMINGS.ADMISSION_TOKEN_TTL_MS + 500));
  const after = await queueStatus(request, eventId, user);
  if (after.status === "admitted") {
    // Re-admitted already (the queue is empty): it must be a new, live token.
    expect(after.admissionToken).not.toBe(first);
    expect(tokenPayload(after.admissionToken!).exp).toBeGreaterThan(Date.now());
  } else {
    expect(after.admissionToken).toBeNull();
  }

  await expect.poll(async () => (await queueStatus(request, eventId, user)).status).toBe("admitted");
  const second = (await queueStatus(request, eventId, user)).admissionToken!;
  expect(second).not.toBe(first);
  expect(tokenPayload(second).exp).toBeGreaterThan(Date.now());
});
