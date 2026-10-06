import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChecklistRow } from "@/core/system-state";
import type { ConnectionView, ModeOptionView, PauseView, ReplyTestView, SenderAddressView } from "@/components/settings/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
  usePathname: () => "/settings/domain",
}));
vi.mock("@/app/(app)/settings/domain/actions", () => ({
  applyRecommendedSettingsAction: vi.fn(),
  checkDomainAgainAction: vi.fn(),
  sendReplyTestAction: vi.fn(),
  saveReplyTestAnswersAction: vi.fn(),
  decideReplyTestAction: vi.fn(),
  switchUnsubscribeSetupAction: vi.fn(),
  saveDomainAgeAction: vi.fn(),
}));
vi.mock("@/app/(app)/settings/sending/actions", () => ({
  connectMailgunAction: vi.fn(),
  forgetMailgunKeysAction: vi.fn(),
  removeSendingKeyAction: vi.fn(),
  setSendingModeAction: vi.fn(),
  saveTestListAction: vi.fn(),
  pauseAllAction: vi.fn(),
  resumeSendingAction: vi.fn(),
  saveRetentionAction: vi.fn(),
  checkWithMailgunAction: vi.fn(),
  switchToDryRunAction: vi.fn(),
}));
vi.mock("@/app/(app)/settings/profile/actions", () => ({ updateProfileAction: vi.fn(), changePasswordAction: vi.fn() }));

const { OWNER_SETTINGS } = await import("@/components/settings/settings-nav");
const { AccessLinkDisplay, PUBLIC_ADDRESS_HINT } = await import("@/components/settings/access-link-display");
const { Checklist, SetupSteps } = await import("@/components/settings/domain/checklist");
const { ReplyTestSection } = await import("@/components/settings/domain/reply-test-section");
const { ProfileForm, profileFromLineText, replyInboxFieldTexts, senderAddressFieldTexts, signatureHintText } = await import(
  "@/components/settings/profile-form"
);
const { PauseCard } = await import("@/components/settings/sending/pause-card");
const { ConnectionForm } = await import("@/components/settings/sending/connection-form");
const { SendingModeForm } = await import("@/components/settings/sending/sending-mode-form");
const { TestListEditor } = await import("@/components/settings/sending/test-list-editor");

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const text = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
/** Orange buttons (PLAN A6: only the page's primary action is orange; radios' "selected" marks may be too). */
const ORANGE = /data-variant="default"/g;

describe("settings navigation", () => {
  it("lists the five Owner sending pages first, in order, then AI (after Email footer), Team and System", () => {
    expect(OWNER_SETTINGS.map((i) => [i.label, i.href])).toEqual([
      ["Sending & Mailgun", "/settings/sending"],
      ["Domain checklist", "/settings/domain"],
      ["Limits & warm-up", "/settings/limits"],
      ["Deliverability", "/settings/deliverability"],
      ["Email footer", "/settings/footer"],
      ["AI", "/settings/ai"],
      ["Team", "/settings/team"],
      ["System", "/settings/system"],
    ]);
  });
});

describe("the Team page's access link", () => {
  it("points at the public address setup instead of a milestone", () => {
    const out = text(
      html(
        createElement(AccessLinkDisplay, {
          result: {
            purpose: "INVITE",
            name: "Ali",
            email: "ali@x.com",
            primary: { kind: "office", url: "http://192.168.1.5:3000/invite/abc" },
            office: null,
            officeIsLocalOnly: false,
            expiresText: "26 Sept 2026, 14:02",
          },
        }),
      ),
    );
    expect(out).toContain(PUBLIC_ADDRESS_HINT);
    // M6-DESIGN §5.2: the one public-address sentence, which also names update.bat for the Windows services.
    expect(PUBLIC_ADDRESS_HINT).toBe(
      "For a link that works anywhere, follow the Cloudflare guide (docs\\setup\\3-cloudflare.md), then run setup.bat again (and update.bat if the app runs as a Windows service).",
    );
    expect(out).not.toContain("Milestone 3");
  });
});

const row = (r: Partial<ChecklistRow> & Pick<ChecklistRow, "key" | "group" | "status" | "title">): ChecklistRow => ({
  text: "",
  fix: null,
  records: [],
  detail: null,
  ...r,
});

