import { afterEach, describe, expect, it } from "vitest";
import { pollDelayMs, shouldPopUp } from "@/core/notifications/popups";
import {
  currentPopupState,
  insecurePopupText,
  localAppAddress,
  markPopupsUnsupported,
  planPopups,
  popupOpener,
  POPUPS_CHANGED_EVENT,
  raisePopupMark,
  readLocalPopupSwitch,
  readPopupMark,
  readPopupsUnsupported,
  resetPopupMark,
  showDesktopPopup,
  waitingRepliesText,
  writeLocalPopupSwitch,
  type BrowserPopupFacts,
  type MarkReadResult,
  type PopupStorage,
} from "@/app/(app)/settings/notifications/desktop-popups";

/**
 * The bell's and Settings › Notifications' browser-side pop-up pieces (M4-DESIGN §5.2–§5.3), without a browser: a
 * Map stands in for localStorage and a fake Notification class for the API.
 */

function memoryStorage(): PopupStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

/** A storage that refuses everything, like a private window with site data blocked. */
const brokenStorage: PopupStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

const DESKTOP: BrowserPopupFacts = { secure: true, hasApi: true, coarsePointerOnly: false, permission: "granted" };

function item(id: number, title = `Notification ${id}`) {
  return { id, type: "reply.received", title, body: `Body ${id}`, link: `/notifications?reply=${id}#replies`, createdAt: "", readAt: null };
}

describe("the per-browser switch, mark and unsupported flag", () => {
  it("stores them per user, and reads junk as not chosen", () => {
    const s = memoryStorage();
    expect(readLocalPopupSwitch(7, s)).toBeNull();
    writeLocalPopupSwitch(7, true, s);
    expect(s.data.get("pp.popups.on.7")).toBe("on");
    expect(readLocalPopupSwitch(7, s)).toBe(true);
    expect(readLocalPopupSwitch(8, s)).toBeNull(); // another person on the same PC profile
    writeLocalPopupSwitch(7, false, s);
    expect(readLocalPopupSwitch(7, s)).toBe(false);
    s.data.set("pp.popups.on.7", "yes");
    expect(readLocalPopupSwitch(7, s)).toBeNull();

    expect(readPopupsUnsupported(7, s)).toBe(false);
    markPopupsUnsupported(7, s);
    expect(s.data.get("pp.popups.unsupported.7")).toBe("1");
    expect(readPopupsUnsupported(7, s)).toBe(true);
  });

  it("only raises the high-water mark (another tab may have gone further), and resets it on a first poll", () => {
    const s = memoryStorage();
    expect(readPopupMark(3, s)).toBe(0);
    expect(raisePopupMark(3, 40, s)).toBe(40);
    expect(raisePopupMark(3, 12, s)).toBe(40);
    expect(readPopupMark(3, s)).toBe(40);
    resetPopupMark(3, 25, s); // the server's latest id after a page load (e.g. a restored database)
    expect(readPopupMark(3, s)).toBe(25);
    s.data.set("pp.popups.last.3", "-5");
    expect(readPopupMark(3, s)).toBe(0);
    s.data.set("pp.popups.last.3", "abc");
    expect(readPopupMark(3, s)).toBe(0);
  });

  it("never throws when the browser refuses storage", () => {
    expect(readLocalPopupSwitch(1, brokenStorage)).toBeNull();
    expect(() => writeLocalPopupSwitch(1, true, brokenStorage)).not.toThrow();
    expect(readPopupMark(1, brokenStorage)).toBe(0);
    expect(raisePopupMark(1, 9, brokenStorage)).toBe(9);
    expect(readPopupsUnsupported(1, brokenStorage)).toBe(false);
    expect(() => markPopupsUnsupported(1, brokenStorage)).not.toThrow();
    expect(readLocalPopupSwitch(1, null)).toBeNull();
  });
});

