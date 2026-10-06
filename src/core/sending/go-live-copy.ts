import { warmupRiseCondition, type WarmupRiseRule } from "@/core/sending/warmup-line";

/**
 * Every sentence of the go-live switch (M6-DESIGN §2.5, §2.8): the "Go live" card on Settings › Sending & Mailgun,
 * its confirmation dialog, the toast, the refusals, the notification to the team and the activity line. One place, so
 * the card, the action, the service and the tests say the same thing. Pure and browser-safe.
 */

const n = (v: number): string => Math.max(0, Math.floor(v)).toLocaleString("en-US");

export const GO_LIVE_COPY = {
  title: "Go live",
  /** The card's title after a domain change ended go-live (G8): "Go live on send2.example.com". */
  titleOn: (domain: string): string => `Go live on ${domain}`,
  /** The card's description while not live. */
  descriptionBefore: "When you go live, new live campaigns email everyone eligible, not only your test list, and warm-up starts.",
  /** The description after a domain change ended go-live (G8). */
  descriptionAfterDomainChange: (oldDomain: string, newDomain: string): string =>
    `You were live on ${oldDomain}. After the change to ${newDomain}, live campaigns only reach your test list until you go live on it.`,
  practiceCopy: "The practice copy never sends real email, so it can't go live.",
  switchLabel: "Go live",
  blockersHeading: "Before going live:",
  recommendationsHeading: "Recommended first:",
  guideLine: "Step by step: Going-live guide (docs\\setup\\4-going-live.md).",
  /**
   * "Live on send.example.com since 27 Sep 2026, 14:05 (switched on by Arslan). New live campaigns email everyone
   * eligible." `at` is already formatted in the viewer's time zone; who and where are left out when unknown.
   */
  liveLine: (at: string, by: string | null, domain: string | null = null): string =>
    `Live${domain ? ` on ${domain}` : ""} since ${at}${by ? ` (switched on by ${by})` : ""}. New live campaigns email everyone eligible.`,
  cantSwitchOff: "This can't be switched off. To stop sending at any time, use Pause all sending.",
  dialogTitle: "Go live?",
  /** The dialog's items that are always there, in order (the conditional ones come from `goLiveDialogItems`). */
  dialogItems: [
    "New campaigns send real email to everyone eligible, not only your test list. Sending mode switches to Live.",
    "Warm-up starts today: the daily limit starts at 50 and goes up one step after each weekday with at least half the limit used and healthy numbers, to 1,000 in about 4 weeks.",
    "Bounces and complaints are counted from now on; your test emails don't count.",
    "Campaigns already running keep the mode they were launched with.",
    "Your test mailboxes become normal companies: emailing them in a live campaign from now on counts as emailed.",
    "This can't be switched off. To stop sending at any time, use Pause all sending.",
  ] as readonly string[],
  confirmLabel: "I understand that real prospects will get emails from now on.",
  confirmButton: "Go live",
  cancelButton: "Not yet",
  savingLabel: "Going live…",
  /** The action's success message (the toast). */
  toast: "You're live. New campaigns now email everyone eligible, and warm-up has started.",
  alreadyLive: "You're already live.",
  /** An input changed between the check and the switch (§2.5 step 2). */
  changed: "Something changed while going live. Check the list again.",
  confirmRequired: "Tick the box to confirm.",
  notificationTitle: "The app is live",
  notificationBody: (name: string, startCap = 50): string =>
    `${name} switched on Go live. Sending mode is now Live: the next campaign anyone launches sends real email to everyone eligible. Warm-up has started at ${n(startCap)} a day.`,
  /** The activity line "Arslan went live on send.example.com". */
  activity: (name: string, domain: string): string => `${name} went live on ${domain}`,
  /** The connect result's extra sentence after a domain change ended go-live (G8). */
  endedByDomainChange: (oldDomain: string, newDomain: string): string =>
    `You were live on ${oldDomain}: go live again on ${newDomain} when its checklist is green (Settings › Sending & Mailgun › Go live).`,
  // ── Shared From address (SHARED-FROM-DESIGN §3.3) ──
  /** The dialog's From item in shared-From mode (F21), right after the warm-up item. */
  dialogTeamFromItem: (from: string, org: string): string =>
    `Every email shows From ${from}. Complaints about them count against ${org}, the domain your everyday email uses.`,
  /** The dialog's From item in per-person mode (F21): `example` = the Owner's own From line. */
  dialogOwnFromItem: (example: string): string => `Every email shows From the sender's own address, for example ${example}.`,
  /** Under the live line in shared-From mode. */
  liveFromLine: (from: string): string => `Emails show From ${from}; replies go to each sender's own address.`,
  /** The card's description after a From change ended go-live (`null` = per-person mode). */
  descriptionAfterFromChange: (was: string | null, now: string | null): string =>
    `You were live with ${was ?? "each person's own address"} as the From address. After the change to ${now ?? "each person's own address"}, live campaigns only reach your test list until you run the reply test and go live again.`,
  /** The From card's toast suffix when saving the From address ended go-live (F13). */
  endedByFromChange:
    "Going live ended: go live again once the reply test has passed with the new From address (Settings › Sending & Mailgun › Go live).",
  /** The required tick while the reply test recorded a spam placement (F12); `where` e.g. "Outlook.com (tess@outlook.com)". */
  spamPlacementTick: (where: string): string =>
    `I know the reply test's email landed in spam at ${where}. Go live anyway: fewer people there may see our emails at first.`,
  spamPlacementRequired: "Tick the box about the spam folder first.",
  // ── Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.4, O14, O20) ──
  /** The dialog's From item in own-mailbox mode (in the From item's place). */
  dialogOwnMailboxItem: (from: string, d: string): string =>
    `Every email shows From ${from} and goes out through ${d} itself. Replies come only to ${from}: the app never sees them.`,
  /** The required replies tick, always in own-mailbox mode. */
  ownMailboxTick: (from: string): string =>
    `I read ${from} every working day, its inbox and its Spam folder. When someone answers there, I click They replied on their company, I handle removal requests and "couldn't be delivered" notices with Mark unsubscribed, and then I click I've read ${from}: live follow-ups wait for that each day.`,
  ownMailboxRequired: "Tick the box about replies in your own mailbox first.",
  /** The required tick while the https-links row isn't "ok" (own-mailbox mode). */
  httpLinksTick:
    "I know unsubscribe links use http on my Mailgun plan, so Gmail's and Yahoo's one-click unsubscribe button may not show.",
  httpLinksRequired: "Tick the box about unsubscribe links first.",
  /** Under the live line in own-mailbox mode. */
  liveOwnFromLine: (from: string): string => `Emails show From ${from}; replies go straight to that mailbox.`,
  guideLineOwn: "Step by step: Own-mailbox guide, step 11.",
} as const;

