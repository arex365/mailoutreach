import type { MailgunPlan } from "@/core/mailgun/plan";
import type { RepliesMode } from "@/core/sending/own-mailbox";
import type { ReplyTestOriginal } from "@/core/setting-types";

/** Shapes passed from the settings pages and actions to their client components (browser-safe). */

export type AccessLinkResult = {
  purpose: "INVITE" | "RESET";
  name: string;
  email: string;
  /** The link to send: public https address when set, otherwise the office address. */
  primary: { kind: "public" | "office"; url: string };
  /** Office-network version when it differs from the primary link. */
  office: string | null;
  /** The office link uses localhost, which only works on the PC itself. */
  officeIsLocalOnly: boolean;
  /** Already formatted in the viewer's time zone. */
  expiresText: string;
};

export type TeamRow = {
  id: number;
  name: string;
  email: string;
  role: "OWNER" | "MEMBER";
  status: "ACTIVE" | "INVITED" | "OFF";
  /** Formatted in the viewer's time zone, or null for never. */
  lastSignIn: string | null;
  lastSignInAgo: string | null;
  /** e.g. "Invite link works until 26 Sept 2026, 14:02". */
  pendingLink: string | null;
  isYou: boolean;
  /** Their scheduled, running and paused campaigns (they send them): the switch-off dialog asks what happens to them. */
  activeCampaigns: Array<{ id: number; name: string; status: "SCHEDULED" | "RUNNING" | "PAUSED" }>;
  /** Replies waiting for their answer, which move to the Owner when they are switched off (M4-DESIGN §9.8). */
  waitingReplies: number;
  /**
   * Shared-From mode (SHARED-FROM-DESIGN §3.6): the switch-off dialog calls their own address the "reply address".
   * Absent = per-person mode ("sending address").
   */
  teamFrom?: boolean;
};

export type ProfileValues = {
  name: string;
  email: string;
  senderDisplayName: string;
  replyInbox: string;
  signature: string;
  timeZone: string;
  /** The name before the @ of the sending address ("" while there is none). */
  senderLocalPart: string;
};

export type TimeZoneOption = { value: string; label: string };

/** My profile › Sending address (M3-DESIGN §5.7). */
export type SenderAddressView = {
  /** The active sending domain, or null before the Owner connects Mailgun. */
  domain: string | null;
  /** The current full address, or null while there is none. */
  current: string | null;
  /** A good first name before the @ (placeholder). */
  suggestion: string;
  /** "Reply route: working (checked 5 minutes ago)" and friends; null while there is no address. */
  statusLine: string | null;
  statusTone: "ok" | "pending" | "bad" | null;
  /** Why it can't change right now (the running campaigns), or null. */
  blockedText: string | null;
  /**
   * SHARED-FROM-DESIGN §3.6: the shared From address while one is saved and fits (the field is then called "Reply
   * address"); null or absent = per-person mode ("Sending address").
   */
  teamFrom?: string | null;
  /**
   * MAIN-DOMAIN-DESIGN O5, §3.7: own-mailbox mode, the own From when one fits (My profile then shows "Your emails show
   * …" instead of the field); null in own-mailbox mode while none fits. Absent = app mode.
   */
  ownFrom?: string | null;
};

// ───────────── Settings › Sending & Mailgun (M3-DESIGN §5.2) ─────────────

export type SendingModeKey = "DRY_RUN" | "TEST" | "LIVE";

export type ModeOptionView = {
  key: SendingModeKey;
  title: string;
  text: string;
  /** Why this mode can't be chosen right now (empty = it can). */
  blockers: string[];
  /** Non-blocking warnings ("Your test list is empty…"). */
  warnings: string[];
};

