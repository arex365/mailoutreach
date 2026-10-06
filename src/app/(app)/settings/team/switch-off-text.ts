import { senderAddressWords } from "@/core/sending/from-address";
import { OWN_MAILBOX_TEXTS } from "@/core/sending/own-mailbox";

/**
 * The words of Settings › Team's switch-off dialog (M4-DESIGN §9.8). Pure and browser-safe, so the dialog and the
 * tests share them.
 */

export type SwitchOffCampaignRef = { id: number; name: string; status: "SCHEDULED" | "RUNNING" | "PAUSED" };

export type SwitchOffTarget = {
  name: string;
  /** Their scheduled, running and paused campaigns. */
  activeCampaigns: readonly SwitchOffCampaignRef[];
  /** Replies waiting for their answer (they move to the Owner). */
  waitingReplies: number;
  /**
   * Shared-From mode (SHARED-FROM-DESIGN §3.6): their own address is the "reply address". Absent or false = per-person
   * mode ("sending address").
   */
  teamFrom?: boolean;
  /**
   * Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.7): the address replies go to (the own From, or what is saved), so the intro
   * says replies keep going there; null = own-mailbox mode with no From saved (no sentence about replies). Absent =
   * app mode (the sentences above).
   */
  ownFrom?: string | null;
};

export type SwitchOffDialogText = {
  /** "Switch off Ali?" */
  title: string;
  /** What switching off does, always shown. */
  intro: string;
  /** "Ali has 2 active campaigns: …. What should happen to them?", or null when there are none. */
  campaigns: string | null;
  /** The two choices (shown only with `campaigns`). */
  pauseLabel: string;
  finishLabel: string;
  /** "Ali's 3 replies waiting for an answer move to you.", or null when none are waiting. */
  replies: string | null;
  /** The destructive button: "Switch off Ali". */
  confirm: string;
};

/** How many campaign names the dialog lists before "and 3 more". */
export const SWITCH_OFF_LISTED_CAMPAIGNS = 5;

const STATUS_WORDS: Record<SwitchOffCampaignRef["status"], string> = {
  SCHEDULED: "scheduled",
  RUNNING: "running",
  PAUSED: "paused",
};

/** "Germany Q4 (running), Norway prints (scheduled)", with "and 3 more" after the first five. */
export function campaignListText(campaigns: readonly SwitchOffCampaignRef[]): string {
  const shown = campaigns.slice(0, SWITCH_OFF_LISTED_CAMPAIGNS).map((c) => `${c.name} (${STATUS_WORDS[c.status]})`);
  const more = campaigns.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

/** Every sentence of the dialog for one teammate (singular forms for one campaign or one reply). */
export function switchOffDialogText(t: SwitchOffTarget): SwitchOffDialogText {
  const name = t.name.trim() || "This teammate";
  const count = t.activeCampaigns.length;
  const one = count === 1;
  const campaigns =
    count > 0
      ? `${name} has ${one ? "1 active campaign" : `${count} active campaigns`}: ${campaignListText(t.activeCampaigns)}. What should happen to ${one ? "it" : "them"}?`
      : null;
  const replies =
    t.waitingReplies > 0
      ? `${name}'s ${t.waitingReplies === 1 ? "1 reply" : `${t.waitingReplies} replies`} waiting for an answer ${t.waitingReplies === 1 ? "moves" : "move"} to you.`
      : null;
  const signedOut = `${name} will be signed out everywhere and can't sign in. Their history stays.`;
  const intro =
    t.ownFrom === undefined
      ? `${signedOut} Replies to ${name}'s ${senderAddressWords(t.teamFrom === true).lower} will come to your inbox from now on.`
      : t.ownFrom
        ? `${signedOut} ${OWN_MAILBOX_TEXTS.switchOff(name, t.ownFrom)}`
        : signedOut;
  return {
    title: `Switch off ${name}?`,
    intro,
    campaigns,
    pauseLabel: one ? "Pause it. You can resume or cancel it later." : "Pause them. You can resume or cancel them later.",
    finishLabel: one
      ? "Let it finish, including follow-ups. Replies will come to you."
      : "Let them finish, including follow-ups. Replies will come to you.",
    replies,
    confirm: `Switch off ${name}`,
  };
}
