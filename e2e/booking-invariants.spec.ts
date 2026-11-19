import { test, expect } from "@playwright/test";
import {
  checkout,
  freshEventId,
  holdSeat,
  listSeats,
  newUserId,
  TEST_TIMINGS,
  waitForAdmission,
} from "./helpers";

test("no double-booking: 24 people racing for one seat, exactly one wins", async ({ request }, testInfo) => {
  const eventId = freshEventId(testInfo);
  const users = Array.from({ length: 24 }, newUserId);
  const tokens = await Promise.all(users.map((u) => waitForAdmission(request, eventId, u)));

  const attempts = await Promise.all(
    users.map((u, i) => holdSeat(request, eventId, "A-1-1", u, tokens[i]!)),
  );
  const winners = attempts.filter((a) => a.body.ok);
  expect(winners).toHaveLength(1);
  for (const loser of attempts.filter((a) => !a.body.ok)) {
    expect(loser.status).toBe(409);
    expect(loser.body.reason).toBe("unavailable");
  }

  // Everyone also tries to check out; only the hold owner can.
  const winnerIndex = attempts.findIndex((a) => a.body.ok);
  const holdId = winners[0]!.body.holdId!;
  const checkouts = await Promise.all(
    users.map((u) => checkout(request, eventId, "A-1-1", u, holdId)),
  );
  expect(checkouts.filter((c) => c.body.ok)).toHaveLength(1);
  expect(checkouts[winnerIndex]!.body.ok).toBe(true);

  const seat = (await listSeats(request, eventId)).find((s) => s.seat_id === "A-1-1");
  expect(seat?.status).toBe("booked");
});

test("no double-booking across the whole venue under a stampede", async ({ request }, testInfo) => {
  const eventId = freshEventId(testInfo);
  const users = Array.from({ length: 40 }, newUserId);
  const tokens = await Promise.all(users.map((u) => waitForAdmission(request, eventId, u)));

  // Everyone grabs 3 random seats from the same 16-seat block at once.
  const block = Array.from({ length: 16 }, (_, i) => `A-${Math.floor(i / 8) + 1}-${(i % 8) + 1}`);
  const results = await Promise.all(
    users.flatMap((u, i) =>
      [0, 1, 2].map(async () => {
        const seatId = block[Math.floor(Math.random() * block.length)]!;
        const r = await holdSeat(request, eventId, seatId, u, tokens[i]!);
        return { user: u, seatId, ...r };
      }),
    ),
  );

  const holders = new Map<string, Set<string>>();
  for (const r of results.filter((r) => r.body.ok)) {
    (holders.get(r.seatId) ?? holders.set(r.seatId, new Set()).get(r.seatId)!).add(r.user);
  }
  for (const [seatId, who] of holders) {
    expect(who.size, `${seatId} held by more than one person`).toBe(1);
  }
  // Nobody tries more than 3 seats, so nobody hits the limit: every seat
  // someone asked for went to exactly one of them.
  expect(holders.size).toBe(new Set(results.map((r) => r.seatId)).size);

  const held = (await listSeats(request, eventId)).filter((s) => s.status === "held");
  expect(held.map((s) => s.seat_id).sort()).toEqual([...holders.keys()].sort());
});

test("one person can hold at most 3 seats; re-picking a held seat is fine", async ({ request }, testInfo) => {
  const eventId = freshEventId(testInfo);
  const user = newUserId();
  const token = await waitForAdmission(request, eventId, user);

  // Spread across both sections: the limit is enforced across seat shards.
  for (const seatId of ["A-1-1", "B-1-1", "A-1-2"]) {
    expect((await holdSeat(request, eventId, seatId, user, token)).body.ok).toBe(true);
  }
  const fourth = await holdSeat(request, eventId, "B-1-2", user, token);
  expect(fourth.status).toBe(409);
  expect(fourth.body.reason).toBe("too_many_holds");

  const again = await holdSeat(request, eventId, "B-1-1", user, token);
  expect(again.body.ok).toBe(true);

  const mine = (await listSeats(request, eventId, user)).filter((s) => s.isMine);
  expect(mine.map((s) => s.seat_id).sort()).toEqual(["A-1-1", "A-1-2", "B-1-1"]);
});