describe("the Settings state in this browser", () => {
  it("combines the browser facts with this browser's switch and the M1–M3 default", () => {
    const s = memoryStorage();
    expect(currentPopupState(5, false, DESKTOP, s)).toBe("off");
    expect(currentPopupState(5, true, DESKTOP, s)).toBe("on"); // legacy account switch = the default here
    writeLocalPopupSwitch(5, false, s);
    expect(currentPopupState(5, true, DESKTOP, s)).toBe("off"); // this browser's own choice wins
    writeLocalPopupSwitch(5, true, s);
    expect(currentPopupState(5, false, DESKTOP, s)).toBe("on");
    expect(currentPopupState(5, false, { ...DESKTOP, permission: "default" }, s)).toBe("ask");
    expect(currentPopupState(5, false, { ...DESKTOP, permission: "denied" }, s)).toBe("blocked");
    expect(currentPopupState(5, false, { ...DESKTOP, secure: false }, s)).toBe("insecure");
    expect(currentPopupState(5, false, { ...DESKTOP, coarsePointerOnly: true }, s)).toBe("phone");
    expect(currentPopupState(5, false, { ...DESKTOP, hasApi: false }, s)).toBe("unsupported");
    markPopupsUnsupported(5, s);
    expect(currentPopupState(5, false, DESKTOP, s)).toBe("unsupported");
  });

  it("names the office PC's own address with this page's port, never a fixed 3000", () => {
    expect(localAppAddress("3000")).toBe("http://localhost:3000");
    expect(localAppAddress("3001")).toBe("http://localhost:3001");
    expect(localAppAddress("")).toBe("http://localhost");
    expect(localAppAddress("80")).toBe("http://localhost");
    expect(localAppAddress("abc")).toBe("http://localhost");
  });

  it("explains the insecure address with and without a public address", () => {
    expect(insecurePopupText("https://outreach.example.com", "http://localhost:3001")).toBe(
      "Pop-ups can't work on this address. Browsers only allow them on the secure address (https://outreach.example.com) or on the office PC itself (http://localhost:3001). Open the secure address and turn them on there.",
    );
    expect(insecurePopupText(null, "http://localhost:3000")).toBe(
      "Pop-ups can't work on this address. Browsers only allow them on a secure (https) address or on the office PC itself (http://localhost:3000).",
    );
  });
});

describe("the bell's polling decision", () => {
  /** A small seeded generator, so the jitter is checked across its whole range. */
  function lcg(seed: number) {
    let x = seed;
    return () => {
      x = (x * 1664525 + 1013904223) % 4294967296;
      return x / 4294967296;
    };
  }

  it("polls every 20 s ± 2 s while visible, every 60 s while hidden with pop-ups on, not at all otherwise", () => {
    const random = lcg(42);
    for (let i = 0; i < 200; i++) {
      const d = pollDelayMs({ hidden: false, popupsOn: i % 2 === 0, random })!;
      expect(d).toBeGreaterThanOrEqual(18_000);
      expect(d).toBeLessThanOrEqual(22_000);
    }
    expect(pollDelayMs({ hidden: true, popupsOn: true, random })).toBe(60_000);
    expect(pollDelayMs({ hidden: true, popupsOn: false, random })).toBeNull();
  });

  it("pops up only while the person isn't looking at the app", () => {
    expect(shouldPopUp({ hidden: true, focused: false })).toBe(true);
    expect(shouldPopUp({ hidden: false, focused: false })).toBe(true); // another window in front
    expect(shouldPopUp({ hidden: false, focused: true })).toBe(false);
  });
});

