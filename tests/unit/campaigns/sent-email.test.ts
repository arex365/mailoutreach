import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SentEmail, sentEmailParts } from "@/components/campaigns/sent-email";
import { renderEmail } from "@/core/templates/email";
import { UNSUBSCRIBE_PLACEHOLDER, UNSUBSCRIBE_PREVIEW_TEXT } from "@/core/templates/html";

const footer = { companyName: "Polygon Paradise", address: "Lahore", unsubscribeText: "If you'd rather not hear from us, unsubscribe here:" };

describe("the person panel's sent email", () => {
  it("shows [unsubscribe link] where the stored email has Mailgun's placeholder, in the muted footer", () => {
    // What the sending loop stores for a LIVE or TEST email (purpose "send").
    const stored = `Hi Anna,\n\nI loved your latest project.\n\nArslan\n\n--\nPolygon Paradise · Lahore\nIf you'd rather not hear from us, unsubscribe here: ${UNSUBSCRIBE_PLACEHOLDER}`;
    const parts = sentEmailParts(stored);
    expect(parts.main).toBe("Hi Anna,\n\nI loved your latest project.\n\nArslan");
    expect(parts.footer).toBe(`--\nPolygon Paradise · Lahore\nIf you'd rather not hear from us, unsubscribe here: ${UNSUBSCRIBE_PREVIEW_TEXT}`);

    const out = renderToStaticMarkup(createElement(SentEmail, { subject: "Hello", text: stored }));
    expect(out).not.toContain(UNSUBSCRIBE_PLACEHOLDER);
    expect(out).toContain("[unsubscribe link]");
  });

  it("reads exactly like the preview of the same email", () => {
    const input = { step: 0, subject: "Hello", body: "Hi {first_name},\n\nA short note.", personId: 1, values: { first_name: "Anna" }, footer };
    const sent = renderEmail({ ...input, purpose: "send" });
    const preview = renderEmail({ ...input, purpose: "preview" });
    expect(sent.text).toContain(UNSUBSCRIBE_PLACEHOLDER);
    const shown = sentEmailParts(sent.text);
    expect(`${shown.main}\n\n${shown.footer}`).toBe(preview.text);
  });

  it("leaves an email without the placeholder as it is", () => {
    expect(sentEmailParts("Just text, no footer.")).toEqual({ main: "Just text, no footer.", footer: "" });
    const twice = sentEmailParts(`Body\n\n--\nFooter ${UNSUBSCRIBE_PLACEHOLDER} and ${UNSUBSCRIBE_PLACEHOLDER}`);
    expect(twice.footer).toBe(`--\nFooter ${UNSUBSCRIBE_PREVIEW_TEXT} and ${UNSUBSCRIBE_PREVIEW_TEXT}`);
  });
});