test("the hold limit can't be beaten with parallel requests", async ({ request }, testInfo) => {
  const eventId = freshEventId(testInfo);
  const user = newUserId();
  const token = await waitForAdmission(request, eventId, user);

  const seats = ["A-1-1", "A-1-2", "A-1-3", "A-1-4", "B-1-1", "B-1-2", "B-1-3", "B-1-4"];
  const results = await Promise.all(seats.map((s) => holdSeat(request, eventId, s, user, token)));
  expect(results.filter((r) => r.body.ok)).toHaveLength(3);
  expect((await listSeats(request, eventId, user)).filter((s) => s.isMine)).toHaveLength(3);
});

test("an abandoned hold returns to the pool and frees the holder's slot", async ({ request }, testInfo) => {
  const eventId = freshEventId(testInfo);
  const alice = newUserId();
  const bob = newUserId();
  const [aliceToken, bobToken] = await Promise.all([
    waitForAdmission(request, eventId, alice),
    waitForAdmission(request, eventId, bob),
  ]);

  for (const seatId of ["A-3-1", "A-3-2", "B-3-1"]) {
    expect((await holdSeat(request, eventId, seatId, alice, aliceToken)).body.ok).toBe(true);
  }
  expect((await holdSeat(request, eventId, "A-3-1", bob, bobToken)).body.ok).toBe(false);

  // The SeatShard alarm sweeps the hold once it expires.
  await expect
    .poll(async () => (await listSeats(request, eventId)).find((s) => s.seat_id === "A-3-1")?.status, {
      timeout: TEST_TIMINGS.HOLD_DURATION_MS + 5_000,
    })
    .toBe("available");

  expect((await holdSeat(request, eventId, "A-3-1", bob, bobToken)).body.ok).toBe(true);

  // Alice's admission outlives her holds here, so she can pick again: her
  // per-person slots were released along with the seats.
  const fresh = await waitForAdmission(request, eventId, alice);
  expect((await holdSeat(request, eventId, "B-4-1", alice, fresh)).body.ok).toBe(true);
});

test("an expired hold can't be checked out", async ({ request }, testInfo) => {
  const eventId = freshEventId(testInfo);
  const user = newUserId();
  const token = await waitForAdmission(request, eventId, user);
  const { body } = await holdSeat(request, eventId, "B-2-2", user, token);
  expect(body.ok).toBe(true);

  await new Promise((r) => setTimeout(r, TEST_TIMINGS.HOLD_DURATION_MS + 500));
  const result = await checkout(request, eventId, "B-2-2", user, body.holdId!);
  expect(result.status).toBe(409);
  expect(result.body.ok).toBe(false);
});

test("holding a seat requires a valid admission token for that visitor", async ({ request }, testInfo) => {
  const eventId = freshEventId(testInfo);
  const alice = newUserId();
  const mallory = newUserId();
  const token = await waitForAdmission(request, eventId, alice);

  const stolen = await holdSeat(request, eventId, "A-1-1", mallory, token);
  expect(stolen.status).toBe(403);
  expect(stolen.body.reason).toBe("not_admitted");

  const forged = await holdSeat(request, eventId, "A-1-1", alice, token.slice(0, -2) + "xx");
  expect(forged.status).toBe(403);

  const garbage = await holdSeat(request, eventId, "A-1-1", alice, "not-a-token");
  expect(garbage.status).toBe(403);
});

test("the public seat list never reveals who holds or booked a seat", async ({ request }, testInfo) => {
  const eventId = freshEventId(testInfo);
  const user = newUserId();
  const token = await waitForAdmission(request, eventId, user);
  const { body } = await holdSeat(request, eventId, "A-4-8", user, token);
  await checkout(request, eventId, "A-4-8", user, body.holdId!);
  await holdSeat(request, eventId, "B-4-8", user, token);

  const raw = await (await request.get(`/api/events/${eventId}/seats`)).text();
  expect(raw).not.toContain(user);
  const viewerRaw = await (await request.get(`/api/events/${eventId}/seats?userId=${newUserId()}`)).text();
  expect(viewerRaw).not.toContain(user);
});
