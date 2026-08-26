import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { getOrCreateUserId } from "../lib/user-id";

interface QueueStatus {
  status: "waiting" | "admitted";
  saleOpensAt: number;
  waitingAhead: number | null;
  waitingTotal: number;
  admissionToken: string | null;
  admissionExpiresAt: number | null;
}

export default function EventQueue() {
  const { eventId } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!eventId) return;
    const userId = getOrCreateUserId();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${protocol}//${location.host}/api/events/${eventId}/queue/ws?userId=${userId}`,
    );
    wsRef.current = ws;

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
    if (status?.status === "admitted" && status.admissionToken) {
      navigate(`/event/${eventId}/seats?token=${encodeURIComponent(status.admissionToken)}`);
    }
  }, [status, eventId, navigate]);

  if (!status) {
    return <main className="mx-auto max-w-xl p-8">Connecting to the waiting room…</main>;
  }

  const secondsToOpen = Math.max(0, Math.ceil((status.saleOpensAt - now) / 1000));

  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl font-bold">You're in line</h1>
      {secondsToOpen > 0 ? (
        <p className="mt-2 text-gray-600">
          Doors open in {secondsToOpen}s. Everyone who joins before then gets shuffled
          into a random order at open — arriving first doesn't help.
        </p>
      ) : (
        <p className="mt-2 text-gray-600">Doors are open — admitting people in small batches.</p>
      )}
      <div className="mt-6 rounded border p-4">
        <p className="text-lg">
          {status.waitingAhead === null
            ? "Your position will be assigned once doors open."
            : status.waitingAhead === 0
              ? "You're next!"
              : `${status.waitingAhead} people ahead of you.`}
        </p>
        <p className="text-sm text-gray-500">{status.waitingTotal} people currently waiting.</p>
      </div>
    </main>
  );
}
