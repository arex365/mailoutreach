import type { Metadata } from "next";
import { requireOwner } from "@/lib/auth/dal";
import { listTeam } from "@/server/services/users";
import { loadTeamFrom } from "@/server/services/mailgun/team-from";
import { formatDateTime, timeAgo } from "@/core/time/format";
import { SettingsTitle } from "@/components/settings/settings-title";
import { TeamManager } from "@/components/settings/team-manager";
import { TEAM_PAGE_TEXT } from "@/components/settings/team-text";
import type { TeamRow } from "@/components/settings/types";
import type { SwitchOffTarget } from "./switch-off-text";

export const metadata: Metadata = { title: "Team" };

/**
 * Settings › Team (Owner, SPEC §1): the title is rendered here on the server (M6-DESIGN §5.1 R2); the team list with
 * "Invite a teammate" (the page's one orange button), links, switch off/on and ownership is the client `TeamManager`.
 * In shared-From mode the switch-off dialog calls each person's own address their "reply address" (SHARED-FROM-DESIGN
 * §3.6); per-person rows carry no `teamFrom`, exactly as before. In own-mailbox mode (MAIN-DOMAIN-DESIGN §3.7) each row
 * carries `ownFrom` (the address replies go to), which the dialog's `switchOffDialogText` reads: `TeamRow` has no field
 * for it yet, so it rides along untyped (the dialog passes the row through unchanged).
 */
export default async function TeamPage() {
  const user = await requireOwner();
  const now = new Date();
  const [team, from] = await Promise.all([listTeam(now), loadTeamFrom()]);
  const teamFrom = from.address !== null;
  const own: Pick<SwitchOffTarget, "ownFrom"> = from.replies === "own-mailbox" ? { ownFrom: from.ownFrom ?? from.saved } : {};
  const rows: TeamRow[] = team.map((m) => ({
    id: m.id,
    name: m.name,
    email: m.email,
    role: m.role,
    status: m.status,
    lastSignIn: m.lastLoginAt ? formatDateTime(m.lastLoginAt, user.timeZone) : null,
    lastSignInAgo: m.lastLoginAt ? timeAgo(m.lastLoginAt, now) : null,
    pendingLink: m.pendingLink
      ? `${m.pendingLink.purpose === "INVITE" ? "Invite" : "Reset"} link works until ${formatDateTime(m.pendingLink.expiresAt, user.timeZone)}`
      : m.status === "INVITED"
        ? "Their invite link has expired. Make a new one from the menu."
        : null,
    isYou: m.id === user.id,
    activeCampaigns: m.activeCampaigns,
    waitingReplies: m.waitingReplies,
    ...(teamFrom ? { teamFrom: true } : {}),
    ...own,
  }));
  return (
    <div>
      <SettingsTitle title="Team" description={TEAM_PAGE_TEXT.description} />
      <TeamManager rows={rows} />
    </div>
  );
}
