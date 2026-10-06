import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The Server Actions module can't load outside Next (it's server-only); nothing here calls it.
vi.mock("@/app/(app)/campaigns/[id]/actions", () => ({
  discardUnsentEditAction: vi.fn(),
  editUnsentEmailAction: vi.fn(),
  retryEmailAction: vi.fn(),
  skipRecipientAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/campaigns/4",
}));

const { EditEmailButton, RetryEmailButton, isTypingTarget } = await import("@/components/campaigns/recipient-actions");

const fakeTarget = (inField: boolean) => ({ closest: (selector: string) => (inField && selector.includes("textarea") ? {} : null) });

describe("editing one person's unsent email on the campaign page", () => {
  it("keeps the editor open on Esc while typing in a field", () => {
    expect(isTypingTarget(fakeTarget(true) as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget(fakeTarget(false) as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("shows the edit button with the editor closed", () => {
    const html = renderToStaticMarkup(
      createElement(EditEmailButton, {
        campaignId: 4,
        recipientId: 12,
        step: 0,
        who: "Anna Berg",
        initial: { subject: "Models for {{company}}", body: "Hi Anna" },
        campaignText: { subject: "Models for {{company}}", body: "Hi {{first_name}}" },
        hasEdit: true,
        variables: [],
      }),
    );
    expect(html).toContain("Edit this email");
    expect(html).not.toContain("Discard your changes?"); // only asked when closing with changed text
  });
});

describe("trying a failed email again", () => {
  it("uses plain words", () => {
    const html = renderToStaticMarkup(createElement(RetryEmailButton, { campaignId: 4, emailId: 9 }));
    expect(html).toContain("Try again");
    expect(html).not.toMatch(/queue/i);
  });
});
