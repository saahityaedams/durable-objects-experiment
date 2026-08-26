import type { Route } from "./+types/api.seats";
import { listSeats } from "../../workers/lib/booking";
import { cloudflareContext } from "../../workers/context";

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { eventId } = params;
  const url = new URL(request.url);
  const viewerId = url.searchParams.get("userId") ?? undefined;

  const seats = await listSeats(context.get(cloudflareContext).env, eventId, viewerId);
  return Response.json({ seats });
}
