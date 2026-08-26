import { Link } from "react-router";
import { DEMO_EVENT_ID, DEMO_EVENT_NAME } from "../../workers/lib/config";

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold">Fair Concert Booking Demo</h1>
      <p className="mt-3 text-gray-600">
        Built on Cloudflare Workers + Durable Objects: a virtual waiting room with a
        randomized lottery order, sharded per-section seat inventory with atomic
        holds, a cross-shard per-user hold limit, and alarm-driven hold expiry — no
        double-booking, no queue-jumping.
      </p>
      <Link
        to={`/event/${DEMO_EVENT_ID}`}
        className="mt-6 inline-block rounded bg-orange-600 px-4 py-2 font-semibold text-white hover:bg-orange-700"
      >
        {DEMO_EVENT_NAME} →
      </Link>
    </main>
  );
}
