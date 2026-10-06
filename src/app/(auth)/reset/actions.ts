"use server";

import { redirect } from "next/navigation";
import type { ActionResult } from "@/lib/action";
import { completeAccessLink } from "../invite/complete-link";

/** Public action (no session): the reset link itself is the credential. Signs the person out everywhere else. */
export async function resetPasswordAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const result = await completeAccessLink("RESET", formData);
  if (result.ok) redirect("/dashboard");
  return result;
}
