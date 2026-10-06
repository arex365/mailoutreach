import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LINK_INVALID_MESSAGE } from "@/server/services/users";

/** Shown instead of the form when an invite/reset link can't be used. */
export function LinkProblemCard({ message = LINK_INVALID_MESSAGE }: { message?: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>This link doesn&apos;t work</CardTitle>
        <CardDescription>{message}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Links work once and expire: invite links after 3 days, password reset links after 24 hours. Only the newest
          link the Owner made for you works.
        </p>
        <Button asChild variant="outline">
          <Link href="/login">Go to sign in</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

/** A heads-up when someone is already signed in on this browser. */
export function SignedInNotice({
  current,
  target,
}: {
  current: { id: number; name: string };
  target: { id: number; name: string };
}) {
  if (current.id === target.id) return null;
  const currentName = current.name;
  const targetName = target.name;
  return (
    <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
      You&apos;re signed in as {currentName} on this browser. Choosing a password here signs you in as {targetName}{" "}
      instead. If you meant to send this link to {targetName}, copy it and close this page.
    </p>
  );
}
