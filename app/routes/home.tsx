import { Link, useLoaderData } from "react-router";
import { DEMO_EVENT_ID, DEMO_EVENT_NAME } from "../../workers/lib/config";

const REPO_URL = "https://github.com/saahityaedams/durable-objects-experiment";

export function meta() {
  return [
    { title: "Fair Concert Booking · Workers + Durable Objects" },
    {
      name: "description",
      content:
        "A fair, crowd-proof ticket sale on Cloudflare Workers and Durable Objects: a randomized waiting room, atomic seat holds and self-expiring holds.",
    },
  ];
}

/** Any event id works and gets its own queue and 64 seats, so a fresh one is a fresh sale. */
export function loader() {
  return { freshEventId: `sale-${crypto.randomUUID().slice(0, 8)}` };
}

const promises = [
  ["Arriving early doesn't help", "Everyone waiting when the doors open is put in a random order."],
  ["No seat is sold twice", "Each section's seats live in one Durable Object that handles one request at a time."],
  ["Nobody hoards", "One person can hold at most 3 seats at once, across every section."],
  ["Abandoned seats come back", "A hold that isn't paid for is released by an alarm, automatically."],
];

export default function Home() {
  const { freshEventId } = useLoaderData<typeof loader>();
  return (
    <main className="mx-auto max-w-2xl p-8">
      <p className="text-sm font-semibold uppercase tracking-wider text-orange-600">
        Cloudflare Workers + Durable Objects demo
      </p>
      <h1 className="mt-2 text-3xl font-bold">Fair Concert Booking</h1>
      <p className="mt-3 text-gray-600">
        A ticket sale built for the moment a crowd arrives at once: a virtual waiting room, one
        turn at a time on the seat map, and seats that can't be double-booked.
      </p>

      <ul className="mt-6 grid gap-3 sm:grid-cols-2">
        {promises.map(([title, body]) => (
          <li key={title} className="rounded border border-gray-200 p-3">
            <p className="font-semibold">{title}</p>
            <p className="text-sm text-gray-600">{body}</p>
          </li>
        ))}
      </ul>

      <div className="mt-8 flex flex-wrap gap-3">
        <Link
          to={`/event/${freshEventId}`}
          className="rounded bg-orange-600 px-4 py-2 font-semibold text-white hover:bg-orange-700"
        >
          Start your own sale →
        </Link>
        <Link
          to={`/event/${DEMO_EVENT_ID}`}
          className="rounded border border-orange-600 px-4 py-2 font-semibold text-orange-700 hover:bg-orange-50"
        >
          Join the shared sale: {DEMO_EVENT_NAME}
        </Link>
      </div>
      <p className="mt-3 text-sm text-gray-500">
        A new sale opens its doors 20 seconds after the first person arrives. Share its link or
        open it in a few private windows (each window is a different fan) and race each other for
        seats.
      </p>

      <p className="mt-8 text-sm text-gray-500">
        <a className="underline" href={REPO_URL}>
          Source code and demo video on GitHub
        </a>
      </p>
    </main>
  );
}
