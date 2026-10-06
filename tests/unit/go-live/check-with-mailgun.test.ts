import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The card's buttons call Server Actions; nothing here calls them while rendering.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/app/(app)/settings/sending/actions", () => ({ checkWithMailgunAction: vi.fn(), continueFollowUpsAction: vi.fn() }));

const { CheckWithMailgun } = await import("@/components/settings/sending/check-with-mailgun");

/** The "Check with Mailgun" card with older sending domains the catch-up couldn't check (M6-DESIGN L10, §5.2). */

describe("the Check with Mailgun card's old-domain lines", () => {
  const line = "Mailgun's logs for the old domain mail.example.com haven't been checked since 25 Sept. Replies and bounces to its last emails may be missed.";

  it("shows each line as a warning", () => {
    const out = renderToStaticMarkup(
      createElement(CheckWithMailgun, { line: "Last checked with Mailgun at 14:05.", failing: false, detail: null, oldDomains: [line], outage: null }),
    ).replace(/&#x27;/g, "'");
    expect(out).toContain(line);
    expect(out).toMatch(/text-warning[^>]*>(?:(?!<\/p>).)*mail\.example\.com/);
  });

  it("shows none when there are none (or when left out)", () => {
    const out = renderToStaticMarkup(createElement(CheckWithMailgun, { line: "Last checked with Mailgun at 14:05.", failing: false, detail: null, outage: null }));
    expect(out).not.toContain("old domain");
  });
});
