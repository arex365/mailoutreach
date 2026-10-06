import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChecklistFacts } from "@/core/dns/checklist";
import type { DnsAnswer } from "@/core/dns/types";
import type { ReplyTestView, SenderAddressView } from "@/components/settings/types";
import type { SenderChoice } from "@/server/services/campaigns/draft";
import type { GateInputs } from "@/server/services/reply-test";
import type { TeamFromState } from "@/server/services/mailgun/team-from";

/**
 * The vocabulary sweep (SHARED-FROM-DESIGN §3.6, F19, §8 P7): in shared-From mode each person's own address is their
 * "reply address", never their "sending address". Every text function that takes the words helper or `teamFrom` (the
 * §3.6 list, NoSenderAddressError, the launch problem, the test-send and reply-test sentences, the checklist's
 * reply-routes and reply-test texts, the switch-off dialog) and every screen piece that shows the address is called or
 * rendered in shared-From mode here, and none says "sending address" (case-insensitive). The same calls in per-person
 * mode still say it, so per-person mode is unchanged and the sweep can see the word. A last test lists every source
 * line of `src/**` that still spells the per-person word, so a new one is added on purpose.
 */

// Server Actions and the router can't load outside Next; nothing here calls them while rendering.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
  usePathname: () => "/settings",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/(app)/settings/profile/actions", () => ({ updateProfileAction: vi.fn(), changePasswordAction: vi.fn() }));
vi.mock("@/app/(app)/settings/limits/actions", () => ({ saveSenderCapsAction: vi.fn() }));
vi.mock("@/app/(app)/campaigns/[id]/setup/actions", () => ({ setSenderAction: vi.fn(), continueAction: vi.fn() }));
vi.mock("@/app/(app)/settings/domain/actions", () => ({
  applyRecommendedSettingsAction: vi.fn(),
  checkDomainAgainAction: vi.fn(),
  sendReplyTestAction: vi.fn(),
  saveReplyTestAnswersAction: vi.fn(),
  saveReplyTestOriginalAction: vi.fn(),
  decideReplyTestAction: vi.fn(),
  switchUnsubscribeSetupAction: vi.fn(),
  saveDomainAgeAction: vi.fn(),
}));
// launchModeProblems reads a few settings first; a test-mode launch needs nothing else from the database.
vi.mock("@/server/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/settings")>()),
  getSettings: vi.fn(async () => ({
    "practice.copy": false,
    "sending.testList": ["t.outlook@outlook.com", "t.gmail@gmail.com"],
    "mailgun.unsubscribeTest": null,
    "mailgun.domain": "send.example.com",
    "sending.goLive": false,
  })),
}));

const { senderAddressWords } = await import("@/core/sending/from-address");
const { buildChecklistRows } = await import("@/core/dns/checklist");
const { NoSenderAddressError, senderSnapshot } = await import("@/server/services/sending/addresses");
const { noSenderAddressText } = await import("@/server/services/test-send");
const { ownerAddressMissingText, replyTestBlockersFor } = await import("@/server/services/reply-test");
const sa = await import("@/server/services/sender-addresses");
const { launchModeProblems } = await import("@/server/services/campaigns/launch");
const { switchOffDialogText } = await import("@/app/(app)/settings/team/switch-off-text");
const { noReplyRoutesText, Checklist } = await import("@/components/settings/domain/checklist");
const { ProfileForm, senderAddressFieldTexts, signatureHintText } = await import("@/components/settings/profile-form");
const { SenderCapsForm } = await import("@/components/settings/limits/sender-caps-form");
const { SenderStep } = await import("@/components/campaign-wizard/sender-step");
const { ReplyTestSection } = await import("@/components/settings/domain/reply-test-section");

const D = "send.example.com";
const FROM = "contact@example.com";
const OWN = `ali@${D}`;
const PER_PERSON_WORD = /sending address/i;

const text = (markup: string) =>
  markup
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const render = (el: React.ReactElement) => text(renderToStaticMarkup(el));

