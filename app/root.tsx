import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&display=swap",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const stack = import.meta.env.DEV && error instanceof Error ? error.stack : undefined;

  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="condensed text-3xl font-bold">
        {notFound ? "Page not found" : "Something went wrong"}
      </h1>
      <p className="mt-2 text-muted">
        {notFound
          ? "There's nothing at this address."
          : "The page hit an error. Going back home usually fixes it."}
      </p>
      <Link to="/" className="mt-6 inline-block font-semibold text-open underline">
        Go home
      </Link>
      {stack && (
        <pre className="mt-6 w-full overflow-x-auto text-xs">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