export type ConnectionView = {
  connected: boolean;
  /** "Connected to send.example.com (EU) · key ending …1a2b · checked 2 minutes ago" / "Not connected yet." */
  statusLine: string;
  region: "EU" | "US";
  domain: string;
  keyLast4: string | null;
  hasSendingKey: boolean;
  logRetentionDays: number;
  messageRetentionDays: number;
  /** "Save and connect" is the page's primary action (not connected, not paused). */
  primary: boolean;
  /** MAIN-DOMAIN-DESIGN O1, §3.1: the saved "How the app sends" (`loadTeamFrom().replies`). Absent = "app". */
  replies?: RepliesMode;
  /** MAIN-DOMAIN-DESIGN O22: Setting "mailgun.plan" (null = "Not sure"). Absent = null. */
  plan?: MailgunPlan | null;
  /** MAIN-DOMAIN-DESIGN O22: no plan chosen and own-mailbox mode, so the Free plan's limits are assumed. Absent = false. */
  planAssumed?: boolean;
};

/**
 * Settings › Sending & Mailgun › From address (SHARED-FROM-DESIGN §3.1). `mainDomain`: the sending domain's main domain
 * (teamFromDomainFor), null when it has none; `saved`: what is saved (lowercase) or null; `problem`: the misfit sentence
 * when the saved address no longer fits; `goLive`: today's switch (the confirm dialog shows while live);
 * `ownerDisplayName`: the Owner's senderDisplayName, else suggestedSenderName(name); `testList`: the saved test list.
 */
export type FromAddressView = {
  practiceCopy: boolean;
  connected: boolean;
  sendingDomain: string | null;
  mainDomain: string | null;
  saved: string | null;
  problem: string | null;
  goLive: boolean;
  ownerDisplayName: string;
  testList: string[];
  /** MAIN-DOMAIN-DESIGN §3.2: own-mailbox mode's card (its own texts and validation). Absent = "app". */
  replies?: RepliesMode;
};

/**
 * Settings › Sending & Mailgun › Go live (M6-DESIGN §2.5), worded on the server in the viewer's time zone. `state`:
 * the practice copy (description only); not live with blockers (the switch off and disabled); not live and ready (the
 * switch opens the confirmation); live (the switch on and disabled).
 */
export type GoLiveCardView = {
  state: "practice" | "blocked" | "ready" | "live";
  /** "Go live", or "Go live on send2.example.com" after a domain change ended go-live. */
  title: string;
  /** The card's description: the practice copy, what going live does, the domain change, or "Live on … since …". */
  description: string;
  /** "Before going live:" (blocked only). */
  blockers: string[];
  /** "Recommended first:" (not live). */
  recommendations: string[];
  /** "Step by step: Going-live guide (…)." while not live; null otherwise. */
  guideLine: string | null;
  /** Live only: "Warm-up step 3 of 20: 69 a day. …". */
  warmupLine: string | null;
  /** Live only: "This can't be switched off. …". */
  cantSwitchOff: string | null;
  /** The confirmation dialog's list (ready only; empty otherwise). */
  dialogItems: string[];
  /** SHARED-FROM-DESIGN §3.3: live in shared-From mode, "Emails show From …; replies go to each sender's own address." */
  fromLine?: string | null;
  /** SHARED-FROM-DESIGN F12: the required tick's label while the reply test recorded a spam placement (ready only). */
  spamPlacementTick?: string | null;
  /** MAIN-DOMAIN-DESIGN O14: own-mailbox mode's required replies tick (`GO_LIVE_COPY.ownMailboxTick`, ready only). */
  ownMailboxTick?: string | null;
  /** MAIN-DOMAIN-DESIGN O20: the required http-links tick while the https-links row isn't "ok" (ready only). */
  httpLinksTick?: string | null;
};

export type PauseView = {
  reason: string;
  fixText: string;
  /** "Paused 5 minutes ago by Arslan." / "… by the app." */
  sinceText: string;
  /** Behind "Details": Mailgun's message and the other causes with their numbers. */
  details: string[];
  /** "Bounces counted now" / "Complaints counted now" on Settings › Deliverability. */
  healthLink: { href: string; label: string } | null;
  /** The restore report, or "still checking" text. */
  restoreText: string | null;
  /** What the Resume dialog says. */
  dialog: string[];
  /** A required tick box before Resume (restore not checked with Mailgun). */
  confirmLabel: string | null;
};