/** Every string inside a value (objects, arrays, errors), for one "none says it" check per call. */
function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (v instanceof Error) return [v.message];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === "object") return Object.values(v).flatMap(strings);
  return [];
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a refusal");
}

/** The pure text functions, each in one mode: label → what it returns. */
function textFunctions(team: boolean): Record<string, unknown> {
  const teamFrom = team ? FROM : null;
  return {
    "senderAddressWords": senderAddressWords(team),
    "NoSenderAddressError": new NoSenderAddressError("Ali", { teamFrom: team }),
    "senderSnapshot (test mode, no address)": thrown(() =>
      senderSnapshot({ name: "Ali", email: "ali@polygonparadise.com", senderDisplayName: null }, "TEST", null, { teamFrom }),
    ),
    "noSenderAddressText (Send me a test)": noSenderAddressText("Ali", team),
    "ownerAddressMissingText (the reply test)": ownerAddressMissingText(team),
    "senderAddressNotYoursText": sa.senderAddressNotYoursText(team),
    "senderAddressBlockedText": sa.senderAddressBlockedText(["Germany Q4"], team),
    "profileSavedWithAddressText": sa.profileSavedWithAddressText(OWN, team),
    "profileSavedAddressUnchangedText": sa.profileSavedAddressUnchangedText("Someone else already uses it.", team),
    "noSenderAddressesText (Limits)": sa.noSenderAddressesText(team),
    "senderAddressActivityText (self)": sa.senderAddressActivityText({ actorName: "Ali", userName: "Ali", self: true, address: OWN }, team),
    "senderAddressActivityText (Owner)": sa.senderAddressActivityText({ actorName: "Arslan", userName: "Ali", self: false, address: OWN }, team),
    "senderAddressNoticeText": sa.senderAddressNoticeText("Ali", OWN, team),
    "switchOffDialogText": switchOffDialogText({
      name: "Ali",
      activeCampaigns: [{ id: 1, name: "Germany Q4", status: "RUNNING" }],
      waitingReplies: 2,
      ...(team ? { teamFrom: true } : {}),
    }),
    "noReplyRoutesText (Domain checklist)": noReplyRoutesText(team),
    "senderAddressFieldTexts (My profile)": senderAddressFieldTexts(teamFrom),
  };
}

