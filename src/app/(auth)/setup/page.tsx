import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/server/db";
import { SetupForm } from "./setup-form";

export const metadata: Metadata = { title: "First-time setup" };

export default async function SetupPage() {
  await connection(); // always render on request: never touch the database at build time
  const userCount = await db.user.count();
  if (userCount > 0) redirect("/login");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Welcome! Create the Owner account</CardTitle>
        <CardDescription>
          This is only shown once. The Owner manages settings, keys, limits and the team.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SetupForm />
      </CardContent>
    </Card>
  );
}
