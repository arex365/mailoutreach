/**
 * Plain text → the minimal HTML part of an email (PLAN.md B6.3, SPEC §8): HTML-escaped, one <p> per
 * paragraph, <br> for single line breaks, <a href> for http(s) links. No styles, no images, no tracking.
 * Also the footer that ends every email (PLAN.md A7). Pure and browser-safe.
 */

import type { RenderPurpose } from "./types";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const URL_RE = /\bhttps?:\/\/[^\s<>"]+/gi;

/** Drops punctuation that ends a sentence rather than the link ("see https://x.com/a." → "https://x.com/a"). */
function trimUrl(url: string): string {
  let u = url;
  for (;;) {
    const last = u.charAt(u.length - 1);
    if (/[.,;:!?'"*]/.test(last)) {
      u = u.slice(0, -1);
      continue;
    }
    if (last === ")" && (u.match(/\)/g)?.length ?? 0) > (u.match(/\(/g)?.length ?? 0)) {
      u = u.slice(0, -1);
      continue;
    }
    if (last === "]" && (u.match(/\]/g)?.length ?? 0) > (u.match(/\[/g)?.length ?? 0)) {
      u = u.slice(0, -1);
      continue;
    }
    return u;
  }
}

/** Escapes one line of text and turns its http(s) links into <a href>. */
export function linkifyLine(line: string): string {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    if (!/^https?:\/\/[^/?#\s]+/i.test(url)) continue;
    const start = m.index ?? 0;
    out += escapeHtml(line.slice(last, start));
    const safe = escapeHtml(url);
    out += `<a href="${safe}">${safe}</a>`;
    last = start + url.length;
  }
  return out + escapeHtml(line.slice(last));
}

/** Plain text → <p>…</p> paragraphs (blank lines split paragraphs; single breaks become <br>). */
export function textToHtml(text: string): string {
  const norm = text.replace(/\r\n?/g, "\n").trim();
  if (!norm) return "";
  return norm
    .split(/\n[ \t]*\n(?:[ \t]*\n)*/)
    .map((para) => para.replace(/^\n+|\n+$/g, ""))
    .filter((para) => para.trim() !== "")
    .map((para) => `<p>${para.split("\n").map(linkifyLine).join("<br>\n")}</p>`)
    .join("\n");
}

// ───────────────────────── footer ─────────────────────────

export type FooterSettings = {
  /** Setting "footer.companyName", e.g. "Polygon Paradise". */
  companyName: string;
  /** Setting "footer.address". */
  address: string;
  /** Setting "footer.unsubscribeText", e.g. "If you'd rather not hear from us, unsubscribe here:". */
  unsubscribeText: string;
};

/** Mailgun replaces this with a personal unsubscribe link (B6.8). */
export const UNSUBSCRIBE_PLACEHOLDER = "%unsubscribe_url%";
/** What previews show instead of the link. */
export const UNSUBSCRIBE_PREVIEW_TEXT = "[unsubscribe link]";
/** The line above the footer. */
export const FOOTER_SEPARATOR = "--";

function footerParts(footer: FooterSettings): { identity: string; unsubscribe: string } {
  const identity = [footer.companyName, footer.address]
    .map((s) => (s ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" · ");
  const unsubscribe = (footer.unsubscribeText ?? "").replace(/\s+/g, " ").trim() || "Unsubscribe:";
  return { identity, unsubscribe };
}

/**
 * "--" / "Polygon Paradise · 55th Avenue, …" / "If you'd rather not hear from us, unsubscribe here: %unsubscribe_url%".
 * In previews the link reads "[unsubscribe link]".
 */
export function footerText(footer: FooterSettings, purpose: RenderPurpose): string {
  const { identity, unsubscribe } = footerParts(footer);
  const link = purpose === "send" ? UNSUBSCRIBE_PLACEHOLDER : UNSUBSCRIBE_PREVIEW_TEXT;
  return [FOOTER_SEPARATOR, identity, `${unsubscribe} ${link}`].filter(Boolean).join("\n");
}

/** The footer as one HTML paragraph; the unsubscribe link is a real <a> only when sending. */
export function footerHtml(footer: FooterSettings, purpose: RenderPurpose): string {
  const { identity, unsubscribe } = footerParts(footer);
  const link =
    purpose === "send"
      ? `<a href="${UNSUBSCRIBE_PLACEHOLDER}">${UNSUBSCRIBE_PLACEHOLDER}</a>`
      : escapeHtml(UNSUBSCRIBE_PREVIEW_TEXT);
  const lines = [FOOTER_SEPARATOR, identity ? escapeHtml(identity) : "", `${escapeHtml(unsubscribe)} ${link}`].filter(Boolean);
  return `<p>${lines.join("<br>\n")}</p>`;
}
