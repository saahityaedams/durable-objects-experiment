import { test, expect, type Page } from "@playwright/test";
import { freshEventId, listSeats, TEST_TIMINGS } from "./helpers";

const seat = (page: Page, seatId: string) => page.locator(`button[title^="${seatId} ("]`);

/** Route sequence of the main frame, as "queue" / "seats" steps. */
function trackRoutes(page: Page) {
  const steps: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    const step = new URL(frame.url()).pathname.endsWith("/seats") ? "seats" : "queue";
    // One page load can fire several framenavigated events; count transitions.
    if (steps.at(-1) !== step) steps.push(step);
  });
  return steps;
}

test("a visitor queues, gets admitted, holds a seat and books it", async ({ page, request }, testInfo) => {
  const eventId = freshEventId(testInfo);
  await page.goto(`/event/${eventId}`);

  await expect(page.getByRole("heading", { name: "You're in line" })).toBeVisible();
  await expect(page.getByText(/Doors open in \d+s/)).toBeVisible();
  await expect(page.getByText("Your position will be assigned once doors open.")).toBeVisible();

  await page.waitForURL(`**/event/${eventId}/seats?token=*`, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Pick your seat" })).toBeVisible();
  await expect(page.locator("button[title$='(available)']")).toHaveCount(64);

  await seat(page, "A-2-3").click();
  await page.waitForURL(`**/event/${eventId}/checkout?seatId=A-2-3&holdId=*`);
  await page.getByRole("button", { name: "Confirm & Pay" }).click();
  await expect(page.getByText("Booked! Seat A-2-3 is confirmed.")).toBeVisible();

  const booked = (await listSeats(request, eventId)).find((s) => s.seat_id === "A-2-3");
  expect(booked?.status).toBe("booked");

  // A few seconds later you're sent home, and Back doesn't return to checkout.
  await expect(page.getByText(/Taking you home in \ds/)).toBeVisible();
  await page.waitForURL((url) => url.pathname === "/", { timeout: 8_000 });
  await expect(page.getByRole("heading", { name: "Concert booking" })).toBeVisible();
});

test("other visitors see a held seat as taken and cannot pick it", async ({ browser }, testInfo) => {
  const eventId = freshEventId(testInfo);
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();

  await Promise.all([alice.goto(`/event/${eventId}`), bob.goto(`/event/${eventId}`)]);
  await Promise.all([
    alice.waitForURL("**/seats?token=*", { timeout: 30_000 }),
    bob.waitForURL("**/seats?token=*", { timeout: 30_000 }),
  ]);

  await seat(alice, "B-1-1").click();
  await alice.waitForURL("**/checkout?*");

  // Bob's map polls every 3s; the seat flips to held and is disabled.
  await expect(seat(bob, "B-1-1")).toHaveAttribute("title", "B-1-1 (held)", { timeout: 8_000 });
  await expect(seat(bob, "B-1-1")).toBeDisabled();
});

test("refreshing the seat map keeps you on it", async ({ page }, testInfo) => {
  const eventId = freshEventId(testInfo);
  await page.goto(`/event/${eventId}`);
  await page.waitForURL("**/seats?token=*", { timeout: 30_000 });

  await page.reload();
  await expect(page.getByRole("heading", { name: "Pick your seat" })).toBeVisible();
  await expect(page).toHaveURL(/\/seats\?token=/);
});

test("Back from the seat map leaves the waiting room instead of bouncing forward", async ({ page }, testInfo) => {
  const eventId = freshEventId(testInfo);
  await page.goto("/");
  await page.goto(`/event/${eventId}`);
  await page.waitForURL("**/seats?token=*", { timeout: 30_000 });

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Concert booking" })).toBeVisible();
});

test("'Start a sale' opens a fresh event with its own countdown", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Start a sale" }).click();
  await expect(page).toHaveURL(/\/event\/sale-[0-9a-f]{8}$/);
  await expect(page.getByText(/Doors open in \d+s/)).toBeVisible();
  await expect(page.getByText("1 person currently waiting.")).toBeVisible();
});

/**
 * Regression: the queue used to hand an expired admission token back out. The
 * seat map rejected it and sent the visitor to the queue, which handed out the
 * same token again: an endless /event <-> /seats loop (hundreds of
 * navigations a minute in the dev logs).
 */
test("returning after your admission expired re-queues you instead of looping", async ({ page }, testInfo) => {
  const eventId = freshEventId(testInfo);
  await page.goto(`/event/${eventId}`);
  await page.waitForURL("**/seats?token=*", { timeout: 30_000 });
  const firstToken = new URL(page.url()).searchParams.get("token");

  await page.goto("/");
  await page.waitForTimeout(TEST_TIMINGS.ADMISSION_TOKEN_TTL_MS + 500);

  const routes = trackRoutes(page);
  await page.goto(`/event/${eventId}`);
  await page.waitForURL("**/seats?token=*", { timeout: 30_000 });
  await page.waitForTimeout(2_000);

  expect(new URL(page.url()).searchParams.get("token")).not.toBe(firstToken);
  expect(routes).toEqual(["queue", "seats"]);
  await expect(page.getByRole("heading", { name: "Pick your seat" })).toBeVisible();
});

test("opening the seat map with an expired token sends you back to queue once", async ({ page }, testInfo) => {
  const eventId = freshEventId(testInfo);
  await page.goto(`/event/${eventId}`);
  await page.waitForURL("**/seats?token=*", { timeout: 30_000 });
  const staleUrl = page.url();

  await page.goto("/");
  await page.waitForTimeout(TEST_TIMINGS.ADMISSION_TOKEN_TTL_MS + 500);

  const routes = trackRoutes(page);
  await page.goto(staleUrl);
  await page.waitForURL((url) => url.pathname.endsWith("/seats") && url.href !== staleUrl, {
    timeout: 30_000,
  });
  await page.waitForTimeout(2_000);
  expect(routes).toEqual(["seats", "queue", "seats"]);
});
