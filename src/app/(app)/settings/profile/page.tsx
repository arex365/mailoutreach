import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/server/db";
import { getSenderAddressInfo, senderAddressBlockedText, type SenderAddressInfo } from "@/server/services/sender-addresses";
import { timeZoneOptions } from "@/core/geo/display";
import { suggestedLocalPart } from "@/core/sender-address";
import { timeAgo } from "@/core/time/format";
import { SettingsTitle } from "@/components/settings/settings-title";
import { ProfileForm } from "@/components/settings/profile-form";
import { ChangePasswordForm } from "@/components/settings/change-password-form";
import type { SenderAddressView, TimeZoneOption } from "@/components/settings/types";

export const metadata: Metadata = { title: "My profile" };

/**
 * My profile › Sending address (M3-DESIGN §5.7): the status line in plain words. In shared-From mode the field is the
 * "Reply address" (SHARED-FROM-DESIGN §3.6): `teamFrom` carries the shared From address to the form's words. In
 * own-mailbox mode (MAIN-DOMAIN-DESIGN O5, §3.7) nobody has an address of their own: `ownFrom` (the own From, null while
 * none fits) makes the form show the From line instead of the field; app mode never sets it.
 */
function senderView(info: SenderAddressInfo, name: string, email: string, now: Date): SenderAddressView {
  if (info.replies === "own-mailbox") {
    return {
      domain: info.domain,
      current: null,
      suggestion: suggestedLocalPart(name, email),
      statusLine: null,
      statusTone: null,
      blockedText: null,
      ownFrom: info.ownFrom,
    };
  }
  let statusLine: string | null = null;
  let statusTone: SenderAddressView["statusTone"] = null;
  if (info.address) {
    if (info.routeStatus === "ok") {
      statusLine = `Reply route: working${info.routeCheckedAt ? ` (checked ${timeAgo(info.routeCheckedAt, now)})` : ""}`;
      statusTone = "ok";
    } else if (info.routeStatus === "error" || info.routeStatus === "mismatch") {
      const why = (info.routeError ?? "the route isn't set up").replace(/\.\s*$/, "");
      statusLine = `Reply route: Not working: ${why}. The Owner can fix it with Apply recommended settings.`;
      statusTone = "bad";
    } else {
      statusLine = "Reply route: Being set up…";
      statusTone = "pending";
    }
  }
  return {
    domain: info.domain,
    current: info.address,
    suggestion: suggestedLocalPart(name, email),
    statusLine,
    statusTone,
    blockedText: info.domain && info.blockedBy.length > 0 ? senderAddressBlockedText(info.blockedBy, info.teamFrom !== null) : null,
    teamFrom: info.teamFrom,
  };
}

function zoneLabel(tz: string, now: Date): string {
  let offset = "";
  try {
    offset =
      new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" })
        .formatToParts(now)
        .find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    offset = "";
  }
  return `${tz.replace(/_/g, " ")}${offset ? ` (${offset})` : ""}`;
}

export default async function ProfilePage() {
  const user = await requireUser();
  const me = await db.user.findUnique({
    where: { id: user.id },
    select: { name: true, email: true, senderDisplayName: true, replyInbox: true, signature: true, timeZone: true },
  });
  if (!me) redirect("/login");

  const now = new Date();
  const sender = senderView(await getSenderAddressInfo(user.id), me.name, me.email, now);
  const localPart = sender.current ? sender.current.split("@")[0]! : "";
  const zones = new Set(timeZoneOptions());
  zones.add(me.timeZone); // always offer the current value, even if it's not in the common list
  const zoneOptions: TimeZoneOption[] = [...zones].sort().map((z) => ({ value: z, label: zoneLabel(z, now) }));

  return (
    <div>
      <SettingsTitle title="My profile" description="How you appear to the people you email, and how the app shows times to you." />
      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>Everyone on the team has their own profile. Only you can change yours.</CardDescription>
          </CardHeader>
          <CardContent>
            <ProfileForm
              initial={{
                name: me.name,
                email: me.email,
                senderDisplayName: me.senderDisplayName ?? "",
                replyInbox: me.replyInbox ?? me.email,
                signature: me.signature,
                timeZone: me.timeZone,
                senderLocalPart: localPart,
              }}
              zones={zoneOptions}
              isOwner={user.role === "OWNER"}
              sender={sender}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Change password</CardTitle>
            <CardDescription>You stay signed in here. Your other devices are signed out.</CardDescription>
          </CardHeader>
          <CardContent>
            <ChangePasswordForm />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
