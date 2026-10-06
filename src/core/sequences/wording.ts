import type { HoldReason } from "@/core/replies/types";
import type { SendModeValue } from "@/core/rules/mode";
import { parseHoldReasons } from "./hold-reasons";

/**
 * Sequence words shared by the campaign page, the Contacts "Sequence" column and the company panel (M4-DESIGN §2.12,
 * A6 wording), so every place says the same. Campaign-page texts start with a capital; panel texts start lowercase
 * because they follow "·". Pure and browser-safe.
 */

/** Stop code of a recipient who replied (the replier, M4-DESIGN §2.6). */
export const REPLIED_STOP = "replied";
/** Stop code of the other recipients at a company where someone replied. */
export const COMPANY_REPLIED_STOP = "company_replied";

/** Where a text is shown: the campaign page and Sequence column, or the company panel (after "·"). */
export type WordingPlace = "campaign" | "panel";

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * A HELD recipient in words (§2.12): a possible reply wins over the outage ("On hold: a possible reply needs
 * checking"), then "On hold: replies may have been missed while the PC was off"; plain "On hold" when no reason is
 * stored. Accepts the reasons (`heldReasonsOf`) or the stored `holdReason` text.
 */
export function holdStateText(reasons: readonly HoldReason[] | string | null | undefined, place: WordingPlace): string {
  const list = typeof reasons === "string" || reasons === null || reasons === undefined ? parseHoldReasons(reasons) : reasons;
  let text = "On hold";
  if (list.includes("possible-reply")) text = "On hold: a possible reply needs checking";
  else if (list.includes("outage")) text = "On hold: replies may have been missed while the PC was off";
  return place === "panel" ? lower(text) : text;
}

const STATUS_WORDS: Readonly<Record<string, string>> = {
  REPLIED: "Replied",
  CLIENT: "Client",
  NOT_INTERESTED: "Not interested",
  DO_NOT_CONTACT: "Do not contact",
};

/**
 * A STOPPED recipient in words for the stop codes M4 writes (§2.12): "Stopped: they replied" / "stopped because they
 * replied", "Stopped: someone at the company replied", "Stopped: marked Client" / "stopped because the company was
 * marked Client". Null for every other code (the existing texts cover them).
 */
export function stopStateText(code: string | null | undefined, place: WordingPlace): string | null {
  const raw = (code ?? "").trim();
  if (raw === REPLIED_STOP) return place === "panel" ? "stopped because they replied" : "Stopped: they replied";
  if (raw === COMPANY_REPLIED_STOP) {
    return place === "panel" ? "stopped because someone at the company replied" : "Stopped: someone at the company replied";
  }
  const status = /^status:([A-Z_]+)$/.exec(raw);
  const word = status ? STATUS_WORDS[status[1]!] : undefined;
  if (!word) return null;
  return place === "panel" ? `stopped because the company was marked ${word}` : `Stopped: marked ${word}`;
}

/**
 * The suffix after a sequence text (§2.12), the same on the campaign page, the Sequence column and the company panel:
 * " (dry run)" for a dry run that doesn't count as emailed, " (test)" for Mailgun's test mode, " (test list)" for a
 * LIVE email of a campaign launched before go-live (it could only reach the test list; it keeps the suffix after
 * go-live, M6-DESIGN §2.2); nothing otherwise. Pass `countsAsEmailed(mode, {practiceCopy, launchedGoLive})` with the
 * campaign's own launch flag.
 */
export function sequenceSuffix(i: {
  mode: SendModeValue | null | undefined;
  countsAsEmailed: boolean;
}): "" | " (dry run)" | " (test)" | " (test list)" {
  if (i.mode === "TEST") return " (test)";
  if (i.countsAsEmailed) return "";
  if (i.mode === "DRY_RUN") return " (dry run)";
  if (i.mode === "LIVE") return " (test list)";
  return "";
}

/** A RECHECK recipient in words: "Waiting for re-check on 27 Sep at 14:05" (panel: lowercase). `when` is formatted by the caller in the viewer's zone. */
export function recheckStateText(when: string | null, place: WordingPlace): string {
  const text = when ? `Waiting for re-check on ${when}` : "Waiting for re-check";
  return place === "panel" ? lower(text) : text;
}
