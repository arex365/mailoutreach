import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The Server Actions modules can't load outside Next (they're server-only); nothing here calls them.
vi.mock("@/app/(app)/campaigns/[id]/setup/actions", () => ({
  applyTemplateAction: vi.fn(),
  continueAction: vi.fn(),
  previewStepAction: vi.fn(),
  saveBackToTemplateAction: vi.fn(),
  saveStepsAction: vi.fn(),
  searchRecipientsAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/campaigns/4/setup/message",
}));

const { MessageStep, OFFLINE, ownVersionNote, previewIntro } = await import("@/components/campaign-wizard/message-step");
const { problemBeforeContinue } = await import("@/components/campaign-wizard/step-footer");
const { NOT_SAVED } = await import("@/components/campaign-wizard/autosave-guard");

describe("Continue on the Message step", () => {
  it("shows why the latest changes couldn't be saved next to Continue, instead of doing nothing", async () => {
    expect(await problemBeforeContinue(undefined)).toBeNull();
    expect(await problemBeforeContinue(async () => ({ ok: true }))).toBeNull();
    const launched = "This campaign has already been launched, so it can't be changed here. Open the campaign page instead.";
    expect(await problemBeforeContinue(async () => ({ ok: false, error: launched }))).toBe(launched);
  });
});

describe("the Message step's preview", () => {
  it("promises the exact email only when this person gets the campaign's text", () => {
    expect(previewIntro("Ali", null)).toBe("Exactly what this person gets from Ali, including changes you haven't saved.");
    expect(previewIntro(null, "subject")).toBe("Exactly what this person gets, including changes you haven't saved.");
    const own = previewIntro("Ali", "email");
    expect(own).not.toContain("Exactly");
    expect(own).toBe("What this person would get from Ali with the campaign's text, including changes you haven't saved.");
  });

  it("says when the person has their own version from Review", () => {
    expect(ownVersionNote("Anna Berg", null)).toBeNull();
    expect(ownVersionNote("Anna Berg", "email")).toBe(
      "Anna Berg has their own version of this email, edited in Review, so they won't get the changes you make here. To change it, open Anna Berg in Review.",
    );
    expect(ownVersionNote("Anna Berg", "subject")).toBe(
      "Anna Berg has their own subject for the first email, edited in Review, so this follow-up's “Re:” line uses it.",
    );
  });

  it("renders the step with the preview's promise and everything saved", () => {
    const html = renderToStaticMarkup(
      createElement(MessageStep, {
        campaignId: 4,
        initialSteps: [{ step: 0, enabled: true, subject: "Models for {{company}}", body: "Hi {{first_name|there}}", delayDays: 0 }],
        templates: [{ id: 1, name: "Master sequence", isMaster: true }],
        sourceTemplateId: 1,
        variables: [],
        senderName: "Ali",
        defaultRecipient: { personId: 7, recipientId: 70, name: "Anna Berg", email: "anna@printwerk.de", companyName: "Printwerk", ticked: true },
      }),
    );
    expect(html).toContain("Exactly what this person gets from Ali");
    expect(html).toContain("All changes saved");
    expect(html).toContain("Continue");
  });

  it("tells people what happens when the app can't be reached", () => {
    expect(OFFLINE).toContain("We'll keep trying");
    expect(OFFLINE).not.toContain("as soon as the connection is back");
    expect(NOT_SAVED).toContain("Check your connection");
  });
});

describe("wording (PLAN.md A6)", () => {
  const files = [
    "src/components/campaign-wizard/autosave-guard.tsx",
    "src/components/campaign-wizard/message-step.tsx",
    "src/components/campaign-wizard/step-footer.tsx",
    "src/components/templates/leave-guard.tsx",
    "src/components/campaigns/recipient-actions.tsx",
    "src/components/navigation/nav-guard.tsx",
  ];
  it("never shows the computer's words (queue, job, error code) in these screens", () => {
    for (const file of files) {
      const source = readFileSync(path.resolve(file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1")
        .replace(/from\s+"[^"]*"/g, ""); // module paths aren't shown
      expect(source, file).not.toMatch(/\bqueue\b|\bjobs?\b|error code/i);
    }
  });
});