// ───────────── Settings › Domain checklist (M3-DESIGN §5.3) ─────────────

/** One sender's reply route under "Replies reach each sender", with the exact values for the guide's manual fallback. */
export type SenderRouteView = {
  name: string;
  address: string;
  forwardTo: string | null;
  status: "ok" | "pending" | "bad";
  /** "Working", "Being set up…", or the route's problem. */
  statusText: string;
  /** "Remove it": Settings › Deliverability filtered to the inbox Mailgun won't forward to. */
  removeHref: string | null;
  values: { expression: string; actions: string[]; priority: number; description: string } | null;
};

/** The last "Apply recommended settings" run (SystemState "mailgun.setup"). */
export type SetupStepView = { key: string; ok: boolean | null; text: string; detail: string | null };

export type ReplyTestMailboxView = {
  address: string;
  providerLabel: string;
  /** "Delivered", "Sent, waiting for delivery", "Not sent yet" … */
  testEmail: string;
  delivered: boolean;
  replyStored: boolean;
  inboxOk: boolean | null;
  authOk: "pass" | "fail" | "unsure" | null;
  authFromHeaders: boolean;
  /** SHARED-FROM-DESIGN §3.4 (shared-From mode): "Did the test email arrive in this mailbox's inbox…?" */
  placementOk?: boolean | null;
  /** SHARED-FROM-DESIGN §3.4: "Does it say DMARC: PASS (Gmail) or dmarc=pass?" */
  dmarcOk?: "pass" | "fail" | "unsure" | null;
  /** dmarcOk was read from a pasted original, not answered by hand. */
  dmarcFromHeaders?: boolean;
};

export type ReplyTestView = {
  domain: string | null;
  setup: "A" | "B" | "C";
  /** "Setup A passed on 24 Sep: …" for a stored decision on this domain; null = not tested yet. */
  decided: { status: "passed" | "failed"; text: string } | null;
  blockers: string[];
  testList: string[];
  mailboxes: ReplyTestMailboxView[];
  headersOk: boolean | null;
  unsubscribeSeen: boolean;
  verdict: { status: "passed" | "failed" | "incomplete"; missing: string[] };
  ownerAddress: string | null;
  /** A reply-test job still queued or running. */
  runningJobId: number | null;
  /** SHARED-FROM-DESIGN §3.4: the shared From address the test runs with; null or absent = per-person mode. */
  teamFrom?: string | null;
  /**
   * Shared-From mode: when the From address or the sending domain last changed (ISO), part of the round a save names
   * (REPLIES-03, `replyTestRoundOf`), so a page from before a change and back, or a region-only move, is refused.
   */
  roundSince?: string | null;
  /** SHARED-FROM-DESIGN F25: the stored pasted original for today's domain and From, or null. */
  original?: ReplyTestOriginal | null;
  /** SHARED-FROM-DESIGN F12: the verdict's warnings (spam placements), shown even when the test passes. */
  warnings?: string[];
  /** MAIN-DOMAIN-DESIGN O13: own-mailbox mode's own From the test runs with; null while none fits; absent = app mode. */
  ownFrom?: string | null;
  /** MAIN-DOMAIN-DESIGN O13: the stored original's List-Unsubscribe mailto: address (the by-hand question); null = none. */
  mailtoAddress?: string | null;
  /** MAIN-DOMAIN-DESIGN O13: the saved answer to the unsubscribe-by-email question; null = not answered. */
  mailtoArrived?: boolean | null;
  /**
   * Review REPLIES-03 (own-mailbox mode): unsubscribe by email is left out (Setting "mailgun.unsubscribeTest"'s
   * `leaveOutMailto`), so every email carries only Mailgun's link. Absent = app mode (never left out).
   */
  mailtoLeftOut?: boolean;
};
