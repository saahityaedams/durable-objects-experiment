import { useEffect, useMemo, useState } from "react";
import { useLoaderData, useNavigate, useParams, useSearchParams } from "react-router";
import type { Route } from "./+types/event.seats";
import { listSeats } from "../../workers/lib/booking";
import { verifyAdmissionToken } from "../../workers/lib/admission-token";
import { cloudflareContext } from "../../workers/context";
import { getOrCreateUserId } from "../lib/user-id";

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { eventId } = params;
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const { env } = context.get(cloudflareContext);

  let viewerId: string | undefined;
  if (token) {
    const payload = await verifyAdmissionToken(token, env.ADMISSION_TOKEN_SECRET);
    if (payload && payload.eventId === eventId) viewerId = payload.userId;
  }

  const seats = await listSeats(env, eventId, viewerId);
  return { seats, hasValidToken: Boolean(viewerId) };
}

function groupBySection<T extends { section: string }>(items: T[]) {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    (groups[item.section] ??= []).push(item);
  }
  return groups;
}

export default function EventSeats() {
  const { eventId } = useParams();
  const { seats: initialSeats, hasValidToken } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [seats, setSeats] = useState(initialSeats);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const userId = useMemo(() => getOrCreateUserId(), []);

  const token =
    searchParams.get("token") ??
    (typeof window !== "undefined" ? sessionStorage.getItem(`admission:${eventId}`) : null);

  useEffect(() => {
    if (!hasValidToken) {
      navigate(`/event/${eventId}`, { replace: true });
      return;
    }
    if (token) sessionStorage.setItem(`admission:${eventId}`, token);
  }, [hasValidToken, token, eventId, navigate]);

  async function refresh() {
    const res = await fetch(`/api/events/${eventId}/seats?userId=${userId}`);
    if (res.ok) {
      const data = (await res.json()) as { seats: typeof initialSeats };
      setSeats(data.seats);
    }
  }

  useEffect(() => {
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  async function selectSeat(seatId: string) {
    setError(null);
    setPending(seatId);
    try {
      const res = await fetch(`/api/events/${eventId}/seats/${seatId}/hold`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, admissionToken: token }),
      });
      const data = (await res.json()) as { ok: boolean; reason?: string; holdId?: string };
      if (!res.ok || !data.ok) {
        setError(
          data.reason === "too_many_holds"
            ? "You already have the max number of seats on hold at once."
            : "That seat was just taken — pick another.",
        );
        await refresh();
        return;
      }
      navigate(`/event/${eventId}/checkout?seatId=${seatId}&holdId=${data.holdId}`);
    } finally {
      setPending(null);
    }
  }

  const bySection = groupBySection(seats);

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-bold">Pick your seat</h1>
      <p className="mt-1 text-sm text-gray-500">
        Seats refresh live. A held seat is locked for a few minutes — grab it and check
        out before the timer expires.
      </p>
      {error && <p className="mt-3 rounded bg-red-100 p-2 text-red-700">{error}</p>}

      {Object.entries(bySection).map(([section, sectionSeats]) => (
        <section key={section} className="mt-6">
          <h2 className="font-semibold">
            Section {section} — ${sectionSeats[0]?.price}
          </h2>
          <div className="mt-2 grid grid-cols-8 gap-2">
            {sectionSeats.map((seat) => {
              const disabled = seat.status === "booked" || (seat.status === "held" && !seat.isMine);
              const label = seat.isMine ? "held by you" : seat.status;
              return (
                <button
                  key={seat.seat_id}
                  disabled={disabled || pending === seat.seat_id}
                  onClick={() => selectSeat(seat.seat_id)}
                  title={`${seat.seat_id} (${label})`}
                  className={[
                    "rounded p-2 text-xs font-medium disabled:cursor-not-allowed",
                    seat.status === "booked" && "bg-gray-300 text-gray-500",
                    seat.status === "held" && seat.isMine && "bg-orange-200 text-orange-900",
                    seat.status === "held" && !seat.isMine && "bg-gray-200 text-gray-400",
                    seat.status === "available" && "bg-green-100 hover:bg-green-200",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {seat.row}-{seat.number}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </main>
  );
}
