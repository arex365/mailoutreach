import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The bell marks notifications read through Server Actions and navigates with the router; neither runs here.
vi.mock("@/app/(app)/notifications/actions", () => ({
  markNotificationsReadAction: async () => ({ ok: true, data: null }),
  markAllNotificationsReadAction: async () => ({ ok: true, data: null }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
}));

const { NotificationBell, NOTIFICATIONS_CHANGED_EVENT } = await import("@/components/shell/notification-bell");

describe("NotificationBell", () => {
  it("keeps the event other screens fire after marking notifications read (the Notifications page imports it)", () => {
    expect(NOTIFICATIONS_CHANGED_EVENT).toBe("pp:notifications-changed");
  });

  it("renders a neutral bell before the first poll, without polling on the server", () => {
    const html = renderToStaticMarkup(createElement(NotificationBell));
    expect(html).toContain('aria-label="Notifications"');
    expect(html).not.toContain("bg-brand");
    expect(html).not.toContain("bg-primary");
  });
});