describe("shared-From mode never says 'sending address'", () => {
  it("the text functions of §3.6, the launch, Send me a test, the reply test and the switch-off dialog", () => {
    const said = Object.entries(textFunctions(true)).filter(([, v]) => strings(v).some((s) => PER_PERSON_WORD.test(s)));
    expect(said.map(([k]) => k)).toEqual([]);
    // The shared-From words are there instead.
    expect(strings(textFunctions(true)["NoSenderAddressError"])).toEqual(["Ali has no reply address yet. Ali can add one in Settings › My profile."]);
    expect(signatureHintText(FROM, OWN)).not.toMatch(PER_PERSON_WORD);
  });

  it("the launch problem for a sender without an address (test mode)", async () => {
    const team: TeamFromState = { address: FROM, saved: FROM, domain: D, problem: null, changedAt: null, replies: "app", ownFrom: null, evidenceFrom: FROM };
    const mailgun = async () => ({ connected: true, domain: D }) as never;
    const problems = await launchModeProblems("TEST", { name: "Ali", address: null }, { mailgun, team });
    expect(problems).toEqual([{ code: "no-sender-address", text: "Ali has no reply address yet. Ali can add one in Settings › My profile." }]);
    const perPerson = await launchModeProblems("TEST", { name: "Ali", address: null }, { mailgun, team: { ...team, address: null, saved: null } });
    expect(perPerson).toEqual([{ code: "no-sender-address", text: "Ali has no sending address yet. Ali can add one in Settings › My profile." }]);
  });

  it("the reply test's blockers when the Owner has no address yet", () => {
    const gate = {
      mode: "TEST",
      connected: true,
      practiceCopy: false,
      testList: ["t.outlook@outlook.com", "t.gmail@gmail.com"],
      ownerRouteOk: false,
      ownerAddress: null,
      publicAddressOk: true,
      setting: { setup: "A" },
      rows: [],
      teamFromProblem: null,
    };
    const team = replyTestBlockersFor({ ...gate, teamFrom: FROM } as unknown as GateInputs);
    expect(team).toContain(ownerAddressMissingText(true));
    expect(team.filter((t) => PER_PERSON_WORD.test(t))).toEqual([]);
    expect(replyTestBlockersFor({ ...gate, teamFrom: null } as unknown as GateInputs)).toContain(ownerAddressMissingText(false));
  });

  it("the Domain checklist's rows: reply routes and the reply test in every state", () => {
    const cases: Array<ChecklistFacts["replyTest"]> = [
      { status: "passed", setup: "A", domain: D, decidedAt: "2026-09-22T09:00:00Z", from: FROM },
      { status: "failed", setup: "A", domain: D, decidedAt: "2026-09-22T09:00:00Z", from: FROM },
      { status: "passed", setup: "A", domain: D, decidedAt: "2026-09-22T09:00:00Z", from: null },
      { status: "untested", setup: "A", domain: null, decidedAt: null, from: null },
    ];
    for (const replyTest of cases) {
      const rows = buildChecklistRows({ ...teamFacts(), replyTest }, { keyBits: 2048 });
      expect(rows.some((r) => r.key === "from-mx")).toBe(true);
      const said = rows.filter((r) => PER_PERSON_WORD.test(`${r.title} ${r.text} ${r.fix ?? ""} ${r.detail ?? ""}`));
      expect(said.map((r) => r.key), JSON.stringify(replyTest)).toEqual([]);
    }
    const page = render(createElement(Checklist, { rows: buildChecklistRows(teamFacts(), { keyBits: 2048 }), senders: [], domain: D, domainRegisteredOn: null, ageDomain: "example.com", teamFrom: true }));
    expect(page).toContain(noReplyRoutesText(true));
    expect(page).not.toMatch(PER_PERSON_WORD);
  });

  it("the screens: My profile, Limits, the wizard's Sender step and the reply test section", () => {
    const shared: SenderAddressView = { domain: D, current: null, suggestion: "ali", statusLine: null, statusTone: null, blockedText: null, teamFrom: FROM };
    const profile = (sender: SenderAddressView) =>
      render(
        createElement(ProfileForm, {
          initial: { name: "Ali", email: "ali@polygonparadise.com", senderDisplayName: "", replyInbox: "", signature: "", timeZone: "Europe/Berlin", senderLocalPart: "" },
          zones: [{ value: "Europe/Berlin", label: "Europe/Berlin" }],
          sender,
        }),
      );
    const blocked = sa.senderAddressBlockedText(["Germany Q4"], true);
    const screens: Record<string, string> = {
      "My profile, no address": profile(shared),
      "My profile, an address that can't change": profile({ ...shared, current: OWN, statusLine: "Reply route: working", statusTone: "ok", blockedText: blocked }),
      "Limits": render(createElement(SenderCapsForm, { senders: [{ userId: 1, name: "Ali", address: null, dailyCap: null }], teamFrom: true })),
      "Sender step": render(createElement(SenderStep, { campaignId: 1, senders: [senderChoice()], selectedId: 2, viewerId: 1, teamFrom: FROM })),
      "Reply test section": render(createElement(ReplyTestSection, { view: replyTestView() })),
    };
    const said = Object.entries(screens).filter(([, t]) => PER_PERSON_WORD.test(t));
    expect(said.map(([k, t]) => `${k}: ${t.slice(Math.max(0, t.search(PER_PERSON_WORD) - 60), t.search(PER_PERSON_WORD) + 40)}`)).toEqual([]);
    expect(screens["My profile, no address"]).toContain("Reply address");
    expect(screens["Limits"]).toContain("No reply address yet");
    expect(screens["Sender step"]).toContain("Ali has no reply address yet");
    expect(screens["Reply test section"]).toContain(ownerAddressMissingText(true));
  });
});

