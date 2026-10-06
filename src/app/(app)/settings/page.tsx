import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/dal";

export default async function SettingsIndex() {
  await requireUser();
  redirect("/settings/profile");
}
