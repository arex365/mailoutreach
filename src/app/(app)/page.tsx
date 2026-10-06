import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/dal";

/** Everyone's home is the dashboard (M6-DESIGN §4.5, D10). */
export default async function Home() {
  await requireUser();
  redirect("/dashboard");
}
