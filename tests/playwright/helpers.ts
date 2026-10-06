import fs from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { E2E_USERS, ROOT, e2eStateFromEnv, type E2eState } from "./instances";
import { readManifest, type SeedManifest } from "./manifest";

/**
 * Shared steps of the screen checks (docs/dev/M6-DESIGN.md §9.4): signing in, the axe scan, screenshots, the layout
 * checks every screen gets (no sideways scrolling, at most one orange button) and the dashboard's link and keyboard
 * checks. The state under test is PP_E2E_STATE; each spec block skips itself in the other states.
 */

/** The seeded state this run checks (PP_E2E_STATE: empty, busy, ready, live or own). */
export const STATE: E2eState = e2eStateFromEnv();

export type Role = "owner" | "member";

let cachedManifest: SeedManifest | null = null;

/** What the seed script wrote for this state (ids to open and the facts behind the expected sentences). */
export function manifest(): SeedManifest {
  cachedManifest ??= readManifest(STATE);
  return cachedManifest;
}

/** Skips the enclosing block (or test) unless this run checks one of `states`. */
export function onlyIn(...states: E2eState[]): void {
  test.skip(!states.includes(STATE), `Runs in the ${states.join(" and ")} state only (this run: ${STATE}).`);
}

/** The phone project (390 × 844). */
export function isPhone(testInfo: TestInfo): boolean {
  return testInfo.project.name === "phone";
}

/** The seeded users' sign-in details; PP_E2E_OWNER_EMAIL/_PASSWORD and PP_E2E_MEMBER_EMAIL/_PASSWORD override them. */
export function credentials(role: Role): { email: string; password: string } {
  const env = process.env;
  if (role === "owner") {
    return {
      email: env.PP_E2E_OWNER_EMAIL?.trim() || E2E_USERS.owner.email,
      password: env.PP_E2E_OWNER_PASSWORD || E2E_USERS.owner.password,
    };
  }
  return {
    email: env.PP_E2E_MEMBER_EMAIL?.trim() || E2E_USERS.member.email,
    password: env.PP_E2E_MEMBER_PASSWORD || E2E_USERS.member.password,
  };
}

/** Signs in through the sign-in page and waits until the app has left it. */
export async function signIn(page: Page, role: Role): Promise<void> {
  const { email, password } = credentials(role);
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
}

/** Opens a page of the app and waits for its content. */
export async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator("main").first()).toBeVisible();
}

/** The page's main content (the app's and the sign-in pages' `<main id="main">`). */
export function mainOf(page: Page): Locator {
  return page.locator("main").first();
}

/** A `<section aria-labelledby>` by its heading (the dashboard's tiles and lists, §4.1). */
export function region(page: Page, name: string): Locator {
  return page.getByRole("region", { name, exact: true });
}

/**
 * The axe scan (WCAG 2.0/2.1 A and AA): no violations. The failure lists each rule with its impact and the first
 * elements it found.
 */
export async function expectAccessible(page: Page, name: string): Promise<void> {
  // Off every button, and past the buttons' colour transition: a click leaves the pointer over the next step's
  // button, and a half-faded hover colour reads as low contrast.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const problems = results.violations.map((v) => {
    const targets = v.nodes
      .slice(0, 3)
      .map((n) => n.target.map((t) => String(t)).join(" "))
      .join(" | ");
    return `${v.id} (${v.impact ?? "impact unknown"}): ${v.help}. First: ${targets}`;
  });
  expect(problems, `Accessibility problems on ${name}:\n${problems.join("\n")}`).toEqual([]);
}

