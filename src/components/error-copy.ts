/**
 * Wording for the "page not found" and "something went wrong" screens (PLAN.md A6: say what went
 * wrong and what to do next; technical codes only behind "Details"). Pure and browser-safe.
 */

export type NextStep = { href: string; label: string };

export type NotFoundCopy = { title: string; description: string; next: NextStep };

/** What to say when a link leads nowhere, based on where it pointed. */
export function notFoundCopy(pathname: string | null | undefined): NotFoundCopy {
  const path = (pathname ?? "").toLowerCase();
  if (path === "/import" || path.startsWith("/import/")) {
    return {
      title: "This import doesn't exist any more.",
      description: "It may have been started over or cancelled, or the link is old. Anything already imported is still in Contacts.",
      next: { href: "/import", label: "Go to Import" },
    };
  }
  if (path === "/settings" || path.startsWith("/settings/")) {
    return {
      title: "This settings page doesn't exist.",
      description: "The link may be old or mistyped.",
      next: { href: "/settings", label: "Go to Settings" },
    };
  }
  // Everyone's home is the dashboard (M6-DESIGN §4.5).
  return {
    title: "This page doesn't exist.",
    description: "The link may be old or mistyped. Your companies and lists are all in Contacts.",
    next: { href: "/dashboard", label: "Go to the dashboard" },
  };
}

export const ERROR_SCREEN_COPY = {
  title: "Something went wrong on this page.",
  description:
    "Nothing you saved is lost. Try again in a moment. If it keeps happening, tell the Owner and include the code under Details.",
  retry: "Try again",
} as const;

/** The technical reference shown under "Details": the server's error code, or the message for browser-side errors. */
export function errorDetails(error: { digest?: string; message?: string } | null | undefined): string | null {
  if (!error) return null;
  if (error.digest) return `Error code: ${error.digest}`;
  const message = (error.message ?? "").trim();
  return message ? message.slice(0, 500) : null;
}