describe("per-person mode still says 'sending address' (unchanged)", () => {
  it("the same calls in per-person mode", () => {
    const missing = Object.entries(textFunctions(false)).filter(([, v]) => !strings(v).some((s) => PER_PERSON_WORD.test(s)));
    expect(missing.map(([k]) => k)).toEqual([]);
  });

  it("the same screens in per-person mode", () => {
    expect(render(createElement(SenderCapsForm, { senders: [{ userId: 1, name: "Ali", address: null, dailyCap: null }] }))).toContain("No sending address yet");
    const step = render(createElement(SenderStep, { campaignId: 1, senders: [{ ...senderChoice(), teamFrom: null, fromLine: "Ali <ali@your-sending-domain>" }], selectedId: 2, viewerId: 1 }));
    expect(step).toContain("Sending address");
    expect(step).toContain("Ali has no sending address yet");
    expect(step).not.toContain("Reply address");
  });
});

describe("where src/** still spells the per-person word", () => {
  /**
   * Non-comment source lines that contain "sending address". Each is per-person only (the other branch of a mode
   * switch) or, like "noDomain", the same in both modes by design (§3.6: no From address can exist before a sending
   * domain). A new line needs `senderAddressWords(teamFrom)` or a conscious entry here.
   */
  const ALLOWED: Record<string, number> = {
    "src/core/sending/from-address.ts": 1, // senderAddressWords(false)
    "src/server/services/sender-addresses.ts": 3, // noDomain (both modes), notYours (per-person constant), the per-person notice
    "src/components/settings/profile-form.tsx": 1, // noDomain (both modes)
    "src/components/campaign-wizard/sender-step.tsx": 2, // the per-person branches
    "src/components/settings/domain/reply-test-section.tsx": 1, // the per-person intro
  };

  function scan(dir: string, out: Record<string, number>): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "generated") scan(full, out);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      for (const line of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
        const t = line.trimStart();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
        if (PER_PERSON_WORD.test(t)) {
          const key = path.relative(process.cwd(), full).split(path.sep).join("/");
          out[key] = (out[key] ?? 0) + 1;
        }
      }
    }
  }

  it("only in the per-person places listed here", () => {
    const found: Record<string, number> = {};
    scan(path.join(process.cwd(), "src"), found);
    expect(found).toEqual(ALLOWED);
  });
});

// ───────────────────────── fixtures ─────────────────────────

function senderChoice(): SenderChoice {
  return {
    id: 2,
    name: "Ali",
    email: "ali@polygonparadise.com",
    fromName: "Ali from Polygon Paradise",
    fromLine: `Ali from Polygon Paradise <${FROM}>`,
    placeholderAddress: true,
    address: null,
    teamFrom: FROM,
    routeOk: null,
    dailyCap: null,
    signature: "",
  };
}

function replyTestView(): ReplyTestView {
  return {
    domain: D,
    setup: "A",
    decided: null,
    blockers: [ownerAddressMissingText(true)],
    testList: ["t.outlook@outlook.com", "t.gmail@gmail.com"],
    mailboxes: [],
    headersOk: null,
    unsubscribeSeen: false,
    verdict: { status: "incomplete", missing: [] },
    ownerAddress: null,
    runningJobId: null,
    teamFrom: FROM,
    original: null,
    warnings: [],
  };
}

const ok = <T,>(value: T): DnsAnswer<T> => ({ ok: true, value });
const both = <T,>(value: T) => ({ a: ok(value), b: ok(value) });
const DKIM = "k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu5fakekey";
const SPF = "v=spf1 include:mailgun.org ~all";
const HOOK = "https://outreach.example.com/api/webhooks/mailgun/events";

