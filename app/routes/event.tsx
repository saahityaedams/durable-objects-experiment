import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { EventHeader } from "../components/event-header";
import { getOrCreateUserId } from "../lib/user-id";

interface QueueStatus {
  status: "waiting" | "admitted";
  saleOpensAt: number;
  waitingAhead: number | null;
  waitingTotal: number;
  admissionToken: string | null;
  admissionExpiresAt: number | null;
}

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
const MAX_DOTS = 24;

/** The line drawn left to right, front first, ending with you. */
function Line({ ahead }: { ahead: number }) {
  const shown = Math.min(ahead, MAX_DOTS);
  const hidden = ahead - shown;
  return (
    <div className="mt-6" aria-hidden="true">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="condensed mr-1 text-sm font-semibold text-muted">Front</span>
        {hidden > 0 && (
          <span className="tabular rounded-full bg-taken px-2 py-0.5 text-xs font-semibold">
            +{hidden}
          </span>
        )}
        {Array.from({ length: shown }, (_, i) => (
          <span key={i} className="size-3.5 rounded-full bg-open" />
        ))}
        <span className="condensed ml-1 rounded-full bg-stage px-3 py-1 text-sm font-bold">You</span>
      </div>
    </div>
  );
}

export default function EventQueue() {
  const { eventId } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Live updates over a WebSocket (the queue pushes on every tick), with a
  // slow poll as a fallback.
  useEffect(() => {
    if (!eventId) return;
    const userId = getOrCreateUserId();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${protocol}//${location.host}/api/events/${eventId}/queue/ws?userId=${userId}`,
    );
    ws.addEventListener("message", (event) => {
      setStatus(JSON.parse(event.data) as QueueStatus);
    });

    const poll = setInterval(async () => {
      const res = await fetch(`/api/events/${eventId}/queue/status?userId=${userId}`);
      if (res.ok) setStatus(await res.json());
    }, 4000);

    return () => {
      ws.close();
      clearInterval(poll);
    };
  }, [eventId]);

  useEffect(() => {
    if (status?.status !== "admitted" || !status.admissionToken) return;
    // Don't follow a token that is about to expire: the seat map would reject
    // it and send us straight back here. Keep polling until the queue re-queues
    // us instead.
    if (status.admissionExpiresAt !== null && status.admissionExpiresAt < Date.now() + 2000) return;
    // Replace, so Back from the seat map doesn't land here and bounce forward.
    navigate(`/event/${eventId}/seats?token=${encodeURIComponent(status.admissionToken)}`, {
      replace: true,
    });
  }, [status, eventId, navigate]);

  const secondsToOpen = status ? Math.max(0, Math.ceil((status.saleOpensAt - now) / 1000)) : 0;

  return (
    <main className="mx-auto max-w-xl p-8">
      <EventHeader />
      <h1 className="condensed mt-8 text-4xl font-bold">You're in line</h1>

      {!status ? (
        <p className="mt-3 text-muted">Joining the line…</p>
      ) : secondsToOpen > 0 ? (
        <>
          <p className="tabular mt-3 text-2xl font-semibold">Doors open in {secondsToOpen}s.</p>
          <p className="mt-2 text-muted">
            Everyone here when the doors open gets a random place in line, so there's no need to
            rush.
          </p>
          <p className="mt-6 text-sm text-muted">{people(status.waitingTotal)} waiting.</p>
        </>
      ) : status.waitingAhead === null ? (
        <p className="mt-3 text-2xl font-semibold">Drawing places in line…</p>
      ) : (
        <>
          <p className="tabular mt-3 text-2xl font-semibold" aria-live="polite">
            {status.waitingAhead === 0 ? "You're next." : `${people(status.waitingAhead)} ahead of you.`}
          </p>
          <Line ahead={status.waitingAhead} />
          <p className="mt-6 text-muted">
            You'll go to the seat map when it's your turn. Keep this tab open.
          </p>
        </>
      )}
    </main>
  );
}
