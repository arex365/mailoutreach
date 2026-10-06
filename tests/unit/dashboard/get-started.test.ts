import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GetStarted, getStartedView, mailgunStep, type GetStartedInput } from "@/components/dashboard/get-started";

/** Dashboard › "Get started" (M6-DESIGN §4.4), moved from Contacts with its "Connect Mailgun" step unchanged. */

describe("the Connect Mailgun step (M3-DESIGN §5.9, words unchanged)", () => {
  const notConnected = { practiceCopy: false, connected: false, domain: null };

  it("links the Owner to Settings › Sending & Mailgun until Mailgun is connected", () => {
    expect(mailgunStep(notConnected, true)).toEqual({
      title: "Connect Mailgun",
      text: "Add your sending domain and API key so campaigns can send real email. Until then, campaigns run as dry runs.",
      href: "/settings/sending",
      done: false,
      muted: false,
    });
  });

  it("tells a Member the Owner does it, without a link", () => {
    expect(mailgunStep(notConnected, false)).toMatchObject({
      text: "The Owner connects Mailgun in Settings › Sending & Mailgun. Until then, campaigns run as dry runs.",
      href: null,
      muted: true,
    });
  });

  it("is done once connected", () => {
    expect(mailgunStep({ practiceCopy: false, connected: true, domain: "send.example.com" }, true)).toMatchObject({
      title: "Mailgun connected",
      text: "Emails can go out from send.example.com.",
      href: "/settings/sending",
      done: true,
    });
    expect(mailgunStep({ practiceCopy: false, connected: true, domain: "send.example.com" }, false).href).toBeNull();
  });

  it("isn't needed in the practice copy", () => {
    expect(mailgunStep({ practiceCopy: true, connected: false, domain: null }, true)).toMatchObject({
      text: "Not needed here: the practice copy never sends real email, so campaigns run as dry runs.",
      href: null,
      muted: true,
    });
  });
});

const base: GetStartedInput = {
  role: "OWNER",
  practiceCopy: false,
  live: false,
  companies: 0,
  teamInvited: false,
  mailgun: { practiceCopy: false, connected: false, domain: null },
  secondFolderSet: false,
};

const keys = (input: GetStartedInput) => getStartedView(input)?.steps.map((s) => s.key) ?? null;
const primary = (input: GetStartedInput) => getStartedView(input)?.steps.filter((s) => s.primary).map((s) => s.key) ?? null;

describe("getStartedView: who sees it", () => {
  it("the Owner sees five steps until going live, whatever else is done", () => {
    expect(keys(base)).toEqual(["import", "team", "mailgun", "protect", "go-live"]);
    expect(getStartedView(base)?.description).toBe("Five steps to your first real campaign. You can come back to these any time.");
    const allDone = { ...base, companies: 40, teamInvited: true, mailgun: { practiceCopy: false, connected: true, domain: "send.example.com" }, secondFolderSet: true };
    expect(keys(allDone)).toEqual(["import", "team", "mailgun", "protect", "go-live"]);
    expect(getStartedView({ ...allDone, live: true })).toBeNull();
    // After a domain change ended go-live (G8) it is back, with steps 1–4 done.
    const back = getStartedView({ ...allDone, live: false })!;
    expect(back.steps.map((s) => s.done)).toEqual([true, true, true, true, false]);
    expect(back.steps.find((s) => s.primary)?.key).toBe("go-live");
  });

  it("a Member sees Import companies and the Mailgun step only while there are no companies", () => {
    const member = { ...base, role: "MEMBER" as const };
    expect(keys(member)).toEqual(["import", "mailgun"]);
    expect(getStartedView(member)?.description).toBe("Your first campaign starts with your companies.");
    expect(getStartedView({ ...member, companies: 1 })).toBeNull();
    expect(getStartedView({ ...member, companies: 1, live: true })).toBeNull();
  });

  it("the practice copy shows steps 1–3 to everyone while there are no companies", () => {
    const practice = { ...base, practiceCopy: true, mailgun: { practiceCopy: true, connected: false, domain: null } };
    expect(keys(practice)).toEqual(["import", "team", "mailgun"]);
    expect(keys({ ...practice, role: "MEMBER" })).toEqual(["import", "mailgun"]);
    expect(getStartedView(practice)?.description).toBe("Three steps to try everything here. Nothing is ever sent from the practice copy.");
    expect(getStartedView({ ...practice, companies: 3 })).toBeNull();
    // The practice copy never goes live: the Owner's card follows the companies, not the switch.
    expect(getStartedView({ ...practice, live: true })).not.toBeNull();
    expect(getStartedView(practice)?.steps[2]).toMatchObject({ muted: true, href: null, primary: false });
  });
});

describe("getStartedView: steps, done texts and the one primary link", () => {
  it("words each step and its done text", () => {
    const view = getStartedView({
      ...base,
      companies: 2,
      teamInvited: true,
      mailgun: { practiceCopy: false, connected: true, domain: "send.example.com" },
      secondFolderSet: true,
    })!;
    expect(view.steps).toEqual([
      { key: "import", title: "Companies imported", text: "Upload a spreadsheet or paste rows from Excel or Google Sheets.", done: true, href: "/import", muted: false, primary: false },
      { key: "team", title: "Team invited", text: "Create invite links for your teammates.", done: true, href: "/settings/team", muted: false, primary: false },
      { key: "mailgun", title: "Mailgun connected", text: "Emails can go out from send.example.com.", done: true, href: "/settings/sending", muted: false, primary: false },
      {
        key: "protect",
        title: "Second backup folder set",
        text: "Choose a second backup folder and keep a copy of the .env file somewhere safe.",
        done: true,
        href: "/settings/backups",
        muted: false,
        primary: false,
      },
      {
        key: "go-live",
        title: "Go live",
        text: "When the checklist is green, switch on Go live. Until then, real email only reaches your test list.",
        done: false,
        href: "/settings/sending#go-live",
        muted: false,
        primary: true,
      },
    ]);
    const fresh = getStartedView(base)!;
    expect(fresh.steps.map((s) => s.title)).toEqual(["Import companies", "Invite your team", "Connect Mailgun", "Protect your data", "Go live"]);
  });

  it("makes the first step not done the only primary one", () => {
    expect(primary(base)).toEqual(["import"]);
    expect(primary({ ...base, companies: 5 })).toEqual(["team"]);
    expect(primary({ ...base, companies: 5, teamInvited: true })).toEqual(["mailgun"]);
    expect(primary({ ...base, companies: 5, teamInvited: true, mailgun: { practiceCopy: false, connected: true, domain: null } })).toEqual([
      "protect",
    ]);
    // A step with nothing to click (a Member's Mailgun step) is never the primary one.
    expect(primary({ ...base, role: "MEMBER", companies: 0 })).toEqual(["import"]);
  });

  it("renders one orange link (a real Button), done ticks and no Hide this", () => {
    const html = renderToStaticMarkup(createElement(GetStarted, { view: getStartedView({ ...base, companies: 3 })! }));
    const buttons = html.match(/<a[^>]*data-slot="button"[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain('data-variant="default"');
    expect(buttons[0]).toContain('href="/settings/team"');
    expect(html).toContain('<h2 id="get-started-heading"');
    expect(html).toContain("Companies imported");
    expect(html).toContain("(done)");
    expect(html).not.toContain("Hide this");
    expect(html).not.toMatch(/Milestone/);
  });
});
