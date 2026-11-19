import { Link, useLoaderData } from "react-router";
import { DEMO_EVENT_ID } from "../../workers/lib/config";

const REPO_URL = "https://github.com/saahityaedams/durable-objects-experiment";

export function meta() {
  return [
    { title: "Concert booking" },
    { name: "description", content: "A concert ticket sale on Cloudflare Workers and Durable Objects." },
  ];
}

/** Any event id works and gets its own queue and 64 seats, so a fresh one is a fresh sale. */
export function loader() {
  return { freshEventId: `sale-${crypto.randomUUID().slice(0, 8)}` };
}

export default function Home() {
  const { freshEventId } = useLoaderData<typeof loader>();
  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-3xl font-bold">Concert booking</h1>
      <p className="mt-3 text-gray-600">
        A ticket sale on Cloudflare Workers and Durable Objects. Wait in line, get a few minutes to
        pick your seats, then pay.
      </p>

      <div className="mt-6 flex flex-wrap gap-3">
        <Link
          to={`/event/${freshEventId}`}
          className="rounded bg-orange-600 px-4 py-2 font-semibold text-white hover:bg-orange-700"
        >
          Start a sale
        </Link>
        <Link
          to={`/event/${DEMO_EVENT_ID}`}
          className="rounded border border-gray-300 px-4 py-2 font-semibold text-gray-700 hover:bg-gray-50"
        >
          Join the shared sale
        </Link>
      </div>
      <p className="mt-3 text-sm text-gray-500">
        Doors open 20 seconds after the first person arrives. To try it with more than one person,
        open the link in a few private windows.
      </p>

      <p className="mt-10 text-sm">
        <a className="text-gray-500 underline" href={REPO_URL}>
          Source on GitHub
        </a>
      </p>
    </main>
  );
}
