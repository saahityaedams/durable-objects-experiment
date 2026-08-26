import type { Route } from "./+types/api.seat-hold";
import { holdSeat, releaseHold } from "../../workers/lib/booking";
import { verifyAdmissionToken } from "../../workers/lib/admission-token";
import { cloudflareContext } from "../../workers/context";

export async function action({ request, params, context }: Route.ActionArgs) {
  const { eventId, seatId } = params;
  const { env } = context.get(cloudflareContext);

  if (request.method === "POST") {
    const body = (await request.json()) as { userId?: string; admissionToken?: string };
    if (!body.userId || !body.admissionToken) {
      return Response.json({ ok: false, reason: "bad_request" }, { status: 400 });
    }

    const payload = await verifyAdmissionToken(body.admissionToken, env.ADMISSION_TOKEN_SECRET);
    if (!payload || payload.eventId !== eventId || payload.userId !== body.userId) {
      return Response.json({ ok: false, reason: "not_admitted" }, { status: 403 });
    }

    const result = await holdSeat(env, eventId, seatId, body.userId);
    return Response.json(result, { status: result.ok ? 200 : 409 });
  }

  if (request.method === "DELETE") {
    const body = (await request.json()) as { userId?: string; holdId?: string };
    if (!body.userId || !body.holdId) {
      return Response.json({ ok: false }, { status: 400 });
    }
    await releaseHold(env, eventId, seatId, body.userId, body.holdId);
    return Response.json({ ok: true });
  }

  return new Response("Method not allowed", { status: 405 });
}
