import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/server/db";
import { safeAppPath } from "@/core/safe-path";
import { getUserOrNull } from "@/lib/auth/dal";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  await connection(); // always render on request: never touch the database at build time
  const [user, userCount, sp] = await Promise.all([getUserOrNull(), db.user.count(), searchParams]);
  // Only a path on this site (never "/\evil.com" and friends); loginAction checks it again.
  const next = safeAppPath(sp.next) ?? undefined;
  if (userCount === 0) redirect("/setup");
  if (user) redirect("/dashboard");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Use the email and password from your invite.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <LoginForm next={next} />
        <p className="text-sm text-muted-foreground">
          Forgot your password? Ask the Owner for a reset link. If you are the Owner, double-click{" "}
          <span className="font-medium text-foreground">reset-password.bat</span> on the office PC.
        </p>
      </CardContent>
    </Card>
  );
}
