"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { validateLocalPart } from "@/core/sender-address";
import { UserError, parseInput, runAction, type ActionResult } from "@/lib/action";
import { requireUserAction } from "@/lib/auth/dal";
import { changeOwnPasswordChecked } from "@/lib/auth/login";
import { requestSourceKey } from "@/lib/request";
import {
  getSenderAddressInfo,
  profileSavedAddressUnchangedText,
  profileSavedWithAddressText,
  SenderAddressError,
  setSenderLocalPart,
} from "@/server/services/sender-addresses";
import { checkProfileInput, FIELDS_NEED_FIXING, sendingDomainNames, updateProfile } from "@/server/services/users";
import { withTeamErrors } from "../team-errors";

/** Everyone's own profile, sending address and password (SPEC §1, §12 "Everyone"; M3-DESIGN §5.7). */

const profileSchema = z.object({
  name: z.string({ error: "Enter your name." }),
  senderDisplayName: z.string({ error: "Enter a sender name." }),
  replyInbox: z.string({ error: "Enter your reply inbox." }),
  signature: z.string({ error: "Enter a signature, or leave it empty." }),
  timeZone: z.string({ error: "Pick a time zone." }),
  /** The name before the @ of the sending address; only used when it changed. */
  senderLocalPart: z.string().max(200).optional(),
});

/**
 * Saves your profile and, when the name before the @ changed, your sending address (M3-DESIGN §4.5.7). Every field is
 * checked first, so a typo anywhere saves nothing; a sending address that can't change right now (campaigns running,
 * taken) is reported after the rest was saved. In shared-From mode the sentences say "reply address"
 * (SHARED-FROM-DESIGN §3.6). In own-mailbox mode (MAIN-DOMAIN-DESIGN O5, §3.7) nobody has an address of their own: a
 * name before the @ is never saved (a stale page's is ignored), and the toast is today's "Profile saved.".
 */
export async function updateProfileAction(input: z.infer<typeof profileSchema>): Promise<ActionResult<{ changed: number; address: string | null }>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireUserAction();
    const { senderLocalPart, ...profile } = parseInput(profileSchema, input);

    const info = senderLocalPart !== undefined ? await getSenderAddressInfo(user.id) : null;
    const wanted = (senderLocalPart ?? "").trim().toLowerCase();
    const wantsAddress =
      Boolean(info?.domain) && info?.replies !== "own-mailbox" && wanted !== "" && wanted !== (info?.localPart ?? "");

    const fieldErrors: Record<string, string[] | undefined> = {};
    const checked = checkProfileInput(profile, await sendingDomainNames());
    if (!checked.ok) Object.assign(fieldErrors, checked.fieldErrors);
    if (wantsAddress) {
      const v = validateLocalPart(wanted);
      if (!v.ok) fieldErrors.senderLocalPart = [v.error];
    }
    if (!checked.ok || fieldErrors.senderLocalPart) throw new UserError(FIELDS_NEED_FIXING, fieldErrors);

    const result = await withTeamErrors(() => updateProfile(user.id, profile));
    // Shared-From mode: the address is the Reply-To, "reply address" on screen (wantsAddress implies `info`).
    const teamFrom = Boolean(info?.teamFrom);
    let address: string | null = null;
    if (wantsAddress) {
      try {
        const r = await setSenderLocalPart({ id: user.id, name: user.name, role: user.role }, user.id, wanted);
        if (r.changed) address = r.address;
      } catch (err) {
        if (!(err instanceof SenderAddressError)) throw err;
        if (result.changed.length > 0) revalidatePath("/", "layout");
        const text = result.changed.length > 0 ? profileSavedAddressUnchangedText(err.message, teamFrom) : err.message;
        throw new UserError(text, err.field ? { senderLocalPart: [err.message] } : undefined);
      }
    }
    // Your name shows in the top bar, and your time zone changes every date in the app.
    if (result.changed.length > 0 || address) revalidatePath("/", "layout");
    const changed = result.changed.length + (address ? 1 : 0);
    message = address
      ? profileSavedWithAddressText(address, teamFrom)
      : changed > 0
        ? "Profile saved."
        : "Nothing changed, so there was nothing to save.";
    return { changed, address };
  });
  return res.ok ? { ...res, message } : res;
}

const passwordSchema = z.object({
  current: z.string({ error: "Enter your current password." }),
  password: z.string({ error: "Enter a new password." }),
  confirm: z.string({ error: "Enter the new password again." }),
});

export async function changePasswordAction(input: z.infer<typeof passwordSchema>): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireUserAction();
    const data = parseInput(passwordSchema, input);
    // A wrong current password counts as a wrong sign-in: same gate and waits as the login page.
    const res = await withTeamErrors(async () => changeOwnPasswordChecked(user, data, await requestSourceKey()));
    if (!res.ok) throw new UserError(res.error);
    return null;
  }, "Password changed. You've been signed out on other devices.");
}
