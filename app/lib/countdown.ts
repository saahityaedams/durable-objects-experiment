import { useEffect, useState } from "react";

/**
 * Milliseconds until `endsAt`, ticking once a second. Null until mounted, so
 * server and client render the same thing.
 */
export function useCountdown(endsAt: number | null | undefined): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (now === null || !endsAt) return null;
  return Math.max(0, endsAt - now);
}

/** 192000 -> "3:12" */
export function formatClock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
