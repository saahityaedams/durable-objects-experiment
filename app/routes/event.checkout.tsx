import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";

const HOME_AFTER_BOOKING_S = 5;
import { getOrCreateUserId } from "../lib/user-id";

export default function EventCheckout() {
  const { eventId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const seatId = searchParams.get("seatId");
  const holdId = searchParams.get("holdId");
  // "expired" is terminal (the hold is gone); "failed" is retryable.
  const [status, setStatus] = useState<"idle" | "paying" | "done" | "expired" | "failed">("idle");
  const [secondsToHome, setSecondsToHome] = useState(HOME_AFTER_BOOKING_S);

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
    setStatus("paying");
    try {
      const userId = getOrCreateUserId();
      const res = await fetch(`/api/events/${eventId}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, seatId, holdId }),
      });
      const data = (await res.json().catch(() => null)) as { ok: boolean } | null;
      if (data?.ok) setStatus("done");
      else setStatus(res.status === 409 ? "expired" : "failed");
    } catch {
      setStatus("failed");
    }
  }

  if (!seatId || !holdId) {
    return (
      <main className="mx-auto max-w-xl p-8">
        <p>Missing seat selection.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl font-bold">Checkout</h1>
      <p className="mt-2">Seat {seatId} is held for you.</p>

      {status === "done" ? (
        <div className="mt-6 rounded bg-green-100 p-4 text-green-800">
          <p>Booked! Seat {seatId} is confirmed.</p>
          <p className="mt-1 text-sm">
            Taking you home in {secondsToHome}s.{" "}
            <Link to="/" replace className="underline">
              Go now
            </Link>
          </p>
        </div>
      ) : status === "expired" ? (
        <div className="mt-6 rounded bg-red-100 p-4 text-red-800">
          Your hold expired before payment completed.{" "}
          <button className="underline" onClick={() => navigate(`/event/${eventId}/seats`)}>
            Pick another seat
          </button>
          .
        </div>
      ) : (
        <>
          {status === "failed" && (
            <p className="mt-6 rounded bg-red-100 p-2 text-red-700">
              Payment didn't go through — your seat is still held, please try again.
            </p>
          )}
          <button
            onClick={pay}
            disabled={status === "paying"}
            className="mt-6 rounded bg-orange-600 px-4 py-2 font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
          >
            {status === "paying" ? "Processing…" : "Confirm & Pay"}
          </button>
        </>
      )}
    </main>
  );
}
