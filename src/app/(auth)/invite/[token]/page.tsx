import type { Metadata } from "next";
import { connection } from "next/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getUserOrNull } from "@/lib/auth/dal";
import { requestSourceKey } from "@/lib/request";
import { LINK_THROTTLED_MESSAGE, findUsableAccessLink, linkAttemptsBlocked } from "@/server/services/users";
import { AcceptLinkForm } from "../accept-link-form";
import { LinkProblemCard, SignedInNotice } from "../link-problem";

// The token is in the address: never pass it on to other sites.
export const metadata: Metadata = { title: "Join the team", referrer: "no-referrer" };

/** Public page: an invited teammate chooses their password (PLAN.md A6 "Login, invite, reset"). */
export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  await connection(); // always render on request: never touch the database at build time
  const { token } = await params;
  // A usable link always opens; the throttle only changes the message for links that don't work.
  const [link, current] = await Promise.all([findUsableAccessLink(token, "INVITE"), getUserOrNull()]);
  if (!link) {
    const blocked = await linkAttemptsBlocked(await requestSourceKey());
    return <LinkProblemCard message={blocked ? LINK_THROTTLED_MESSAGE : undefined} />;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Welcome, {link.user.name}</CardTitle>
        <CardDescription>
          Choose a password to finish setting up your account. You&apos;ll sign in with{" "}
          <span className="font-medium text-foreground">{link.user.email}</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {current ? <SignedInNotice current={current} target={link.user} /> : null}
        <AcceptLinkForm token={token} email={link.user.email} mode="invite" />
      </CardContent>
    </Card>
  );
}
