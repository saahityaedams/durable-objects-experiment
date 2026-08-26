import type { Route } from "./+types/api.queue-ws";
import { cloudflareContext } from "../../workers/context";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { eventId } = params;
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId");
  if (!userId) return new Response("userId is required", { status: 400 });

  const { env } = context.get(cloudflareContext);
  const stub = env.QUEUE_ROOM.getByName(`${eventId}:queue`);

  const doUrl = new URL(request.url);
  doUrl.searchParams.set("eventId", eventId);
  doUrl.searchParams.set("userId", userId);

  return stub.fetch(new Request(doUrl.toString(), request));
}
