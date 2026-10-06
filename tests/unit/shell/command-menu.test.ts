import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Server Actions can't load outside Next; nothing here calls them while rendering.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => "/contacts",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/(app)/contacts/actions", () => ({ searchCompaniesAction: vi.fn() }));
vi.mock("@/app/(app)/campaigns/new/actions", () => ({ createDraftAction: vi.fn() }));

const { CommandMenu } = await import("@/components/shell/command-menu");

/**
 * The top bar's search button (M5 review SCREENS-01): on a phone it also leads to the screens that aren't in the
 * bottom bar (AI lines, Templates, Import, Activity), so there it says "Search or go to…".
 */

describe("the top bar's search button", () => {
  it("says 'Search or go to…' on a phone and 'Search companies…' on wider screens", () => {
    const out = renderToStaticMarkup(createElement(CommandMenu));
    expect(out).toMatch(/<span class="truncate sm:hidden">Search or go to…<\/span>/);
    expect(out).toMatch(/<span class="hidden truncate sm:inline">Search companies…<\/span>/);
    expect(out).toContain('aria-keyshortcuts="Control+K"');
  });
});
