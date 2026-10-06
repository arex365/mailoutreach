import { footerHtml, footerText } from "@/core/templates/html";

/**
 * Settings › Email footer (M3-DESIGN §2.1, §5.6): the rules for the four fields and the live preview.
 * Pure and browser-safe (the Server Action uses the same checks).
 */

export type FooterValues = {
  companyName: string;
  address: string;
  unsubscribeText: string;
  portfolioUrl: string;
};

export type FooterFieldErrors = Partial<Record<keyof FooterValues, string>>;

/** A full https:// link with a host. */
function isHttpsUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && Boolean(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
}

/**
 * Company name 1–100 characters; address 1–200 on one line; unsubscribe line 1–150 without "%"
 * (Mailgun fills in %unsubscribe_url% itself, a stray % would confuse it); portfolio link https://.
 * Values come back trimmed (spaces inside the one-line fields collapsed).
 */
export function validateFooter(input: {
  companyName: unknown;
  address: unknown;
  unsubscribeText: unknown;
  portfolioUrl: unknown;
}): { ok: true; value: FooterValues } | { ok: false; errors: FooterFieldErrors } {
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const companyName = text(input.companyName).replace(/\s+/g, " ").trim();
  const rawAddress = text(input.address);
  const address = rawAddress.trim();
  const unsubscribeText = text(input.unsubscribeText).replace(/\s+/g, " ").trim();
  const portfolioUrl = text(input.portfolioUrl).trim();
  const errors: FooterFieldErrors = {};
  if (!companyName || companyName.length > 100) errors.companyName = "Enter the company name, up to 100 characters.";
  if (!address || address.length > 200 || /[\r\n]/.test(address)) {
    errors.address = "Enter the postal address on one line, up to 200 characters.";
  }
  if (!unsubscribeText || unsubscribeText.length > 150 || unsubscribeText.includes("%")) {
    errors.unsubscribeText = "Write the unsubscribe line, up to 150 characters, without a % sign.";
  }
  if (!isHttpsUrl(portfolioUrl) || portfolioUrl.length > 300) errors.portfolioUrl = "Enter the full link, starting with https://.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { companyName, address: address.replace(/\s+/g, " "), unsubscribeText, portfolioUrl } };
}

/** The footer as the preview shows it: "[unsubscribe link]" instead of Mailgun's personal link. */
export function footerPreview(v: Pick<FooterValues, "companyName" | "address" | "unsubscribeText">): { text: string; html: string } {
  const footer = { companyName: v.companyName, address: v.address, unsubscribeText: v.unsubscribeText };
  return { text: footerText(footer, "preview"), html: footerHtml(footer, "preview") };
}
