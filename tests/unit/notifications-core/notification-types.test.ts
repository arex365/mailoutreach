import { describe, expect, it } from "vitest";
import {
  DEFAULT_POPUP_GROUPS,
  NOTIFICATION_FILTERS,
  NOTIFICATION_FILTER_LABELS,
  OUTAGE_HOLD_NOTIFICATION,
  POPUP_GROUPS,
  POPUP_GROUP_TYPES,
  REPLY_NOTIFICATION,
  notificationFilterOf,
  parseNotificationFilter,
  popupGroupOf,
  popupTypesFor,
  readNotifyPrefs,
} from "@/core/notification-types";

/** Tests for the step-C contract file (M4-DESIGN §8.5; P1 owns them). */

describe("readNotifyPrefs", () => {
  it("missing or unreadable prefs give the default: replies pop up", () => {
    expect(DEFAULT_POPUP_GROUPS).toEqual(["reply"]);
    for (const v of [null, undefined, "x", 5, [], {}]) {
      expect(readNotifyPrefs(v)).toEqual({ popupGroups: ["reply"], desktopReplies: false });
    }
  });

  it("keeps the known groups in a fixed order and drops junk", () => {
    expect(readNotifyPrefs({ popupGroups: ["sending", "junk", "outage", 3, "outage"] })).toEqual({
      popupGroups: ["outage", "sending"],
      desktopReplies: false,
    });
    expect(readNotifyPrefs({ popupGroups: [] }).popupGroups).toEqual([]);
    expect(readNotifyPrefs({ popupGroups: "reply" }).popupGroups).toEqual(["reply"]);
  });

  it("keeps the Milestone 1–3 switch as the per-browser default", () => {
    expect(readNotifyPrefs({ desktopReplies: true })).toEqual({ popupGroups: ["reply"], desktopReplies: true });
    expect(readNotifyPrefs({ desktopReplies: "yes" }).desktopReplies).toBe(false);
    expect(readNotifyPrefs({ popupGroups: ["campaign"], desktopReplies: true })).toEqual({ popupGroups: ["campaign"], desktopReplies: true });
  });
});

describe("popupTypesFor and popupGroupOf", () => {
  it("the reply group covers every reply type that asks someone to act, including reply.attention and reply.summary", () => {
    expect(popupTypesFor(["reply"], "MEMBER")).toEqual([
      REPLY_NOTIFICATION.received,
      REPLY_NOTIFICATION.possible,
      REPLY_NOTIFICATION.unlinked,
      REPLY_NOTIFICATION.attention,
      REPLY_NOTIFICATION.summary,
      // MAIN-DOMAIN-DESIGN O33: own-mailbox mode's "follow-ups wait for today's inbox check".
      REPLY_NOTIFICATION.inboxCheck,
    ]);
    expect(REPLY_NOTIFICATION.inboxCheck).toBe("reply.inboxCheck");
    expect(popupTypesFor(["reply"], "MEMBER")).not.toContain(REPLY_NOTIFICATION.bounce);
  });

  it("drops the Owner-only 'sending' group for Members", () => {
    expect(popupTypesFor(["sending"], "OWNER")).toEqual(["sending.paused", "sending.warning", "email.complained"]);
    expect(popupTypesFor(["sending"], "MEMBER")).toEqual([]);
    expect(popupTypesFor([...POPUP_GROUPS], "MEMBER")).not.toContain("sending.paused");
    expect(popupTypesFor(["outage", "campaign"], "MEMBER")).toEqual([OUTAGE_HOLD_NOTIFICATION, "campaign.finished"]);
  });

  it("finds the group of a type", () => {
    expect(popupGroupOf("reply.summary")).toBe("reply");
    expect(popupGroupOf("outage.hold")).toBe("outage");
    expect(popupGroupOf("campaign.finished")).toBe("campaign");
    expect(popupGroupOf("email.complained")).toBe("sending");
    expect(popupGroupOf("reply.bounce")).toBeNull();
    expect(popupGroupOf("user.invited")).toBeNull();
    for (const g of POPUP_GROUPS) for (const t of POPUP_GROUP_TYPES[g]) expect(popupGroupOf(t)).toBe(g);
  });
});

describe("notification filters", () => {
  it("notificationFilterOf sorts types into Replies, Campaigns and Sending and system", () => {
    for (const t of Object.values(REPLY_NOTIFICATION)) expect(notificationFilterOf(t)).toBe("replies");
    expect(notificationFilterOf("campaign.finished")).toBe("campaigns");
    expect(notificationFilterOf("campaign.reservationsExpired")).toBe("campaigns");
    expect(notificationFilterOf("outage.hold")).toBe("campaigns");
    expect(notificationFilterOf("email.unconfirmed")).toBe("campaigns");
    expect(notificationFilterOf("sending.paused")).toBe("system");
    expect(notificationFilterOf("email.complained")).toBe("system");
    expect(notificationFilterOf("backup.failed")).toBe("system");
  });

  it("parseNotificationFilter accepts the five filters only", () => {
    expect(NOTIFICATION_FILTERS).toEqual(["all", "unread", "replies", "campaigns", "system"]);
    for (const f of NOTIFICATION_FILTERS) expect(parseNotificationFilter(f)).toBe(f);
    expect(parseNotificationFilter("junk")).toBe("all");
    expect(parseNotificationFilter(undefined)).toBe("all");
    expect(parseNotificationFilter(["replies"])).toBe("all");
    expect(NOTIFICATION_FILTER_LABELS).toEqual({
      all: "All",
      unread: "Unread",
      replies: "Replies",
      campaigns: "Campaigns",
      system: "Sending and system",
    });
  });
});
