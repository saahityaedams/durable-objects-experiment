import { useEffect, useState } from "react";
import { Link, useLoaderData, useNavigate, useParams, useSearchParams } from "react-router";
import type { Route } from "./+types/event.seats";
import { listSeats } from "../../workers/lib/booking";
import { verifyAdmissionToken } from "../../workers/lib/admission-token";
import { MAX_HOLDS_PER_USER } from "../../workers/lib/config";
import { cloudflareContext } from "../../workers/context";
import { EventHeader } from "../components/event-header";
import { formatClock, useCountdown } from "../lib/countdown";
import { describeSeat, type SeatInfo } from "../lib/seats";
import { getOrCreateUserId } from "../lib/user-id";

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { eventId } = params;
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const { env } = context.get(cloudflareContext);

  let viewerId: string | undefined;
  let turnEndsAt: number | null = null;
  if (token) {
    const payload = await verifyAdmissionToken(token, env.ADMISSION_TOKEN_SECRET);
    if (payload && payload.eventId === eventId) {
      viewerId = payload.userId;
      turnEndsAt = payload.exp;
    }
  }

  const seats: SeatInfo[] = await listSeats(env, eventId, viewerId);
  return { seats, hasValidToken: Boolean(viewerId), turnEndsAt };
}

type SeatState = "open" | "held" | "sold" | "mine";

function stateOf(seat: SeatInfo): SeatState {
  if (seat.isMine) return "mine";
  if (seat.status === "booked") return "sold";
  if (seat.status === "held") return "held";
  return "open";
}

const STATE_LABEL: Record<SeatState, string> = {
  open: "open",
  held: "someone's holding it",
  sold: "sold",
  mine: "yours",
};

// Seat-back shape: rounded top, squarer bottom. States differ by shape as
// well as colour: filled, dashed outline, crossed out, filled in orange.
const SEAT_SHAPE =
  "condensed tabular flex items-center justify-center rounded-t-xl rounded-b-sm font-semibold";
const SEAT_STYLE: Record<SeatState, string> = {
  open: "bg-open text-white hover:bg-[#2a43a8]",
  held: "border-2 border-dashed border-taken text-muted",
  sold: "bg-taken text-muted",
  mine: "bg-stage text-ink",
};

function SeatSwatch({ state }: { state: SeatState }) {
  return (
    <span className={`${SEAT_SHAPE} ${SEAT_STYLE[state]} size-6 shrink-0 text-xs`} aria-hidden="true">
      {state === "sold" ? "✕" : ""}
    </span>
  );
}

function groupBySection(seats: SeatInfo[]) {
  const sections = new Map<string, SeatInfo[][]>();
  for (const seat of seats) {
    const rows = sections.get(seat.section) ?? [];
    (rows[seat.row - 1] ??= []).push(seat);
    sections.set(seat.section, rows);
  }
  return [...sections.entries()].map(([section, rows]) => ({
    section,
    price: rows[0]?.[0]?.price ?? 0,
    rows: rows.map((r) => [...r].sort((a, b) => a.number - b.number)),
  }));
}

