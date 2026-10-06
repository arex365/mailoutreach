/**
 * Same-app paths only (PLAN.md B10). Used for the page to open after signing in (`?next=`) and for
 * notification links, so neither can ever send someone to another site.
 *
 * "Starts with / but not //" is not enough: browsers read "/\evil.com" and "/<tab>/evil.com" as
 * "//evil.com" (another site). So backslashes, whitespace and control characters are refused outright,
 * the URL parser then confirms the value stays on this site, and the normalised result is checked
 * again ("/.//evil.com" normalises to "//evil.com").
 *
 * Returns the normalised path + query + hash, or null. Pure: used by the web app, the worker and tests.
 */

const BASE = "http://app.invalid";

function hasUnsafeCharacter(s: string): boolean {
  if (s.includes("\\") || /\s/u.test(s)) return true;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

export function safeAppPath(value: unknown, maxLength = 2000): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s || s.length > maxLength) return null;
  if (s[0] !== "/" || s[1] === "/") return null;
  if (hasUnsafeCharacter(s)) return null;
  let url: URL;
  try {
    url = new URL(s, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  const path = url.pathname + url.search + url.hash;
  if (!path.startsWith("/") || path.startsWith("//") || path.length > maxLength) return null;
  return path;
}
