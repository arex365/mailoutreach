/**
 * Responses for the download links (CSV/Excel exports, problem rows). These are plain links
 * that open in the same tab, so when something goes wrong the answer must be a page a person
 * can use, never raw JSON:
 *  - signed out → to the sign-in page, which brings them back to where they were;
 *  - anything else → a small page that says what happened, with one button back.
 */

import { safeAppPath } from "@/core/safe-path";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** 303 to /login?next=<back>. `back` must be an app path like "/contacts?list=3". */
export function signInRedirect(back: string): Response {
  const next = safeAppPath(back) ?? "/contacts";
  return new Response(null, {
    status: 303,
    headers: { Location: `/login?next=${encodeURIComponent(next)}`, ...NO_STORE },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/**
 * A plain, dark page (the app's colours) with the message and one "Back to …" button.
 * Keeps the HTTP status so scripts still see the error.
 */
export function downloadErrorPage(input: {
  title: string;
  message: string;
  status: number;
  back: { href: string; label: string };
}): Response {
  const href = safeAppPath(input.back.href) ?? "/contacts";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f0f11; color: #ededf0;
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 32rem; margin: 1.5rem; padding: 1.5rem; border: 1px solid #2a2a30; border-radius: 0.75rem; background: #16161a; }
  h1 { margin: 0 0 0.5rem; font-size: 1.125rem; font-weight: 600; }
  p { margin: 0 0 1.25rem; color: #a3a3ad; }
  a { display: inline-block; padding: 0.5rem 0.875rem; border: 1px solid #3a3a42; border-radius: 0.5rem; color: #ededf0; text-decoration: none; }
  a:hover { background: #222228; }
  a:focus-visible { outline: 2px solid #ededf0; outline-offset: 2px; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(input.title)}</h1>
<p>${escapeHtml(input.message)}</p>
<a href="${escapeHtml(href)}">${escapeHtml(input.back.label)}</a>
</main>
</body>
</html>
`;
  return new Response(html, { status: input.status, headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE } });
}
