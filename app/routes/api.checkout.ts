import type { Route } from "./+types/api.checkout";
import { confirmBooking } from "../../workers/lib/booking";
import { cloudflareContext } from "../../workers/context";

export async function action({ request, params, context }: Route.ActionArgs) {
  const { eventId } = params;
  const { env } = context.get(cloudflareContext);

  const body = (await request.json()) as { userId?: string; seatId?: string; holdId?: string };
  if (!body.userId || !body.seatId || !body.holdId) {
    return Response.json({ ok: false }, { status: 400 });
  }

  const result = await confirmBooking(env, eventId, body.seatId, body.userId, body.holdId);
  return Response.json(result, { status: result.ok ? 200 : 409 });
}
