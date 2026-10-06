import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PriorityBadge } from "@/components/badges";
import { ERROR_SCREEN_COPY, errorDetails, notFoundCopy } from "@/components/error-copy";
import { ErrorScreen } from "@/components/error-screens";
import { signInEmailHelp } from "@/components/settings/profile-text";
import { MOBILE_NAV } from "@/components/shell/nav-items";

describe("not-found screen wording (SPEC-5)", () => {
  it("names the thing that's gone and offers one way on", () => {
    expect(notFoundCopy("/import/123")).toMatchObject({
      title: "This import doesn't exist any more.",
      next: { href: "/import", label: "Go to Import" },
    });
    expect(notFoundCopy("/settings/nope").next).toEqual({ href: "/settings", label: "Go to Settings" });
    // Everyone's home is the dashboard (M6-DESIGN §4.5).
    expect(notFoundCopy("/somewhere")).toMatchObject({
      title: "This page doesn't exist.",
      next: { href: "/dashboard", label: "Go to the dashboard" },
    });
    expect(notFoundCopy(null).next.href).toBe("/dashboard");
    // "/importer" is not the Import page.
    expect(notFoundCopy("/importer").next.href).toBe("/dashboard");
  });
});

describe("error screen (SPEC-5)", () => {
  it("keeps the technical code behind Details", () => {
    expect(errorDetails({ digest: "123456", message: "An error occurred in the Server Components render." })).toBe("Error code: 123456");
    expect(errorDetails({ message: "  x is undefined " })).toBe("x is undefined");
    expect(errorDetails({})).toBeNull();
    expect(errorDetails(null)).toBeNull();
  });

  it("renders a plain message, one Try again button and a Details disclosure", () => {
    const error = Object.assign(new Error("boom"), { digest: "98765" });
    const html = renderToStaticMarkup(createElement(ErrorScreen, { error, retry: () => undefined }));
    expect(html).toContain(ERROR_SCREEN_COPY.title);
    expect(html).toContain("Nothing you saved is lost.");
    expect((html.match(/<button/g) ?? []).length).toBe(1);
    expect(html).toContain(">Try again<");
    expect(html).toMatch(/<details[^>]*><summary[^>]*>Details<\/summary><p[^>]*>Error code: 98765<\/p><\/details>/);
    // The code appears only inside Details.
    expect(html.replace(/<details[\s\S]*<\/details>/, "")).not.toContain("98765");
  });
});

describe("phone bottom bar (SPEC-10)", () => {
  it("is Dashboard, Contacts, Campaigns, Notifications", () => {
    expect(MOBILE_NAV.map((i) => [i.label, i.href])).toEqual([
      ["Dashboard", "/dashboard"],
      ["Contacts", "/contacts"],
      ["Campaigns", "/campaigns"],
      ["Notifications", "/notifications"],
    ]);
  });

  it("has no placeholder screen left: the dashboard arrived (M6-DESIGN §4, L12)", async () => {
    const pageHeader = await import("@/components/page-header");
    expect(Object.keys(pageHeader).sort()).toEqual(["EmptyState", "PageHeader"]);
  });
});

describe("Low priority (SPEC-17)", () => {
  it("stays at full muted contrast and has a non-colour cue", () => {
    const low = renderToStaticMarkup(createElement(PriorityBadge, { priority: "LOW" }));
    const normal = renderToStaticMarkup(createElement(PriorityBadge, { priority: "NORMAL" }));
    expect(low).not.toMatch(/text-muted-foreground\/\d+/);
    expect(low).toContain("text-muted-foreground");
    expect(low).toContain("<svg"); // the down arrow
    expect(low).toContain(">Low<");
    expect(normal).not.toContain("<svg");
    expect(renderToStaticMarkup(createElement(PriorityBadge, { priority: "HIGH" }))).toContain("font-semibold");
  });
});

describe("sign-in email help (SPEC-6)", () => {
  it("gives the real remedy instead of 'Ask the Owner'", () => {
    expect(signInEmailHelp(false)).toMatch(/the Owner switches this account off and invites the new address/);
    expect(signInEmailHelp(true)).toMatch(/make the new account the Owner, then switch this one off/);
    expect(signInEmailHelp(true)).not.toMatch(/Ask the Owner/);
  });
});
