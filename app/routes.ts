import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("event/:eventId", "routes/event.tsx"),
  route("event/:eventId/seats", "routes/event.seats.tsx"),
  route("event/:eventId/checkout", "routes/event.checkout.tsx"),

  route("api/events/:eventId/queue/ws", "routes/api.queue-ws.ts"),
  route("api/events/:eventId/queue/status", "routes/api.queue-status.ts"),
  route("api/events/:eventId/seats", "routes/api.seats.ts"),
  route("api/events/:eventId/seats/:seatId/hold", "routes/api.seat-hold.ts"),
  route("api/events/:eventId/checkout", "routes/api.checkout.ts"),
] satisfies RouteConfig;