describe("the Domain checklist", () => {
  it("shows each status in words, the fix and copyable records when something isn't done, and the sender routes", () => {
    const rows: ChecklistRow[] = [
      row({ key: "mailgun-domain", group: "mailgun", status: "ok", title: "Mailgun knows your domain", text: "Mailgun has your domain (EU)." }),
      row({
        key: "spf",
        group: "dns",
        status: "bad",
        title: "Mailgun may send for send.example.com (SPF)",
        text: "No SPF record found.",
        fix: "Add this TXT record.",
        records: [{ type: "TXT", name: "@", fqdn: "send.example.com", value: "v=spf1 include:eu.mailgun.org ~all", priority: null, found: ["v=spf1 -all"] }],
        detail: "1.1.1.1: NXDOMAIN",
      }),
      row({ key: "dkim", group: "dns", status: "warn", title: "Your emails are signed (DKIM)", text: "Still spreading.", fix: "Check again in 30 minutes." }),
      row({ key: "mx", group: "dns", status: "unknown", title: "Replies reach the app (MX)" }),
      row({ key: "reply-routes", group: "settings", status: "bad", title: "Replies reach each sender" }),
    ];
    const out = html(
      createElement(Checklist, {
        rows,
        domain: "send.example.com",
        domainRegisteredOn: null,
        senders: [
          {
            name: "Ali",
            address: "ali@send.example.com",
            forwardTo: "ali.khan@gmail.com",
            status: "bad",
            statusText: "Mailgun won't forward replies to ali.khan@gmail.com: it's on Mailgun's bounce list.",
            removeHref: "/settings/deliverability?q=ali.khan%40gmail.com",
            values: {
              expression: 'match_recipient("^ali@send\\.example\\.com$")',
              actions: ['forward("ali.khan@gmail.com")', 'store(notify="https://o.example.com/api/webhooks/mailgun/inbound")', "stop()"],
              priority: 10,
              description: "outreach-app:sender:12",
            },
          },
        ],
      }),
    );
    const t = text(out);
    for (const s of ["Mailgun", "DNS records", "Mailgun settings", "Optional", "Done", "Not done", "Needs a look", "Couldn't check right now."]) {
      expect(t).toContain(s);
    }
    expect(t).toContain("Add this TXT record.");
    expect(out).toContain("v=spf1 include:eu.mailgun.org ~all");
    expect(t).toContain("1.1.1.1: NXDOMAIN");
    expect(t).toContain("Remove it");
    expect(out).toContain('href="/settings/deliverability?q=ali.khan%40gmail.com"');
    expect(out).toContain("outreach-app:sender:12");
    expect(t).toContain("When did you buy send.example.com?");
    // The ok row doesn't show a fix; nothing here is orange.
    expect(out.match(ORANGE)).toBeNull();
  });

  it("says when the domain hasn't been checked yet", () => {
    const t = text(html(createElement(Checklist, { rows: [], senders: [], domain: "send.example.com", domainRegisteredOn: "2026-08-01" })));
    expect(t).toContain("The app hasn't checked send.example.com yet. Click Check again, or wait a minute after connecting.");
    expect(t).toContain("Nobody has a sending address yet.");
  });

  it("lists the last Apply steps", () => {
    const t = text(
      html(
        createElement(SetupSteps, {
          line: "Last applied 5 minutes ago by Arslan.",
          steps: [
            { key: "tracking-open", ok: true, text: "Open tracking is off.", detail: null },
            { key: "unsubscribe", ok: false, text: "Mailgun kept its own unsubscribe footer.", detail: "footers" },
            { key: "https", ok: null, text: "Secure unsubscribe links switch on once the certificate is ready.", detail: null },
          ],
        }),
      ),
    );
    expect(t).toContain("Last applied 5 minutes ago by Arslan.");
    expect(t).toContain("Done");
    expect(t).toContain("Not done");
    expect(t).toContain("Waiting");
  });
});

const baseReply: ReplyTestView = {
  domain: "send.example.com",
  setup: "A",
  decided: null,
  blockers: [],
  testList: ["t.outlook@outlook.com", "t.gmail@gmail.com"],
  mailboxes: [
    { address: "t.outlook@outlook.com", providerLabel: "Outlook.com", testEmail: "Delivered", delivered: true, replyStored: true, inboxOk: true, authOk: "pass", authFromHeaders: false },
    { address: "t.gmail@gmail.com", providerLabel: "Gmail", testEmail: "Sent, waiting for delivery", delivered: false, replyStored: false, inboxOk: null, authOk: "unsure", authFromHeaders: false },
  ],
  headersOk: null,
  unsubscribeSeen: false,
  verdict: { status: "incomplete", missing: ["t.gmail@gmail.com: the test email hasn't been delivered yet."] },
  ownerAddress: "arslan@send.example.com",
  runningJobId: null,
};

