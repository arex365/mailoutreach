import type { Metadata } from "next";
import { connection } from "next/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getUserOrNull } from "@/lib/auth/dal";
import { requestSourceKey } from "@/lib/request";
import { LINK_THROTTLED_MESSAGE, findUsableAccessLink, linkAttemptsBlocked } from "@/server/services/users";
import { AcceptLinkForm } from "../../invite/accept-link-form";
import { LinkProblemCard, SignedInNotice } from "../../invite/link-problem";

// The token is in the address: never pass it on to other sites.
export const metadata: Metadata = { title: "Choose a new password", referrer: "no-referrer" };

/** Public page: choose a new password with a reset link the Owner made. */
export default async function ResetPage({ params }: PageProps<"/reset/[token]">) {
  await connection(); // always render on request: never touch the database at build time
  const { token } = await params;
  // A usable link always opens; the throttle only changes the message for links that don't work.
  const [link, current] = await Promise.all([findUsableAccessLink(token, "RESET"), getUserOrNull()]);
  if (!link) {
    const blocked = await linkAttemptsBlocked(await requestSourceKey());
    return <LinkProblemCard message={blocked ? LINK_THROTTLED_MESSAGE : undefined} />;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Choose a new password</CardTitle>
        <CardDescription>
          For <span className="font-medium text-foreground">{link.user.name}</span> ({link.user.email}). You&apos;ll be
          signed out on your other devices.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {current ? <SignedInNotice current={current} target={link.user} /> : null}
        <AcceptLinkForm token={token} email={link.user.email} mode="reset" />
      </CardContent>
    </Card>
  );
}
