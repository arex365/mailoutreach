import { describe, expect, it, vi } from "vitest";
import {
  NavigationGuards,
  SWALLOW_MS,
  inAppHref,
  isSamePage,
  type GuardEntry,
  type HistoryPort,
  type LeaveRequest,
  type NavMode,
} from "@/components/navigation/nav-guard-core";

const ORIGIN = "http://192.168.1.20:3000";

/**
 * A small stand-in for the browser's session history plus the app router's popstate listener:
 * go() traverses later (like the browser), then fires popstate at the guards first (they listen
 * in the capture phase) and, unless they stopped it, at the "router".
 */
class FakeBrowser implements HistoryPort {
  entries: Array<{ url: string; state: unknown }>;
  index: number;
  scroll: "auto" | "manual" = "auto";
  time = 1_000;
  routerSaw: string[] = [];
  private tasks: Array<() => void> = [];
  guards!: NavigationGuards;

  constructor(urls: string[]) {
    this.entries = urls.map((u, i) => ({ url: ORIGIN + u, state: { __NA: true, tree: i } }));
    this.index = urls.length - 1;
  }

  href = () => this.entries[this.index]!.url;
  state = () => this.entries[this.index]!.state;
  length = () => this.entries.length;
  push = (state: unknown, url: string) => {
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push({ url, state });
    this.index++;
  };
  /** Makes the next go() do nothing (a traversal the browser dropped). */
  dropNextGo = false;
  go = (delta: number) => {
    if (this.dropNextGo) {
      this.dropNextGo = false;
      return;
    }
    this.tasks.push(() => {
      const target = this.index + delta;
      if (target < 0 || target >= this.entries.length) return;
      this.index = target;
      let stopped = false;
      this.guards.handlePopState({ stopImmediatePropagation: () => (stopped = true) });
      if (!stopped) this.routerSaw.push(this.href().slice(ORIGIN.length));
    });
  };
  setScrollRestoration = (mode: "auto" | "manual") => {
    this.scroll = mode;
  };
  now = () => this.time;
  later = (fn: () => void) => {
    this.tasks.push(fn);
  };

  /** Runs queued traversals and deferred work, like the browser's event loop. */
  flush() {
    for (let i = 0; i < 50 && this.tasks.length; i++) this.tasks.shift()!();
  }
  /** The browser's Back button. */
  back() {
    this.go(-1);
    this.flush();
  }
  /** Router navigation (router.push / router.replace). */
  navigate(href: string, mode: NavMode) {
    if (mode === "push") this.push({ __NA: true }, ORIGIN + href);
    else this.entries[this.index] = { url: ORIGIN + href, state: { __NA: true } };
  }
  path() {
    return this.href().slice(ORIGIN.length);
  }
}

function setup(urls = ["/contacts", "/templates", "/templates/3"]) {
  const browser = new FakeBrowser(urls);
  const guards = new NavigationGuards(browser);
  browser.guards = guards;
  const asked: LeaveRequest[] = [];
  const state = { active: false, protectBack: true };
  const entry: GuardEntry = {
    isActive: () => state.active,
    protectsBack: () => state.protectBack,
    onLeave: (r) => asked.push(r),
    navigate: vi.fn((href: string, mode: NavMode) => browser.navigate(href, mode)),
    leaving: false,
  };
  const remove = guards.add(entry);
  const setActive = (active: boolean) => {
    state.active = active;
    guards.changed();
    browser.flush();
  };
  browser.flush();
  return { browser, guards, entry, asked, setActive, remove, state };
}

describe("links, the search menu and the bell", () => {
  it("go straight through while the page has nothing to lose", () => {
    const { guards, asked } = setup();
    expect(guards.request("/campaigns", vi.fn())).toBe(false);
    expect(asked).toHaveLength(0);
  });

  it("ask the page's guard first, and only navigate when it says so", () => {
    const { guards, asked, setActive, browser } = setup();
    setActive(true);
    const navigate = vi.fn();
    expect(guards.request("/campaigns", navigate)).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.href).toBe("/campaigns");
    expect(navigate).not.toHaveBeenCalled();

    asked[0]!.proceed();
    // The extra history entry is replaced, so Back later doesn't show the editor twice.
    expect(navigate).toHaveBeenCalledWith("replace");
    expect(browser.scroll).toBe("auto");
    asked[0]!.proceed(); // only the first answer counts
    expect(navigate).toHaveBeenCalledTimes(1);
    // After choosing to leave, nothing is asked any more.
    expect(guards.request("/import", vi.fn())).toBe(false);
  });

  it("don't ask for the page that's already open", () => {
    const { guards, asked, setActive } = setup();
    setActive(true);
    expect(guards.request("/templates/3", vi.fn())).toBe(false);
    expect(asked).toHaveLength(0);
  });

  it("use the guard's own router when the caller has none (plain links)", () => {
    const { guards, asked, setActive, entry } = setup();
    setActive(true);
    expect(guards.request("/campaigns")).toBe(true);
    asked[0]!.proceed();
    expect(entry.navigate).toHaveBeenCalledWith("/campaigns", "replace");
  });

  it("answer with the newest active guard, and forget removed ones", () => {
    const { guards, asked, setActive, remove } = setup();
    setActive(true);
    const inner: LeaveRequest[] = [];
    const removeInner = guards.add({ isActive: () => true, protectsBack: () => false, onLeave: (r) => inner.push(r), navigate: vi.fn(), leaving: false });
    guards.request("/campaigns", vi.fn());
    expect(inner).toHaveLength(1);
    expect(asked).toHaveLength(0);
    removeInner();
    remove();
    expect(guards.request("/campaigns", vi.fn())).toBe(false);
  });
});