describe("the Reply test section", () => {
  it("in progress: the steps, each mailbox's facts and questions, and the paste box for Not sure", () => {
    const out = html(createElement(ReplyTestSection, { view: baseReply }));
    const t = text(out);
    expect(t).toContain("Before live campaigns can start, check that replies still arrive cleanly and unsubscribe links work (about 15 minutes).");
    expect(t).toContain("Not tested yet. Live campaigns start once this passes.");
    expect(t).toContain("Send test emails to my test list");
    expect(t).toContain("Test email");
    expect(t).toContain("Reply reached the app");
    expect(t).toContain("Did the reply arrive in your reply inbox, not in spam?");
    expect(t).toContain("Paste the email's original headers here, and the app reads them for you.");
    expect(t).toContain("Not finished");
    expect(t).toContain("Save the result");
    expect(t).toContain("Try Setup B (check only)");
    // "Save the result" is the section's action but never orange: the page's primary is Apply.
    expect(out.match(ORANGE)).toBeNull();
  });

  it("blocked: lists what's missing and disables the send button; empty test list says where to add one", () => {
    const out = html(
      createElement(ReplyTestSection, {
        view: { ...baseReply, blockers: ["Set sending to Test mode or Live first: the test emails go through Mailgun."], testList: [], mailboxes: [] },
      }),
    );
    const t = text(out);
    expect(t).toContain("Before you start");
    expect(t).toContain("Set sending to Test mode or Live first");
    expect(t).toContain("Add your test mailboxes first in Settings › Sending & Mailgun.");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Send test emails to my test list/);
  });

  it("empty test list: the sentence to add mailboxes shows once, not again under Before you start or in the result", () => {
    const sentence = "Add your test mailboxes first in Settings › Sending & Mailgun.";
    const t = text(
      html(
        createElement(ReplyTestSection, {
          view: {
            ...baseReply,
            testList: [],
            mailboxes: [],
            blockers: [sentence],
            verdict: { status: "incomplete", missing: [sentence] },
          },
        }),
      ),
    );
    expect(t.split(sentence).length - 1).toBe(1);
    expect(t).not.toContain("Before you start");
    expect(t).toContain("Open Sending & Mailgun");
    // Other blockers still show.
    const withOther = text(
      html(createElement(ReplyTestSection, { view: { ...baseReply, testList: [], mailboxes: [], blockers: [sentence, "Remote access doesn't work yet. Finish the Cloudflare guide."] } })),
    );
    expect(withOther).toContain("Before you start");
    expect(withOther).toContain("Remote access doesn't work yet.");
    expect(withOther.split(sentence).length - 1).toBe(1);
  });

  it("passed and failed", () => {
    const passed = text(
      html(
        createElement(ReplyTestSection, {
          view: {
            ...baseReply,
            decided: { status: "passed", text: "Setup A passed on 24 Sep: replies arrive in your inbox, and unsubscribe links work." },
            verdict: { status: "passed", missing: [] },
          },
        }),
      ),
    );
    expect(passed).toContain("Setup A passed on 24 Sep: replies arrive in your inbox, and unsubscribe links work.");
    const failed = text(
      html(
        createElement(ReplyTestSection, {
          view: { ...baseReply, verdict: { status: "failed", missing: ["t.outlook@outlook.com: the reply didn't pass dkim or arc."] } },
        }),
      ),
    );
    expect(failed).toContain("Setup A didn't pass. The usual fix is a separate reply address such as ali@reply.send.example.com.");
    expect(failed).toContain("This needs a small change to the app and your OK.");
  });
});

