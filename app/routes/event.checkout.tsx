import { useEffect, useState } from "react";
import { Link, useLoaderData, useNavigate, useParams, useSearchParams } from "react-router";
import type { Route } from "./+types/event.checkout";
import { listSeats } from "../../workers/lib/booking";
import { cloudflareContext } from "../../workers/context";
import { EventHeader } from "../components/event-header";
import { formatClock, useCountdown } from "../lib/countdown";
import { describeSeat, type SeatInfo } from "../lib/seats";
import { getOrCreateUserId } from "../lib/user-id";

const HOME_AFTER_BOOKING_S = 5;

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const seatId = new URL(request.url).searchParams.get("seatId");
  if (!seatId) return { seat: null };
  const seats: SeatInfo[] = await listSeats(context.get(cloudflareContext).env, params.eventId);
  return { seat: seats.find((s) => s.seat_id === seatId) ?? null };
}

type Status = "idle" | "paying" | "done" | "expired" | "failed";

export default function EventCheckout() {
  const { eventId } = useParams();
  const { seat } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const holdId = searchParams.get("holdId");
  // "expired" is terminal (the hold is gone); "failed" is retryable.
  const [status, setStatus] = useState<Status>(seat?.status === "held" ? "idle" : "expired");
  const [secondsToHome, setSecondsToHome] = useState(HOME_AFTER_BOOKING_S);
  const holdLeft = useCountdown(seat?.hold_expires_at);

  // The hold ran out while we were looking at it.
  useEffect(() => {
    if (holdLeft === 0 && (status === "idle" || status === "failed")) setStatus("expired");
  }, [holdLeft, status]);

  // After booking, count down and go home. Replace, so Back doesn't return
  // to a checkout page for a seat that's already paid for.
  useEffect(() => {
    if (status !== "done") return;
    if (secondsToHome <= 0) {
      navigate("/", { replace: true });
      return;
    }
    const timer = setTimeout(() => setSecondsToHome((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [status, secondsToHome, navigate]);

  async function pay() {
    if (!seat) return;
    setStatus("paying");
    try {
      const res = await fetch(`/api/events/${eventId}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: getOrCreateUserId(), seatId: seat.seat_id, holdId }),
      });
      const data = (await res.json().catch(() => null)) as { ok: boolean } | null;
      if (data?.ok) setStatus("done");
      else setStatus(res.status === 409 ? "expired" : "failed");
    } catch {
      setStatus("failed");
    }
  }

  if (!seat || !holdId) {
    return (
      <main className="mx-auto max-w-xl p-8">
        <EventHeader />
        <h1 className="condensed mt-8 text-4xl font-bold">No seat selected</h1>
        <p className="mt-2 text-muted">Pick a seat on the seat map first.</p>
        <Link to={`/event/${eventId}`} className="mt-6 inline-block font-semibold text-open underline">
          Go to the seat map
        </Link>
      </main>
    );
  }

  const name = describeSeat(seat);
  const holding = status === "idle" || status === "paying" || status === "failed";

  return (
    <main className="mx-auto max-w-xl p-8">
      <EventHeader>
        {holding && holdLeft !== null && (
          <p className="tabular text-sm">
            <span className="text-muted">Held for </span>
            <span className="font-bold">{formatClock(holdLeft)}</span>
          </p>
        )}
      </EventHeader>

      <h1 className="condensed mt-8 text-4xl font-bold">{name}</h1>
      <p className="tabular mt-1 text-xl">${seat.price}</p>

      {status === "done" ? (
        <div role="status" className="mt-6 rounded-md bg-green-50 p-4 text-green-900">
          <p className="font-semibold">Booked: {name.charAt(0).toLowerCase() + name.slice(1)}.</p>
          <p className="mt-1 text-sm">
            Taking you home in {secondsToHome}s.{" "}
            <Link to="/" replace className="underline">
              Go now
            </Link>
          </p>
        </div>
      ) : status === "expired" ? (
        <div role="alert" className="mt-6 rounded-md bg-red-50 p-4 text-alert">
          Your hold ran out and the seat went back on sale.{" "}
          <Link to={`/event/${eventId}`} replace className="font-semibold underline">
            Back to the seat map
          </Link>
        </div>
      ) : (
        <>
          {status === "failed" && (
            <p role="alert" className="mt-6 rounded-md bg-red-50 p-3 text-alert">
              Payment didn't go through. The seat is still held, so you can try again.
            </p>
          )}
          <button
            type="button"
            onClick={pay}
            disabled={status === "paying"}
            className="mt-6 rounded-md bg-stage px-5 py-2.5 font-bold text-ink hover:bg-[#e47212] disabled:opacity-60"
          >
            {status === "paying" ? "Paying…" : `Pay $${seat.price}`}
          </button>
          <p className="mt-3 text-sm text-muted">Payment is simulated. No card needed.</p>
        </>
      )}
    </main>
  );
}