export default function EventSeats() {
  const { eventId } = useParams();
  const { seats: initialSeats, hasValidToken, turnEndsAt } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [seats, setSeats] = useState(initialSeats);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const turnLeft = useCountdown(turnEndsAt);
  const turnOver = turnLeft === 0;

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

  // The user id lives in localStorage, so it's only read from handlers and
  // effects — never during render, which also runs on the server.
  async function refresh() {
    const res = await fetch(`/api/events/${eventId}/seats?userId=${getOrCreateUserId()}`);
    if (res.ok) {
      const data = (await res.json()) as { seats: SeatInfo[] };
      setSeats(data.seats);
    }
  }

  useEffect(() => {
    void refresh(); // pick up which seats are yours (the server render can't know)
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
        body: JSON.stringify({ userId: getOrCreateUserId(), admissionToken: token }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok: boolean;
        reason?: string;
        holdId?: string;
      } | null;
      if (data?.reason === "not_admitted" || (data?.reason === "bad_request" && !token)) {
        // Your turn ended (or never started): back to the line.
        sessionStorage.removeItem(`admission:${eventId}`);
        navigate(`/event/${eventId}`, { replace: true });
        return;
      }
      if (!res.ok || !data?.ok) {
        setError(
          data?.reason === "too_many_holds"
            ? `You can hold up to ${MAX_HOLDS_PER_USER} seats at once.`
            : data?.reason === "unavailable" || data?.reason === "already_booked"
              ? "Someone else just took that seat. Pick another."
              : "That seat couldn't be held. Try again.",
        );
        await refresh();
        return;
      }
      navigate(`/event/${eventId}/checkout?seatId=${seatId}&holdId=${data.holdId}`);
    } catch {
      setError("That seat couldn't be held. Check your connection and try again.");
    } finally {
      setPending(null);
    }
  }

  const sections = groupBySection(seats);
  const soldOut = seats.every((s) => s.status !== "available" && !(s.isMine && s.status === "held"));

  return (
    <main className="mx-auto max-w-xl p-4 sm:p-8">
      <EventHeader>
        {turnLeft !== null && (
          <p className="tabular text-sm">
            <span className="text-muted">Your turn </span>
            <span className="font-bold">{formatClock(turnLeft)}</span>
          </p>
        )}
      </EventHeader>

      <h1 className="condensed mt-6 text-4xl font-bold">Pick a seat</h1>
      <p className="mt-1 text-muted">Click a seat to hold it while you pay.</p>

      {turnOver && (
        <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-alert">
          Your turn ended.{" "}
          <Link to={`/event/${eventId}`} replace className="font-semibold underline">
            Rejoin the line
          </Link>
        </p>
      )}
      {error && (
        <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-alert">
          {error}
        </p>
      )}
      {soldOut && <p className="mt-4 text-lg font-semibold">Sold out. Every seat is taken.</p>}

      <div className="mt-6 max-w-lg overflow-x-auto">
        <div className="min-w-[19rem]">
          <div className="condensed mx-auto mb-6 w-4/5 rounded-b-[2.5rem] bg-ink py-2 text-center font-bold tracking-wide text-white">
            Stage
          </div>

          {sections.map(({ section, price, rows }) => (
            <section key={section} className="mt-5" aria-label={`Section ${section}, $${price} a seat`}>
              <div className="flex items-baseline justify-between">
                <h2 className="condensed text-2xl font-bold">Section {section}</h2>
                <p className="tabular font-semibold">${price}</p>
              </div>
              <div className="mt-2 grid grid-cols-[2.75rem_repeat(8,minmax(0,1fr))] gap-1 sm:gap-1.5">
                {rows.map((rowSeats, i) => (
                  <div key={i} className="contents">
                    <span className="condensed tabular self-center text-sm font-semibold text-muted">
                      Row {i + 1}
                    </span>
                    {rowSeats.map((seat) => {
                      const state = stateOf(seat);
                      const clickable = !turnOver && (state === "open" || (state === "mine" && seat.status === "held"));
                      return (
                        <button
                          key={seat.seat_id}
                          type="button"
                          data-seat={seat.seat_id}
                          data-status={seat.status}
                          data-mine={seat.isMine || undefined}
                          aria-label={`${describeSeat(seat)}, $${seat.price}, ${STATE_LABEL[state]}`}
                          disabled={!clickable || pending !== null}
                          onClick={() => selectSeat(seat.seat_id)}
                          className={`${SEAT_SHAPE} ${SEAT_STYLE[state]} aspect-square w-full text-sm disabled:cursor-not-allowed ${pending === seat.seat_id ? "opacity-60" : ""}`}
                        >
                          {state === "sold" ? "✕" : state === "mine" && seat.status === "booked" ? "✓" : seat.number}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>

      <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm">
        {(["open", "held", "sold", "mine"] as const).map((state) => (
          <li key={state} className="flex items-center gap-2">
            <SeatSwatch state={state} />
            {state === "open" ? "Open" : state === "held" ? "Someone's holding it" : state === "sold" ? "Sold" : "Yours"}
          </li>
        ))}
      </ul>
    </main>
  );
}