describe("the browser's Back button", () => {
  it("adds one extra entry for this page while there's something to lose, without scroll jumps", () => {
    const { browser, setActive } = setup();
    expect(browser.entries).toHaveLength(3);
    setActive(true);
    expect(browser.entries).toHaveLength(4);
    expect(browser.path()).toBe("/templates/3");
    expect(browser.entries[3]!.state).toEqual(browser.entries[2]!.state); // the router's own state, copied
    expect(browser.scroll).toBe("manual");
    setActive(true); // no second entry
    expect(browser.entries).toHaveLength(4);
  });

  it("asks instead of leaving; Keep editing stays on the page and keeps asking", () => {
    const { browser, asked, setActive } = setup();
    setActive(true);
    browser.back();
    expect(browser.routerSaw).toEqual([]); // the router never moved
    expect(browser.path()).toBe("/templates/3");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.href).toBeNull();
    // A second Back while the question is open is caught too, without asking twice.
    browser.back();
    expect(browser.routerSaw).toEqual([]);
    expect(asked).toHaveLength(1);

    asked[0]!.cancel();
    browser.back();
    expect(browser.routerSaw).toEqual([]);
    expect(asked).toHaveLength(2);
  });

  it("Leave goes back to the page before", () => {
    const { browser, asked, setActive, entry } = setup();
    setActive(true);
    browser.back();
    asked[0]!.proceed();
    browser.flush();
    expect(browser.path()).toBe("/templates");
    expect(browser.routerSaw).toEqual(["/templates"]);
    expect(entry.leaving).toBe(true);
    expect(browser.scroll).toBe("auto");
  });

  it("a long jump in the browser's history list goes exactly there after Leave", () => {
    const { browser, asked, setActive } = setup();
    setActive(true);
    browser.go(-3); // from the extra entry straight to /contacts
    browser.flush();
    expect(browser.routerSaw).toEqual([]);
    expect(browser.path()).toBe("/templates/3"); // the page is shown again while we ask
    asked[0]!.proceed();
    browser.flush();
    expect(browser.path()).toBe("/contacts");
    expect(browser.routerSaw).toEqual(["/contacts"]);
  });

  it("removes the extra entry once everything is saved, without the router noticing", () => {
    const { browser, setActive } = setup();
    setActive(true);
    setActive(false);
    expect(browser.index).toBe(2);
    expect(browser.path()).toBe("/templates/3");
    expect(browser.routerSaw).toEqual([]);
    expect(browser.scroll).toBe("auto");
    // Back works normally again.
    browser.back();
    expect(browser.routerSaw).toEqual(["/templates"]);
  });

  it("a late popstate isn't mistaken for our own step back", () => {
    const { browser, setActive } = setup();
    setActive(true);
    browser.dropNextGo = true; // our step back off the extra entry never happens
    setActive(false);
    expect(browser.index).toBe(3);
    // The person's own Back, much later, reaches the router.
    browser.time += SWALLOW_MS + 1;
    browser.back();
    expect(browser.routerSaw).toEqual(["/templates/3"]);
    browser.back();
    expect(browser.routerSaw).toEqual(["/templates/3", "/templates"]);
  });

  it("keeps the extra entry while the question is open, even if the page saved meanwhile", () => {
    const { browser, asked, setActive } = setup();
    setActive(true);
    browser.back();
    setActive(false);
    expect(browser.entries).toHaveLength(4);
    asked[0]!.proceed();
    browser.flush();
    expect(browser.path()).toBe("/templates");
  });

  it("isn't used when Back couldn't leave the page anyway (first page of the tab)", () => {
    const { browser, setActive } = setup(["/templates/3"]);
    setActive(true);
    expect(browser.entries).toHaveLength(1);
  });

  it("only for guards that ask for it", () => {
    const { browser, setActive, state } = setup();
    state.protectBack = false;
    setActive(true);
    expect(browser.entries).toHaveLength(3);
    browser.back();
    expect(browser.routerSaw).toEqual(["/templates"]);
  });

  it("doesn't tidy up after the page has already moved on", () => {
    const { browser, setActive, remove } = setup();
    setActive(true);
    browser.navigate("/campaigns", "push"); // e.g. a navigation that didn't ask
    remove();
    browser.flush();
    expect(browser.path()).toBe("/campaigns");
    expect(browser.routerSaw).toEqual([]);
  });
});

describe("which clicks the guards look at", () => {
  const here = `${ORIGIN}/campaigns/4/setup/message`;
  it("in-app links to another page", () => {
    expect(inAppHref({ href: `${ORIGIN}/campaigns/4/setup/review?x=1#top` }, here)).toBe("/campaigns/4/setup/review?x=1#top");
    expect(inAppHref({ href: "/contacts" }, here)).toBe("/contacts");
  });
  it("not other sites, new windows, downloads, marked links or the same page", () => {
    expect(inAppHref({ href: "https://example.com/" }, here)).toBeNull();
    expect(inAppHref({ href: "/contacts", target: "_blank" }, here)).toBeNull();
    expect(inAppHref({ href: "/contacts", target: "_self" }, here)).toBe("/contacts");
    expect(inAppHref({ href: "/api/export", download: true }, here)).toBeNull();
    expect(inAppHref({ href: "/contacts", skip: true }, here)).toBeNull();
    expect(inAppHref({ href: `${here}#preview` }, here)).toBeNull();
    expect(inAppHref({ href: "http://[bad" }, here)).toBeNull();
  });
  it("same page means same path and query", () => {
    expect(isSamePage("/campaigns/4/setup/message", here)).toBe(true);
    expect(isSamePage("/campaigns/4/setup/message?x=1", here)).toBe(false);
    expect(isSamePage("/campaigns/5/setup/message", here)).toBe(false);
  });
});
