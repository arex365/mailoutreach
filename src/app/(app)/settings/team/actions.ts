"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseInput, runAction, type ActionResult } from "@/lib/action";
import { requireOwnerAction } from "@/lib/auth/dal";
import { publicUrl } from "@/server/env";
import {
  buildAccessLinkUrls,
  deactivateUser,
  inviteUser,
  issueAccessLink,
  reactivateUser,
  transferOwnership,
  type IssuedLink,
  type SwitchOffCampaigns,
} from "@/server/services/users";
import { formatDateTime } from "@/core/time/format";
import type { AccessLinkResult } from "@/components/settings/types";
import { withTeamErrors } from "../team-errors";

/**
 * Team management (Owner only, SPEC §1). Business rules live in src/server/services/users.ts. Every change refreshes
 * every page: the dashboard's "Get started" and waiting-replies line and the campaign pages show the team too
 * (M6-DESIGN §5.1 R5).
 */

const userIdSchema = z.object({ userId: z.number({ error: "Pick a teammate." }).int().positive() });

const inviteSchema = z.object({
  name: z.string({ error: "Enter their name." }),
  email: z.string({ error: "Enter their email address." }),
});

async function toLinkResult(issued: IssuedLink, timeZone: string): Promise<AccessLinkResult> {
  const h = await headers();
  const urls = buildAccessLinkUrls({
    purpose: issued.purpose,
    token: issued.token,
    publicUrl: publicUrl(),
    requestHost: h.get("x-forwarded-host") ?? h.get("host"),
  });
  return {
    purpose: issued.purpose,
    name: issued.user.name,
    email: issued.user.email,
    primary: urls.primary,
    office: urls.office,
    officeIsLocalOnly: urls.officeIsLocalOnly,
    expiresText: formatDateTime(issued.expiresAt, timeZone),
  };
}

export async function inviteTeammateAction(input: { name: string; email: string }): Promise<ActionResult<AccessLinkResult>> {
  return runAction(async () => {
    const user = await requireOwnerAction();
    const data = parseInput(inviteSchema, input);
    const issued = await withTeamErrors(() => inviteUser(user.id, data));
    revalidatePath("/", "layout");
    return toLinkResult(issued, user.timeZone);
  });
}

export async function newInviteLinkAction(input: { userId: number }): Promise<ActionResult<AccessLinkResult>> {
  return runAction(async () => {
    const user = await requireOwnerAction();
    const { userId } = parseInput(userIdSchema, input);
    const issued = await withTeamErrors(() => issueAccessLink(user.id, userId, "INVITE"));
    revalidatePath("/", "layout");
    return toLinkResult(issued, user.timeZone);
  });
}

export async function resetPasswordLinkAction(input: { userId: number }): Promise<ActionResult<AccessLinkResult>> {
  return runAction(async () => {
    const user = await requireOwnerAction();
    const { userId } = parseInput(userIdSchema, input);
    const issued = await withTeamErrors(() => issueAccessLink(user.id, userId, "RESET"));
    revalidatePath("/", "layout");
    return toLinkResult(issued, user.timeZone);
  });
}

const switchOffSchema = z.object({
  userId: z.number({ error: "Pick a teammate." }).int().positive(),
  campaigns: z.enum(["pause", "finish"], { error: "Choose what happens to their campaigns." }).optional(),
});

/**
 * The toast after switching someone off (M4-DESIGN §9.8): "Ali is switched off. 2 campaigns paused." / "Ali is
 * switched off. Their campaigns keep going; replies come to you." / "… and signed out everywhere." (no campaign).
 * Not exported: every export of a "use server" file is a Server Action.
 */
function switchOffMessage(r: { name: string; campaigns: SwitchOffCampaigns; active: number; paused: number }): string {
  if (r.campaigns === "pause" && r.paused > 0) {
    return `${r.name} is switched off. ${r.paused === 1 ? "1 campaign" : `${r.paused} campaigns`} paused.`;
  }
  if (r.campaigns === "finish" && r.active > 0) return `${r.name} is switched off. Their campaigns keep going; replies come to you.`;
  return `${r.name} is switched off and signed out everywhere.`;
}

/**
 * Owner only. Switches a teammate off; their scheduled and running campaigns are paused ("pause", the default) or
 * keep going ("finish"), and their replies waiting for an answer move to the Owner either way (M4-DESIGN §9.8).
 */
export async function switchOffAction(input: {
  userId: number;
  campaigns?: SwitchOffCampaigns;
}): Promise<ActionResult<{ name: string; paused: number; movedReplies: number }>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const { userId, campaigns = "pause" } = parseInput(switchOffSchema, input);
    const target = await withTeamErrors(() => deactivateUser(user.id, userId, new Date(), { campaigns }));
    revalidatePath("/", "layout");
    message = switchOffMessage({ name: target.name, campaigns, active: target.campaigns.length, paused: target.paused });
    return { name: target.name, paused: target.paused, movedReplies: target.movedReplies };
  });
  return res.ok ? { ...res, message } : res;
}

export async function switchOnAction(input: { userId: number }): Promise<ActionResult<{ name: string }>> {
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const { userId } = parseInput(userIdSchema, input);
    const target = await withTeamErrors(() => reactivateUser(user.id, userId));
    revalidatePath("/", "layout");
    return { name: target.name };
  });
  return res.ok ? { ...res, message: `${res.data.name} can sign in again.` } : res;
}

export async function makeOwnerAction(input: { userId: number }): Promise<ActionResult<{ name: string }>> {
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const { userId } = parseInput(userIdSchema, input);
    const target = await withTeamErrors(() => transferOwnership(user.id, userId));
    revalidatePath("/", "layout");
    return { name: target.name };
  });
  return res.ok ? { ...res, message: `${res.data.name} is now the Owner. You're a Member.` } : res;
}
