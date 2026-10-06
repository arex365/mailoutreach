import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TimelineItemView } from "@/components/company-panel/timeline-view";

// "Show more" and the filters load through a Server Action; the render test never calls it.
vi.mock("@/components/company-panel/actions", () => ({
  loadTimelineAction: async () => ({ ok: true, data: { items: [], nextCursor: null } }),
}));

const { TIMELINE_ICON_TYPES, TimelineSection } = await import("@/components/company-panel/timeline");

/** Milestone 4's new activity types (M4-DESIGN §3.11) and the lucide icon each one shows (§6 row 12). */
const M4_ICONS: Record<string, string> = {
  "reply.possible": "lucide-message-circle-question-mark",
  "reply.bounce": "lucide-mail-x",
  "reply.unlinked": "lucide-unlink",
  "reply.confirmed": "lucide-badge-check",
  "reply.linked": "lucide-link",
  "reply.answered": "lucide-check-check",
  "reply.notNeeded": "lucide-circle-slash",
  "reply.reopened": "lucide-rotate-ccw",
  "followups.held": "lucide-circle-pause",
  "followups.released": "lucide-circle-play",
};

function item(id: number, type: string): TimelineItemView {
  return {
    id,
    type,
    category: type.startsWith("reply.") ? "reply" : "change",
    summary: `Entry ${type}`,
    detail: null,
    actor: "System",
    iso: "2026-09-23T10:00:00.000Z",
    ago: "just now",
    exact: "23 Sept 2026, 15:00",
    modeLabel: null,
  };
}

describe("company timeline icons", () => {
  it("has its own icon for every new reply and follow-up type", () => {
    for (const type of Object.keys(M4_ICONS)) expect(TIMELINE_ICON_TYPES).toContain(type);
    // The M3 ones stay.
    expect(TIMELINE_ICON_TYPES).toEqual(expect.arrayContaining(["reply.received", "reply.auto", "email.sent"]));
  });

  it("renders each with its icon", () => {
    for (const [type, iconClass] of Object.entries(M4_ICONS)) {
      const html = renderToStaticMarkup(
        createElement(TimelineSection, { companyId: 1, initial: { items: [item(1, type)], nextCursor: null } }),
      );
      expect(html, type).toContain(`Entry ${type}`);
      expect(html, type).toContain(iconClass);
    }
  });

  it("falls back to the category's icon for a type it doesn't know", () => {
    const html = renderToStaticMarkup(
      createElement(TimelineSection, { companyId: 1, initial: { items: [item(1, "reply.somethingNew")], nextCursor: null } }),
    );
    expect(html).toContain("lucide-reply");
  });
});