/**
 * The go-live dialog's warm-up settings: the table's start, maximum and steps, and (review SCREENS-10) how a step is
 * earned — Setting "warmup.minUsePercent" and whether the sending days are Monday to Friday (`isWeekdaysOnly` of
 * Setting "sending.window"'s days). A missing rule field is the default (50 %, Monday to Friday).
 */
export type GoLiveWarmup = { startCap: number; maxCap: number; steps: number } & WarmupRiseRule;

/**
 * "Warm-up starts today: the daily limit starts at 50 … to 1,000 in about 4 weeks." for the warm-up settings in use,
 * with the rise worded as the settings say ("after each sending day with at least 80% of the limit used", SCREENS-10).
 */
export function goLiveWarmupItem(w: GoLiveWarmup): string {
  const steps = Math.max(1, Math.floor(w.steps) || 1);
  const weeks = Math.max(1, Math.round((steps - 1) / 5));
  return `Warm-up starts today: the daily limit starts at ${n(w.startCap)} and goes up one step after each ${warmupRiseCondition(w)} and healthy numbers, to ${n(w.maxCap)} in about ${weeks === 1 ? "1 week" : `${weeks} weeks`}.`;
}

/** "Today's limit you set by hand (400) is removed: today sends at most 50." */
export function goLiveOverrideItem(cap: number, startCap: number): string {
  return `Today's limit you set by hand (${n(cap)}) is removed: today sends at most ${n(startCap)}.`;
}

/**
 * `These drafts will send real email when launched: "Germany Q4" (412 people), "Spain" (80 people). Check them before
 * launching.` At most the five given, then "and 2 more". Null when there are none.
 */
export function goLiveDraftsItem(drafts: { items: ReadonlyArray<{ name: string; people: number }>; more: number }): string | null {
  if (drafts.items.length === 0) return null;
  const names = drafts.items
    .slice(0, 5)
    .map((d) => `"${d.name}" (${n(d.people)} ${d.people === 1 ? "person" : "people"})`)
    .join(", ");
  const more = drafts.more > 0 ? ` and ${n(drafts.more)} more` : "";
  return `These drafts will send real email when launched: ${names}${more}. Check them before launching.`;
}

/**
 * The dialog's From line (SHARED-FROM-DESIGN F21): `team` in shared-From mode (the shared address and its domain), else
 * `ownExample` (the Owner's own From line) in per-person mode. Absent or null = no From item (older callers).
 * MAIN-DOMAIN-DESIGN §3.4: `ownMailbox` (the own From and the sending domain) in own-mailbox mode takes the From item's
 * place; absent or null = app mode, exactly as before.
 */
export type GoLiveDialogFrom = {
  team: { from: string; org: string } | null;
  ownExample: string | null;
  ownMailbox?: { from: string; domain: string } | null;
};

/**
 * The dialog's list (§2.5), the conditional items only when they apply: new campaigns · warm-up · (the From line,
 * SHARED-FROM-DESIGN F21, or own-mailbox mode's item) · counting from now · (today's hand-set limit) · (drafts made
 * before go-live) · running campaigns · test mailboxes · can't be switched off. Without `from` the list is exactly as
 * before.
 */
export function goLiveDialogItems(input: {
  capOverrideToday: number | null;
  drafts: { items: ReadonlyArray<{ name: string; people: number }>; more: number };
  warmup: GoLiveWarmup;
  from?: GoLiveDialogFrom | null;
}): string[] {
  const [newCampaigns, , counting, running, testMailboxes, cantSwitchOff] = GO_LIVE_COPY.dialogItems;
  const out = [newCampaigns!, goLiveWarmupItem(input.warmup)];
  if (input.from?.ownMailbox) out.push(GO_LIVE_COPY.dialogOwnMailboxItem(input.from.ownMailbox.from, input.from.ownMailbox.domain));
  else if (input.from?.team) out.push(GO_LIVE_COPY.dialogTeamFromItem(input.from.team.from, input.from.team.org));
  else if (input.from?.ownExample) out.push(GO_LIVE_COPY.dialogOwnFromItem(input.from.ownExample));
  out.push(counting!);
  if (input.capOverrideToday !== null) out.push(goLiveOverrideItem(input.capOverrideToday, input.warmup.startCap));
  const drafts = goLiveDraftsItem(input.drafts);
  if (drafts) out.push(drafts);
  out.push(running!, testMailboxes!, cantSwitchOff!);
  return out;
}
