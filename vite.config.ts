import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => {
  // The Playwright suite sets E2E_TIMINGS (JSON) to shorten the queue and hold
  // timers; see playwright.config.ts. Only honoured by the dev server, so a
  // production build can never pick up test timings.
  const e2eTimings =
    command === "serve" && process.env.E2E_TIMINGS
      ? (JSON.parse(process.env.E2E_TIMINGS) as Record<string, string>)
      : null;

  return {
    plugins: [
      cloudflare({
        viteEnvironment: { name: "ssr" },
        ...(e2eTimings && {
          config: (config) => ({ vars: { ...config.vars, ...e2eTimings } }),
        }),
      }),
      tailwindcss(),
      reactRouter(),
    ],
    resolve: {
      tsconfigPaths: true,
    },
  };
});
