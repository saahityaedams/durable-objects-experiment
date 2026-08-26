import { RouterContextProvider, createRequestHandler } from "react-router";
import { cloudflareContext } from "./context";

export { SeatShard } from "./durable-objects/seat-shard";
export { QueueRoom } from "./durable-objects/queue-room";
export { UserHold } from "./durable-objects/user-hold";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request, env, ctx) {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env, ctx });
    return requestHandler(request, context);
  },
} satisfies ExportedHandler<Env>;