describe("My profile › Sending address", () => {
  const initial = { name: "Ali", email: "ali@polygonparadise.com", senderDisplayName: "Ali from Polygon Paradise", replyInbox: "ali.khan@gmail.com", signature: "", timeZone: "Europe/Berlin", senderLocalPart: "ali" };
  const zones = [{ value: "Europe/Berlin", label: "Europe/Berlin" }];
  const render = (sender: SenderAddressView) => text(html(createElement(ProfileForm, { initial, zones, sender })));

  it("before the Owner connects a domain", () => {
    expect(render({ domain: null, current: null, suggestion: "ali", statusLine: null, statusTone: null, blockedText: null })).toContain(
      "Your sending address is set up once the Owner connects the sending domain in Settings › Sending & Mailgun.",
    );
  });

  it("with an address: the domain after the box, the hint and the route status", () => {
    const t = render({
      domain: "send.example.com",
      current: "ali@send.example.com",
      suggestion: "ali",
      statusLine: "Reply route: working (checked 5 minutes ago)",
      statusTone: "ok",
      blockedText: null,
    });
    expect(t).toContain("@send.example.com");
    expect(t).toContain("People see this address in their inbox. Replies to it are forwarded to your reply inbox.");
    expect(t).toContain("Reply route: working (checked 5 minutes ago)");
    expect(t).not.toContain("Milestone 3");
  });

  it("blocked while campaigns run", () => {
    const out = html(
      createElement(ProfileForm, {
        initial,
        zones,
        sender: {
          domain: "send.example.com",
          current: "ali@send.example.com",
          suggestion: "ali",
          statusLine: "Reply route: Being set up…",
          statusTone: "pending",
          blockedText: "You can't change your sending address while your campaigns are running or paused (Q4). Wait until they finish, or ask the Owner to cancel them.",
        },
      }),
    );
    expect(text(out)).toContain("You can't change your sending address while your campaigns are running or paused (Q4).");
    // Read-only rather than disabled, so the whole address stays readable (a disabled group fades its @domain).
    expect(out).toMatch(/id="senderLocalPart"[^>]*readOnly=""|readOnly=""[^>]*id="senderLocalPart"/i);
    expect(out).not.toMatch(/id="senderLocalPart"[^>]*disabled=""/);
  });

  // SHARED-FROM-DESIGN §3.6 (F19): the field's words in both modes.
  const perPersonHint = "People see this address in their inbox. Replies to it are forwarded to your reply inbox.";
  const sharedHint =
    "People see contact@example.com as the sender, with your display name. When they press Reply, their answer goes to this address: the app records it, and Mailgun forwards it to your reply inbox.";
  const signature = "Plain text. It's added where a template says {{sender_signature}}.";

  it("per-person mode keeps 'Sending address', its hint, its empty line and the plain signature hint", () => {
    const view: SenderAddressView = { domain: "send.example.com", current: null, suggestion: "ali", statusLine: null, statusTone: null, blockedText: null };
    for (const sender of [view, { ...view, teamFrom: null }]) {
      const t = render(sender);
      expect(t).toContain("Sending address");
      expect(t).not.toContain("Reply address");
      expect(t).toContain(perPersonHint);
      expect(t).toContain("No sending address yet. Type the name before the @ and save your profile.");
      expect(t).toContain(signature);
      expect(t).not.toContain("If your signature shows an email address");
    }
    expect(senderAddressFieldTexts(null)).toEqual({
      label: "Sending address",
      hint: perPersonHint,
      noneYet: "No sending address yet. Type the name before the @ and save your profile.",
    });
    expect(signatureHintText(undefined, "ali@send.example.com")).toBe(signature);
  });

  it("shared-From mode: 'Reply address', a hint naming the From address, its empty line and the signature hint", () => {
    const shared: SenderAddressView = {
      domain: "mail.example.com",
      current: "ali@mail.example.com",
      suggestion: "ali",
      statusLine: "Reply route: working (checked 5 minutes ago)",
      statusTone: "ok",
      blockedText: null,
      teamFrom: "contact@example.com",
    };
    const t = render(shared);
    expect(t).toContain("Reply address");
    expect(t).not.toMatch(/sending address/i);
    expect(t).toContain("@mail.example.com");
    expect(t).toContain(sharedHint);
    expect(t).toContain(`${signature} If your signature shows an email address, use your reply address (ali@mail.example.com), so answers reach the app.`);
    // The reply route's status lines are the same in both modes.
    expect(t).toContain("Reply route: working (checked 5 minutes ago)");

    const none = render({ ...shared, current: null, statusLine: null, statusTone: null });
    expect(none).toContain("No reply address yet. Type the name before the @ and save your profile.");
    expect(none).toContain(`${signature} If your signature shows an email address, use your reply address, so answers reach the app.`);
    expect(senderAddressFieldTexts("contact@example.com")).toEqual({
      label: "Reply address",
      hint: sharedHint,
      noneYet: "No reply address yet. Type the name before the @ and save your profile.",
    });
  });

  // MAIN-DOMAIN-DESIGN §3.7: own-mailbox mode has no address field; the From line, the test inbox and the signature hint.
  const ownView: SenderAddressView = { domain: "example.com", current: null, suggestion: "ali", statusLine: null, statusTone: null, blockedText: null };

  it("own-mailbox mode: the From line instead of the field, the inbox for test emails, the signature hint", () => {
    const out = html(createElement(ProfileForm, { initial, zones, sender: { ...ownView, ownFrom: "contact@example.com" } }));
    const t = text(out).replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    expect(t).toContain('Your emails show "Ali from Polygon Paradise <contact@example.com>". Replies go straight to contact@example.com.');
    expect(out).not.toContain('id="senderLocalPart"');
    expect(t).not.toMatch(/sending address|reply address|reply route/i);
    expect(t).toContain("Inbox for your test emails");
    expect(t).toContain("Send me a test sends your test emails here. Replies to your campaigns go to contact@example.com.");
    expect(t).not.toContain("Replies to your campaigns are forwarded here.");
    expect(t).toContain(`${signature} If your signature shows an email address, use contact@example.com.`);
    expect(t).not.toContain("so answers reach the app");
  });

  it("own-mailbox mode without a fitting From: the Owner sets it; the hints leave the address out", () => {
    const t = render({ ...ownView, ownFrom: null });
    expect(t).toContain("Your emails will show your display name with the From address the Owner sets in Settings › Sending & Mailgun.");
    expect(t).toContain("Inbox for your test emails");
    expect(t).toContain("Send me a test sends your test emails here.");
    expect(t).not.toContain("Replies to your campaigns");
    expect(t).not.toContain("If your signature shows an email address");
    expect(t).not.toMatch(/sending address|reply address/i);
  });

  it("the helpers: app mode's words are unchanged when no own From is given", () => {
    expect(replyInboxFieldTexts(undefined)).toEqual({ label: "Reply inbox", hint: "Replies to your campaigns are forwarded here." });
    expect(replyInboxFieldTexts("contact@example.com")).toEqual({
      label: "Inbox for your test emails",
      hint: "Send me a test sends your test emails here. Replies to your campaigns go to contact@example.com.",
    });
    expect(signatureHintText(null, null)).toBe(signature);
    expect(signatureHintText(null, null, null)).toBe(signature);
    expect(signatureHintText(null, null, "contact@example.com")).toBe(`${signature} If your signature shows an email address, use contact@example.com.`);
    expect(profileFromLineText("Arslan from Polygon Paradise", "contact@example.com")).toBe(
      'Your emails show "Arslan from Polygon Paradise <contact@example.com>". Replies go straight to contact@example.com.',
    );
    // App mode (no ownFrom at all) still renders the field and "Reply inbox".
    const app = render({ ...ownView, current: "ali@example.com" });
    expect(app).toContain("Sending address");
    expect(app).toContain("Reply inbox");
    expect(app).toContain("Replies to your campaigns are forwarded here.");
  });
});