/** A full-page screenshot: test-results/shots/<project>-<state>-<name>.png (kept across the four state runs). */
export async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const safe = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const dir = path.join(ROOT, "test-results", "shots");
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${testInfo.project.name}-${STATE}-${safe}.png`), fullPage: true });
}

/** The page never scrolls sideways (§4.1, §5.1 R10): the document is no wider than the window. */
export async function expectNoHorizontalScroll(page: Page, name: string): Promise<void> {
  const size = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(size.scrollWidth, `${name} scrolls sideways (${size.scrollWidth}px of content in ${size.clientWidth}px)`).toBeLessThanOrEqual(
    size.clientWidth,
  );
}

/**
 * At most one orange button (§4.1, §5.1 R1): visible `[data-slot="button"][data-variant="default"]`. A switch's,
 * checkbox's, tab's or progress bar's orange fill is a "selected" state, not a button, so it doesn't count; primary
 * link-buttons use `<Button asChild>` and carry the attributes.
 */
export async function expectAtMostOnePrimary(page: Page, name: string): Promise<void> {
  const primary = page.locator('[data-slot="button"][data-variant="default"]').filter({ visible: true });
  const labels = await primary.allInnerTexts();
  expect(labels.length, `${name} has ${labels.length} orange buttons: ${labels.map((l) => `"${l.trim()}"`).join(", ")}`).toBeLessThanOrEqual(1);
}

/** Attention items whose presence depends on the test machine, not the seed (§9.3: `disk-low`). */
export const MACHINE_DEPENDENT_ATTENTION: readonly RegExp[] = [/^The office PC's disk is almost full/];

/** The attention list's empty text (§4.2). */
export const NO_ATTENTION_TEXT = "Nothing needs your attention right now.";

/**
 * The "Needs your attention" items' texts (each item's whole text: its sentence, second line and link label), without
 * the empty text in case the list renders it as an item.
 */
export async function attentionTexts(page: Page): Promise<string[]> {
  const items = region(page, "Needs your attention").getByRole("listitem");
  return (await items.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => t !== NO_ATTENTION_TEXT);
}

/** The attention items other than the machine-dependent ones. */
export async function seededAttentionTexts(page: Page): Promise<string[]> {
  return (await attentionTexts(page)).filter((t) => !MACHINE_DEPENDENT_ATTENTION.some((re) => re.test(t)));
}

/** Visible links inside `scope`: their hrefs, first appearance order, same-site paths only. */
async function visibleHrefs(scope: Locator): Promise<string[]> {
  const hrefs = await scope.locator("a[href]").evaluateAll((els) =>
    els
      .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden")
      .map((el) => el.getAttribute("href") ?? ""),
  );
  return [...new Set(hrefs.filter((h) => h.startsWith("/")))];
}

/**
 * Every same-site link in `scope` opens a page that works (§9.4 "every link navigates"): no HTTP error, no "doesn't
 * exist" or "went wrong" screen, no sign-in again, and for a Member no Owner-only page (those send Members back to the
 * dashboard with `notice=owner-only`). Leaves the page on the last link's target.
 */
export async function expectLinksNavigate(page: Page, scope: Locator, role: Role): Promise<void> {
  const hrefs = await visibleHrefs(scope);
  const problems: string[] = [];
  for (const href of hrefs) {
    const res = await page.goto(href);
    const status = res?.status() ?? 200;
    const url = new URL(page.url());
    if (status >= 400) problems.push(`${href}: HTTP ${status}`);
    if (url.pathname === "/login") problems.push(`${href}: asks to sign in again`);
    if (role === "member" && url.searchParams.get("notice") === "owner-only") problems.push(`${href}: an Owner-only page linked for a Member`);
    const broken = page.getByText(/^(This page doesn't exist\.|This settings page doesn't exist\.|Something went wrong on this page\.)$/);
    if ((await broken.count()) > 0) problems.push(`${href}: shows an error screen`);
  }
  expect(problems, `Links that don't work:\n${problems.join("\n")}`).toEqual([]);
}

/**
 * The keyboard (§4.1, CONVENTIONS "UI rules"): pressing Tab from the top of the page reaches every visible link in
 * `scope`, in the order they appear, and each shows a focus ring (an outline, or the buttons' ring shadow).
 */
export async function expectTabReachesLinks(page: Page, scope: Locator, name: string): Promise<void> {
  const total = await scope.evaluate((root) => {
    const links = Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]")).filter(
      (a) => a.getClientRects().length > 0 && getComputedStyle(a).visibility !== "hidden" && a.tabIndex >= 0 && !a.closest("[inert]"),
    );
    links.forEach((a, i) => a.setAttribute("data-e2e-link", String(i)));
    return links.length;
  });
  if (total === 0) return;
  // A focusable start at the top of the page, so the first Tab goes to the page's first stop.
  await page.evaluate(() => {
    const start = document.createElement("span");
    start.tabIndex = -1;
    start.setAttribute("data-e2e-start", "");
    document.body.prepend(start);
    start.focus();
    window.scrollTo(0, 0);
  });
  const reached: number[] = [];
  const withoutRing: string[] = [];
  for (let i = 0; i < 500 && reached.length < total; i++) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      const index = el?.getAttribute("data-e2e-link");
      if (!el || index === null || index === undefined) return null;
      const cs = getComputedStyle(el);
      const outline = cs.outlineStyle !== "none" && Number.parseFloat(cs.outlineWidth) > 0;
      const shadow = cs.boxShadow !== "none" && cs.boxShadow !== "";
      return { index: Number(index), ring: outline || shadow, text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60) };
    });
    if (!focused || reached.includes(focused.index)) continue;
    reached.push(focused.index);
    if (!focused.ring) withoutRing.push(focused.text || `link ${focused.index + 1}`);
  }
  expect(reached, `On ${name}, Tab reached these links (by order on the page): ${reached.join(", ")}`).toEqual(
    Array.from({ length: total }, (_, i) => i),
  );
  expect(withoutRing, `On ${name}, these links show no focus ring: ${withoutRing.join(", ")}`).toEqual([]);
}

/** On a phone the given sections stack in one column: same left edge, full width. */
export async function expectOneColumn(page: Page, sections: Locator[], name: string): Promise<void> {
  const boxes: Array<{ x: number; width: number }> = [];
  for (const s of sections) {
    const box = await s.boundingBox();
    if (box) boxes.push({ x: box.x, width: box.width });
  }
  if (boxes.length < 2) return;
  const first = boxes[0]!;
  const off = boxes.filter((b) => Math.abs(b.x - first.x) > 2 || Math.abs(b.width - first.width) > 2);
  expect(off, `${name} isn't one column on a phone`).toEqual([]);
}

/** The top bar's sending label ("Sending live", "Test list only", "Paused: …"). */
export function sendingPill(page: Page, text: string): Locator {
  return page.locator("header").getByText(text, { exact: true }).first();
}
