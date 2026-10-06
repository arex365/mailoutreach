import { describe, expect, it } from "vitest";
import {
  isTimelineFilter,
  timelineCategory,
  timelineEmptyText,
  toTimelineItemView,
} from "@/components/company-panel/timeline-view";

const NOW = new Date("2026-09-23T10:00:00Z");

describe("timeline view", () => {
  it("groups activity types for the filter chips", () => {
    expect(timelineCategory("email.sent")).toBe("email");
    expect(timelineCategory("email.bounced")).toBe("email");
    expect(timelineCategory("reply.received")).toBe("reply");
    expect(timelineCategory("reply.auto")).toBe("reply");
    expect(timelineCategory("company.status")).toBe("change");
    expect(timelineCategory("person.created")).toBe("change");
  });

  it("formats a row in the viewer's time zone and names the system", () => {
    const v = toTimelineItemView(
      {
        id: 9,
        at: new Date("2026-09-11T19:30:00Z"),
        type: "reply.received",
        summary: "Anna replied to Germany Q4",
        data: { subject: "Re: 3D models", snippet: "Hi Ali,\n\nthanks, could you send   prices?" },
        mode: "DRY_RUN",
        actorName: null,
      },
      "Asia/Karachi",
      NOW,
    );
    expect(v.actor).toBe("System");
    expect(v.category).toBe("reply");
    expect(v.ago).toBe("12 days ago");
    expect(v.exact).toMatch(/12 Sept? 2026/);
    expect(v.exact).toContain("00:30");
    expect(v.detail).toBe("Hi Ali, thanks, could you send prices?");
    expect(v.modeLabel).toBe("Dry run");
    expect(v.iso).toBe("2026-09-11T19:30:00.000Z");
  });

  it("shows note text and trims long details", () => {
    const long = "x".repeat(500);
    const v = toTimelineItemView(
      { id: 1, at: NOW, type: "company.notes", summary: "Ali updated the notes", data: { text: long }, mode: null, actorName: "Ali" },
      "UTC",
      NOW,
    );
    expect(v.actor).toBe("Ali");
    expect(v.detail?.length).toBe(240);
    expect(v.detail?.endsWith("…")).toBe(true);
    expect(v.modeLabel).toBeNull();
  });

  it("has the right empty texts and validates filters", () => {
    expect(timelineEmptyText("emails")).toBe("Not emailed yet.");
    expect(timelineEmptyText("all")).toBe("Nothing here yet.");
    expect(timelineEmptyText("changes")).toBe("Nothing here yet.");
    expect(isTimelineFilter("replies")).toBe(true);
    expect(isTimelineFilter("everything")).toBe(false);
  });
});
