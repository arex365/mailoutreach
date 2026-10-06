import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AudienceCompanyView, AudiencePersonView } from "@/server/services/campaigns/audience";

// The Server Actions module can't load outside Next (it's server-only); the card never calls it while rendering.
vi.mock("@/app/(app)/campaigns/[id]/setup/actions", () => ({
  clearAudienceAction: vi.fn(),
  putBackCompanyAction: vi.fn(),
  removeAudienceCompanyAction: vi.fn(),
  tickPersonAction: vi.fn(),
  previewAudienceFilterAction: vi.fn(),
  addAudienceFilterAction: vi.fn(),
  continueAction: vi.fn(),
}));

const { CompanyCard } = await import("@/components/campaign-wizard/audience-step");
const { StepIntro } = await import("@/components/campaign-wizard/wizard-frame");

const person = (id: number, over: Partial<AudiencePersonView> = {}): AudiencePersonView => ({
  personId: id,
  recipientId: id * 10,
  name: `Person ${id}`,
  email: `p${id}@acme.de`,
  isGeneric: false,
  verificationStatus: null,
  ticked: false,
  eligible: true,
  willGet: false,
  canTick: true,
  reason: null,
  notes: [],
  edited: false,
  removed: false,
  ...over,
});

const base: AudienceCompanyView = {
  companyId: 12,
  code: "C-12",
  name: "Acme 3D",
  status: "NOT_CONTACTED",
  country: "DE",
  countryName: "Germany",
  deleted: false,
  section: "included",
  blockedReason: null,
  canPutBack: false,
  putBack: false,
  people: [],
  ticked: 0,
  willGet: 0,
  warning: null,
  emptyReason: null,
};

function render(company: AudienceCompanyView): string {
  return renderToStaticMarkup(
    createElement(CompanyCard, { company, busy: false, onTick: () => {}, onPutBack: () => {}, onTakeOut: () => {}, onRemove: () => {} }),
  );
}

describe("an audience company", () => {
  it("shows each person with a tick box, the reason for anyone who can't be emailed, and the warning", () => {
    const html = render({
      ...base,
      people: [
        person(1, { ticked: true, willGet: true, verificationStatus: "VALID" }),
        person(2, { ticked: true, willGet: true, name: "General inbox", isGeneric: true }),
        person(3, { eligible: false, canTick: false, reason: "Unsubscribed" }),
      ],
      ticked: 2,
      willGet: 2,
      warning: "2 people at this company are ticked. Each of them gets the emails.",
    });
    expect(html).toContain("Acme 3D");
    expect(html).toContain("C-12 · Germany");
    expect(html).toContain("Not contacted");
    expect(html).toContain("Valid");
    expect(html).toContain("Unsubscribed");
    expect(html).toContain("2 people at this company are ticked. Each of them gets the emails.");
    // Two ticked boxes, and the unsubscribed person's box can't be switched on.
    const boxes = html.match(/<button[^>]*role="checkbox"[^>]*>/g) ?? [];
    expect(boxes).toHaveLength(3);
    expect(boxes.filter((b) => b.includes('aria-checked="true"'))).toHaveLength(2);
    expect(boxes.filter((b) => / disabled=""/.test(b))).toHaveLength(1);
    expect(html).toContain('aria-label="Remove Acme 3D from this campaign"');
    expect(html).not.toContain("Put back in");
  });

  it("says when nobody here gets the email", () => {
    const html = render({ ...base, people: [person(1)] });
    expect(html).toContain("Nobody here gets the email. Tick someone, or remove the company.");
  });

  it("shows why an excluded company is left out, and offers to put a Replied one back", () => {
    const replied = render({
      ...base,
      status: "REPLIED",
      section: "excluded",
      blockedReason: "Company status is Replied (you can include it by hand)",
      canPutBack: true,
      people: [person(1, { eligible: false, canTick: false })],
    });
    expect(replied).toContain("Company status is Replied (you can include it by hand)");
    expect(replied).toContain("Put back in");
    expect(replied).not.toContain("Nobody here gets the email");

    const back = render({ ...base, status: "REPLIED", putBack: true, people: [person(1, { ticked: true, willGet: true })], ticked: 1, willGet: 1 });
    expect(back).toContain("Put back in by hand, although the company replied.");
    expect(back).toContain("Leave out again");

    const noEmail = render({ ...base, section: "excluded", emptyReason: "Nobody here has an email address", people: [person(1, { email: null, eligible: false, canTick: false, reason: "No email address" })] });
    expect(noEmail).toContain("Nobody here has an email address");
    expect(noEmail).toContain("No email address");
  });
});

describe("step intro", () => {
  it("has a heading and a short explanation", () => {
    const html = renderToStaticMarkup(createElement(StepIntro, { title: "Who sends it" }, "Replies go to them."));
    expect(html).toContain("<h2");
    expect(html).toContain("Who sends it");
    expect(html).toContain("Replies go to them.");
  });
});
