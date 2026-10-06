import "server-only";
import type { AccessLinkPurpose } from "@/generated/prisma/client";
import { UserError, runAction, type ActionResult } from "@/lib/action";
import { createSession } from "@/lib/auth/session";
import { requestSourceKey } from "@/lib/request";
import { TeamError, acceptAccessLinkFrom } from "@/server/services/users";

/**
 * Shared body of the public "accept invite" and "reset password" actions.
 * The link is checked, used up and the password set in one transaction (users.ts);
 * then this browser is signed in. A usable link always works; only links that don't
 * work count toward the (per-source) throttle.
 */
export async function completeAccessLink(purpose: AccessLinkPurpose, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const token = String(formData.get("token") ?? "");
    const source = await requestSourceKey();
    let userId: number;
    try {
      const user = await acceptAccessLinkFrom(source, {
        token,
        purpose,
        password: String(formData.get("password") ?? ""),
        confirm: String(formData.get("confirm") ?? ""),
      });
      userId = user.id;
    } catch (err) {
      if (err instanceof TeamError) throw new UserError(err.message, err.fieldErrors);
      throw err;
    }
    // All the person's old sessions were removed with the password change; start a fresh one here.
    await createSession(userId);
    return null;
  });
}