describe("planPopups: what one poll shows", () => {
  const popups = (ids: number[], count = ids.length) => ({
    items: ids.slice(0, 5).map((id) => item(id)),
    count,
    latestId: ids.length ? Math.max(...ids) : null,
  });

  it("shows nothing on the first poll after a page load and records the latest id", () => {
    expect(planPopups({ latestId: 57, popups: popups([]) }, { first: true, mark: 0, canShow: true })).toEqual({ show: [], mark: 57 });
  });

  it("shows each new one with its own title, body, tag and link, oldest first, and moves the mark", () => {
    const res = planPopups({ latestId: 12, popups: popups([11, 12]) }, { first: false, mark: 10, canShow: true });
    expect(res.mark).toBe(12);
    expect(res.show).toEqual([
      { id: 11, title: "Notification 11", body: "Body 11", tag: "pp-n-11", link: "/notifications?reply=11#replies" },
      { id: 12, title: "Notification 12", body: "Body 12", tag: "pp-n-12", link: "/notifications?reply=12#replies" },
    ]);
  });

  it("never shows one at or below the mark twice", () => {
    const res = planPopups({ latestId: 12, popups: popups([11, 12]) }, { first: false, mark: 11, canShow: true });
    expect(res.show.map((p) => p.tag)).toEqual(["pp-n-12"]);
    expect(planPopups({ latestId: 12, popups: popups([11, 12]) }, { first: false, mark: 12, canShow: true })).toEqual({
      show: [],
      mark: 12,
    });
  });

  it("gives one batch pop-up when more than 3 are new, counting all of them, and jumps to the latest id", () => {
    const res = planPopups({ latestId: 60, popups: popups([21, 22, 23, 24, 25, 60], 30) }, { first: false, mark: 20, canShow: true });
    // The batch pop-up stands for many notifications: no id, so a click marks nothing read.
    expect(res).toEqual({
      show: [{ id: null, title: "30 new notifications", body: "Open the app to see them.", tag: "pp-n-batch", link: "/notifications" }],
      mark: 60,
    });
    const four = planPopups({ latestId: 4, popups: popups([1, 2, 3, 4]) }, { first: false, mark: 0, canShow: true });
    expect(four.show).toHaveLength(1);
    expect(four.show[0]!.title).toBe("4 new notifications");
    const three = planPopups({ latestId: 3, popups: popups([1, 2, 3]) }, { first: false, mark: 0, canShow: true });
    expect(three.show.map((p) => p.tag)).toEqual(["pp-n-1", "pp-n-2", "pp-n-3"]);
  });

  it("moves the mark without showing anything when pop-ups can't show now", () => {
    expect(planPopups({ latestId: 12, popups: popups([11, 12]) }, { first: false, mark: 10, canShow: false })).toEqual({
      show: [],
      mark: 12,
    });
  });
});

