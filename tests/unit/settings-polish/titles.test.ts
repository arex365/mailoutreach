import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/settings" }));

const { OWNER_SETTINGS } = await import("@/components/settings/settings-nav");

/**
 * M6-DESIGN §5.1 R2: every settings page's metadata title is its nav label and its heading, and the heading is the
 * server-rendered SettingsTitle (Team's moved out of the client TeamManager). Read from the page sources, because the
 * pages load the database.
 */

const ROOT = path.resolve(__dirname, "../../..");
const page = (slug: string) => fs.readFileSync(path.join(ROOT, "src/app/(app)/settings", slug, "page.tsx"), "utf8");

const PACKAGE_PAGES: ReadonlyArray<[string, string]> = [
  ["profile", "My profile"],
  ["notifications", "Notifications"],
  ["domain", "Domain checklist"],
  ["limits", "Limits & warm-up"],
  ["deliverability", "Deliverability"],
  ["footer", "Email footer"],
  ["ai", "AI"],
  ["team", "Team"],
  ["system", "System"],
];

describe("settings page titles", () => {
  it("the metadata title is the nav label", () => {
    const labels = new Map(OWNER_SETTINGS.map((i) => [i.href, i.label]));
    for (const [slug, label] of PACKAGE_PAGES) {
      expect(page(slug), slug).toContain(`export const metadata: Metadata = { title: "${label}" };`);
      const nav = labels.get(`/settings/${slug}`);
      if (nav) expect(nav).toBe(label);
    }
  });

  it("each page renders its own SettingsTitle on the server, Team included", () => {
    for (const [slug, label] of PACKAGE_PAGES) {
      const src = page(slug);
      expect(src.startsWith('"use client"'), slug).toBe(false);
      if (slug === "ai") expect(src).toMatch(/<SettingsTitle\s+title=\{AI_SETTINGS_PAGE\.title\}/);
      else expect(src, slug).toMatch(new RegExp(`<SettingsTitle\\s+title="${label}"`));
    }
    const manager = fs.readFileSync(path.join(ROOT, "src/components/settings/team-manager.tsx"), "utf8");
    expect(manager).not.toContain("<SettingsTitle");
  });
});