describe("Settings › Sending & Mailgun pieces", () => {
  it("the pause card: why, what to do, Resume as the one orange button", () => {
    const view: PauseView = {
      reason: "7 of the last 200 emails bounced",
      fixText: "Your limit is 6. Open the bounced list in Settings › Deliverability, then click Resume.",
      sinceText: "Paused 5 minutes ago by the app.",
      details: ["Also: Mailgun stopped accepting emails (2 minutes ago)."],
      healthLink: { href: "/settings/deliverability#bounces", label: "Bounces counted now" },
      restoreText: null,
      dialog: ["7 of the last 200 emails bounced. Resuming starts a fresh count: only new bounces count toward the limit."],
      confirmLabel: null,
    };
    const out = html(createElement(PauseCard, { view }));
    const t = text(out);
    expect(t).toContain("Sending is paused: 7 of the last 200 emails bounced.");
    expect(t).toContain("Paused 5 minutes ago by the app.");
    expect(t).toContain("Bounces counted now");
    expect(out.match(ORANGE)?.length).toBe(1);
  });

  it("the pause card: a pause by hand reads 'Sending is paused by <name>', like the top bar (SPEC-04)", () => {
    const view: PauseView = {
      reason: "by Arslan",
      fixText: "Click Resume sending in Settings › Sending & Mailgun when you're ready.",
      sinceText: "Paused just now by Arslan.",
      details: [],
      healthLink: null,
      restoreText: null,
      dialog: ["If the problem is still there, sending pauses again."],
      confirmLabel: null,
    };
    const t = text(html(createElement(PauseCard, { view })));
    expect(t).toContain("Sending is paused by Arslan.");
    expect(t).not.toContain("paused: by");
  });

  it("the connection form: status, hints, and Save and connect as the primary while not connected", () => {
    const view: ConnectionView = {
      connected: false,
      statusLine: "Not connected yet.",
      region: "EU",
      domain: "",
      keyLast4: null,
      hasSendingKey: false,
      logRetentionDays: 5,
      messageRetentionDays: 1,
      primary: true,
    };
    const out = html(createElement(ConnectionForm, { view }));
    const t = text(out);
    expect(t).toContain("Not connected yet.");
    expect(t).toContain("The region you chose when you added the domain in Mailgun. It can't be changed there later.");
    expect(t).toContain("A key with the Developer role, from Mailgun › API Security. Stored encrypted and never shown again.");
    expect(t).not.toContain("Remove saved keys");
    expect(out.match(ORANGE)?.length).toBe(1);
    const connected = html(createElement(ConnectionForm, { view: { ...view, connected: true, primary: false, keyLast4: "1a2b", statusLine: "Connected" } }));
    expect(connected.match(ORANGE)).toBeNull();
    expect(text(connected)).toContain("Remove saved keys");
    expect(text(connected)).toContain("Leave empty to keep the saved key.");
    const withSendingKeyHtml = html(createElement(ConnectionForm, { view: { ...view, connected: true, primary: false, keyLast4: "1a2b", hasSendingKey: true } }));
    const withSendingKey = text(withSendingKeyHtml);
    expect(withSendingKey).toContain("It works for one domain only, so changing the sending domain removes it.");
    // Review SCREENS-01: the button the key pause names, only while a sending key is saved, never orange.
    expect(withSendingKey).toContain("To send with the API key instead, click Remove the sending key.");
    const removeButtons = [...withSendingKeyHtml.matchAll(/<button\b([^>]*)>((?:(?!<\/button>).)*)<\/button>/g)].filter(
      (m) => text(m[2]!) === "Remove the sending key",
    );
    expect(removeButtons).toHaveLength(1);
    expect(removeButtons[0]![1]).toContain('type="button"');
    expect(removeButtons[0]![1]).toContain('data-variant="outline"');
    expect(withSendingKeyHtml.match(ORANGE)).toBeNull();
    expect(text(connected)).not.toContain("Remove the sending key");
  });

  it("the sending mode shows what a mode still needs, and warns about an empty test list", () => {
    const options: ModeOptionView[] = [
      { key: "DRY_RUN", title: "Dry run", text: "Nothing leaves this PC.", blockers: [], warnings: [] },
      { key: "TEST", title: "Test mode", text: "Mailgun's test mode.", blockers: [], warnings: ["Your test list is empty, so nothing can be sent yet."] },
      { key: "LIVE", title: "Live (test list only)", text: "Real emails.", blockers: ["Mailgun hasn't confirmed your DNS records yet (Domain checklist)."], warnings: [] },
    ];
    const out = html(createElement(SendingModeForm, { current: "DRY_RUN", options, testList: [], activeCampaigns: [] }));
    const t = text(out);
    expect(t).toContain("Not available yet:");
    expect(t).toContain("Mailgun hasn't confirmed your DNS records yet (Domain checklist).");
    expect(t).toContain("Your test list is empty, so nothing can be sent yet.");
    expect(t).toContain("Save mode");
    expect(out.match(ORANGE)).toBeNull();
  });

  it("the test list: its empty state and its count", () => {
    const empty = html(createElement(TestListEditor, { addresses: [], warnings: [] }));
    expect(text(empty)).toContain(
      "No test addresses yet. Add two or three mailboxes that aren't your reply inbox, ideally one Gmail and one Outlook.com.",
    );
    // One "Add address" button, and it's the one that adds (the form's submit button).
    const buttons = [...empty.matchAll(/<button\b([^>]*)>((?:(?!<\/button>).)*)<\/button>/g)].filter((m) => text(m[2]!).includes("Add address"));
    expect(buttons).toHaveLength(1);
    expect(buttons[0]![1]).toContain('type="submit"');
    const t = text(html(createElement(TestListEditor, { addresses: ["a@gmail.com", "b@outlook.com", "c@yahoo.com"], warnings: [] })));
    expect(t).toContain("3 of 10");
    expect(t).toContain("Remove");
  });
});
