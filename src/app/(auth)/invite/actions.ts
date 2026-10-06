"use server";

import { redirect } from "next/navigation";
import type { ActionResult } from "@/lib/action";
import { completeAccessLink } from "./complete-link";

/** Public action (no session yet): the invite link itself is the credential. */
export async function acceptInviteAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const result = await completeAccessLink("INVITE", formData);
  if (result.ok) redirect("/dashboard");
  return result;
}