describe("showDesktopPopup", () => {
  class FakeNotification {
    static created: FakeNotification[] = [];
    static fail = false;
    onclick: (() => void) | null = null;
    closed = false;
    constructor(
      readonly title: string,
      readonly options: NotificationOptions,
    ) {
      if (FakeNotification.fail) throw new TypeError("Illegal constructor");
      FakeNotification.created.push(this);
    }
    close() {
      this.closed = true;
    }
  }

  const g = globalThis as unknown as { window?: unknown };
  const events: string[] = [];
  let focused = 0;

  function fakeWindow(storage: PopupStorage) {
    g.window = {
      Notification: FakeNotification,
      localStorage: storage,
      focus: () => void focused++,
      dispatchEvent: (e: Event) => {
        events.push(e.type);
        return true;
      },
    };
  }

  afterEach(() => {
    delete g.window;
    FakeNotification.created = [];
    FakeNotification.fail = false;
    events.length = 0;
    focused = 0;
  });

  it("shows the notification's own title and body with its tag, and a click focuses, closes and opens it by link and id", () => {
    fakeWindow(memoryStorage());
    const opened: Array<[string | null, number | null]> = [];
    const ok = showDesktopPopup(
      {
        id: 5,
        title: "New reply from Firma GmbH",
        body: "Anna Berg replied to “3D models”.",
        tag: "pp-n-5",
        link: "/notifications?reply=5#replies",
      },
      1,
      (link, id) => opened.push([link, id]),
    );
    expect(ok).toBe(true);
    const n = FakeNotification.created[0]!;
    expect(n.title).toBe("New reply from Firma GmbH");
    expect(n.options).toEqual({ body: "Anna Berg replied to “3D models”.", tag: "pp-n-5", data: { link: "/notifications?reply=5#replies" } });
    expect(n.options).not.toHaveProperty("renotify");
    expect(n.options).not.toHaveProperty("requireInteraction");
    n.onclick!();
    expect(focused).toBe(1);
    expect(n.closed).toBe(true);
    expect(opened).toEqual([["/notifications?reply=5#replies", 5]]);
  });

  it("passes no id for a pop-up without one (the batch pop-up, Settings' test pop-up)", () => {
    fakeWindow(memoryStorage());
    const opened: Array<[string | null, number | null]> = [];
    showDesktopPopup({ title: "Test pop-up", body: null, tag: "pp-test-popup", link: null }, 1, (link, id) => opened.push([link, id]));
    showDesktopPopup({ id: null, title: "30 new notifications", body: null, tag: "pp-n-batch", link: "/notifications" }, 1, (link, id) =>
      opened.push([link, id]),
    );
    for (const n of FakeNotification.created) n.onclick!();
    expect(opened).toEqual([
      [null, null],
      ["/notifications", null],
    ]);
  });

  it("remembers the browser as unsupported when the constructor throws, and tells Settings", () => {
    const storage = memoryStorage();
    fakeWindow(storage);
    FakeNotification.fail = true;
    expect(showDesktopPopup({ title: "t", body: null, tag: "pp-n-1", link: null }, 4, () => undefined)).toBe(false);
    expect(storage.data.get("pp.popups.unsupported.4")).toBe("1");
    expect(events).toEqual([POPUPS_CHANGED_EVENT]);
  });
});

describe("popupOpener: a click on a pop-up marks it read, then opens it (M4 review NOTIFY-05)", () => {
  function setup(markRead: (ids: number[]) => Promise<MarkReadResult>) {
    const log: string[] = [];
    const open = popupOpener({
      markRead: async (ids) => {
        log.push(`read ${ids.join(",")}`);
        return markRead(ids);
      },
      onMarked: () => log.push("bell refreshed"),
      onError: (message) => log.push(`error: ${message}`),
      open: (link) => log.push(`open ${link}`),
    });
    return { log, open };
  }

  it("marks that one notification read before opening its link, and refreshes the bell", async () => {
    const { log, open } = setup(async () => ({ ok: true }));
    await open("/notifications?reply=5#replies", 5);
    expect(log).toEqual(["read 5", "bell refreshed", "open /notifications?reply=5#replies"]);
  });

  it("marks nothing for the batch pop-up (no id) and still opens it", async () => {
    const { log, open } = setup(async () => ({ ok: true }));
    await open("/notifications", null);
    expect(log).toEqual(["open /notifications"]);
  });

  it("still opens the link when marking fails, and says why when the app answered", async () => {
    const refused = setup(async () => ({ ok: false, error: "Sign in again." }));
    await refused.open("/notifications?reply=7#replies", 7);
    expect(refused.log).toEqual(["read 7", "error: Sign in again.", "open /notifications?reply=7#replies"]);

    const offline = setup(async () => {
      throw new TypeError("Failed to fetch");
    });
    await offline.open("/campaigns/3", 8);
    expect(offline.log).toEqual(["read 8", "open /campaigns/3"]);
  });
});

describe("the bell's waiting line", () => {
  it("counts replies waiting for your answer", () => {
    expect(waitingRepliesText(0)).toBeNull();
    expect(waitingRepliesText(1)).toBe("1 reply waiting for your answer");
    expect(waitingRepliesText(3)).toBe("3 replies waiting for your answer");
    expect(waitingRepliesText(1200)).toBe("1,200 replies waiting for your answer");
    expect(waitingRepliesText(Number.NaN)).toBeNull();
  });
});
