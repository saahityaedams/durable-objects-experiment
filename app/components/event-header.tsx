import type { ReactNode } from "react";
import { Link } from "react-router";

/** Top of every event page: the show's name, and room for a status like the turn clock. */
export function EventHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="flex items-baseline justify-between gap-4 border-b border-taken pb-3">
      <Link to="/" className="condensed text-xl font-bold">
        Cloudflare Live
      </Link>
      {children}
    </header>
  );
}