/** The owner's shape with nobody's reply address set up yet: From contact@example.com through send.example.com. */
function teamFacts(): ChecklistFacts {
  const now = new Date("2026-09-27T10:00:00Z");
  const at = now.toISOString();
  const dmarc = { at: "example.com", policy: { p: "none", sp: null, rua: [], adkim: null, aspf: null, raw: "v=DMARC1; p=none" }, duplicates: false, inherited: false, error: null };
  return {
    domain: D,
    region: "US",
    now,
    timeZone: "Asia/Karachi",
    mailgun: {
      ok: true,
      value: {
        state: "active",
        isDisabled: false,
        disabledReason: null,
        spamAction: "tag",
        webPrefix: "email",
        webScheme: "https",
        messageTtl: 86_400,
        webhooksRedactPii: false,
        sending: [
          { recordType: "TXT", name: D, value: SPF, priority: null, valid: "valid", isActive: true, cached: [] },
          { recordType: "TXT", name: "pdk1._domainkey.example.com", value: DKIM, priority: null, valid: "valid", isActive: true, cached: [] },
          { recordType: "CNAME", name: `email.${D}`, value: "mailgun.org", priority: null, valid: "valid", isActive: true, cached: [] },
        ],
        receiving: [
          { recordType: "MX", name: null, value: "mxa.mailgun.org", priority: "10", valid: "valid", isActive: true, cached: [] },
          { recordType: "MX", name: null, value: "mxb.mailgun.org", priority: "10", valid: "valid", isActive: true, cached: [] },
        ],
      },
    },
    verifyError: null,
    dns: {
      txt: both([SPF]),
      spfLookups: { count: 3, complete: true },
      dkim: [{ name: "pdk1._domainkey.example.com", recordType: "TXT", expected: DKIM, answers: both([DKIM]), proxied: null, doubled: null }],
      mx: both([
        { priority: 10, exchange: "mxa.mailgun.org" },
        { priority: 10, exchange: "mxb.mailgun.org" },
      ]),
      tracking: { host: `email.${D}`, expected: "mailgun.org", cname: both(["mailgun.org."]), a: null, doubled: null },
      dmarc: { a: dmarc, b: dmarc, ruaAuthorized: {} },
    },
    certificate: { ok: true, value: { status: "active", error: null } },
    setupCertificate: "active",
    tracking: { ok: true, value: { openActive: false, clickActive: false, unsubscribeActive: true, htmlFooter: "", textFooter: "" } },
    unsubscribeSetup: "A",
    messageRetentionDays: 1,
    webhooks: {
      url: HOOK,
      map: { ok: true, value: { delivered: [HOOK], permanent_fail: [HOOK], temporary_fail: [HOOK], complained: [HOOK], unsubscribed: [HOOK] } },
    },
    signingKey: { saved: true, matches: true, problem: null },
    routes: { senders: [], catchAllRouteId: "route-catchall", listsError: null },
    queues: { ok: true, value: { regularDisabled: false, reason: null } },
    pause: [],
    monthlyLimit: { ok: true, value: { limit: 30_000, current: 1_234, period: "1m" } },
    tunnel: {
      checkedAt: at,
      state: "connected",
      readyConnections: 4,
      port: 20241,
      connectorId: "c-1",
      version: "2026.9.1",
      versionWarning: null,
      downSince: null,
      notifiedAt: null,
      publicCheck: { at, ok: true, status: 200, error: null },
      webhookPathCheck: { at, ok: true, status: 406, error: null },
      appProtectedCheck: { at, ok: true, status: 302, location: "https://team.cloudflareaccess.com/login", error: null },
      selfCheckNonce: "n",
    },
    publicUrl: "https://outreach.example.com",
    fakeMode: false,
    replyTest: { status: "passed", setup: "A", domain: D, decidedAt: "2026-09-22T09:00:00Z", from: FROM },
    domainRegisteredOn: "2024-08-22",
    from: {
      address: FROM,
      domain: "example.com",
      problem: null,
      signingDomain: "example.com",
      originalSigner: null,
      originalPasted: false,
      dns: {
        txt: both(["v=spf1 include:_spf.provider.example ~all"]),
        spfLookups: { count: 2, complete: true, dangling: [] },
        mx: both([{ priority: 10, exchange: "mx.provider.example" }]),
        dmarc: { a: dmarc, b: dmarc, ruaAuthorized: {} },
      },
    },
  };
}
