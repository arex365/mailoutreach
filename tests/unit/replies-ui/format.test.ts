import { describe, expect, it } from "vitest";
import {
  addSenderText,
  defaultReplyScope,
  notificationsHref,
  parseReplyScope,
  replyBadgeText,
  replyMetaParts,
  replySenderText,
} from "@/components/replies/format";

/** The Notifications page's words and links (M4-DESIGN §9.1). */

describe("notificationsHref", () => {
  it("leaves the defaults out and keeps the other parts", () => {
    expect(notificationsHref()).toBe("/notifications");
    expect(notificationsHref({ filter: "all", page: 1, rpage: 1, scope: null, reply: null })).toBe("/notifications");
    expect(notificationsHref({ filter: "replies", page: 2 }, "all-notifications")).toBe("/notifications?filter=replies&page=2#all-notifications");
    expect(notificationsHref({ scope: "mine", rpage: 3, reply: 42 }, "replies")).toBe("/notifications?reply=42&scope=mine&rpage=3#replies");
    expect(notificationsHref({}, "on-hold")).toBe("/notifications#on-hold");
  });
});

describe("the waiting list's view", () => {
  it("defaults to Everyone's for the Owner and Yours for Members; reads only known values", () => {
    expect(defaultReplyScope("OWNER")).toBe("everyone");
    expect(defaultReplyScope("MEMBER")).toBe("mine");
    expect(parseReplyScope("mine")).toBe("mine");
    expect(parseReplyScope("everyone")).toBe("everyone");
    expect(parseReplyScope("all")).toBeNull();
    expect(parseReplyScope(undefined)).toBeNull();
  });
});

describe("the card's first line and badge", () => {
  const company = { id: 1042, name: "Firma GmbH" };
  it("names a contact by name, an unknown colleague by address with 'not in your contacts', unlinked mail by address", () => {
    expect(replySenderText({ fromEmail: "anna@firma.de", fromName: "Anna Berg", fromIsContact: true, company })).toBe("Anna Berg");
    expect(replySenderText({ fromEmail: "jonas@firma.de", fromName: null, fromIsContact: false, company })).toBe("jonas@firma.de (not in your contacts)");
    expect(replySenderText({ fromEmail: "info@firma.de", fromName: null, fromIsContact: true, company })).toBe("info@firma.de");
    expect(replySenderText({ fromEmail: "jonas@firma.de", fromName: null, fromIsContact: false, company: null })).toBe("jonas@firma.de");
  });

  it("uses the A6 badge words", () => {
    expect(replyBadgeText("REPLY")).toBe("Reply");
    expect(replyBadgeText("POSSIBLE_REPLY")).toBe("Real reply?");
    expect(replyBadgeText("UNLINKED")).toBe("Reply we couldn't link to a company");
  });

  it("builds 'Add … to …'", () => {
    expect(addSenderText({ fromEmail: "jonas@firma.de", company })).toBe("Add jonas@firma.de to Firma GmbH");
  });
});

describe("the card's meta line", () => {
  const base = { receivedAgo: "2 hours ago", subject: "Re: 3D models for your shop", senderName: "Ali", assigneeName: "Ali" };
  it("a linked reply: when, what, campaign, step and sender; Everyone's adds who it waits for", () => {
    const linked = { ...base, campaign: { id: 1, name: "Germany Q4", step: 1 } };
    expect(replyMetaParts(linked, { showAssignee: false }).join(" · ")).toBe(
      "Replied 2 hours ago to “Re: 3D models for your shop” · Germany Q4 · follow-up 1 · sent by Ali",
    );
    expect(replyMetaParts(linked, { showAssignee: true }).join(" · ")).toBe(
      "Replied 2 hours ago to “Re: 3D models for your shop” · Germany Q4 · follow-up 1 · sent by Ali · waiting for Ali",
    );
    expect(replyMetaParts({ ...linked, campaign: { id: 1, name: "Germany Q4", step: 0 } }, { showAssignee: false })[2]).toBe("first email");
  });

  it("a message not linked to one of our emails", () => {
    expect(replyMetaParts({ ...base, subject: "  Your   3D offer ", campaign: null, senderName: null }, { showAssignee: true }).join(" · ")).toBe(
      "Received 2 hours ago: “Your 3D offer” · waiting for Ali",
    );
    expect(replyMetaParts({ ...base, subject: "", campaign: null, assigneeName: null }, { showAssignee: true })).toEqual([
      "Received 2 hours ago: “(no subject)”",
    ]);
  });
});
