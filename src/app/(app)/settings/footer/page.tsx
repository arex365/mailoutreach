import type { Metadata } from "next";
import { requireOwner } from "@/lib/auth/dal";
import { SettingsTitle } from "@/components/settings/settings-title";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FooterForm } from "@/components/settings/footer/footer-form";
import { getSettings } from "@/server/settings";

export const metadata: Metadata = { title: "Email footer" };

/**
 * Settings › Email footer (Owner; PLAN A7, M3-DESIGN §5.6, M6-DESIGN §5.1 R3): what ends every email (company name,
 * postal address, the unsubscribe line with Mailgun's personal link) and the portfolio link, with a
 * live preview, in one "Footer text" card. Primary: Save footer.
 */
export default async function FooterPage() {
  await requireOwner();
  const s = await getSettings(["footer.companyName", "footer.address", "footer.unsubscribeText", "portfolioUrl"] as const);
  return (
    <div>
      <SettingsTitle title="Email footer" description="Every email ends with this footer. Changes apply to emails prepared from now on." />
      <Card>
        <CardHeader>
          <CardTitle>Footer text</CardTitle>
          <CardDescription>The last lines of every email. Mailgun adds the personal unsubscribe link.</CardDescription>
        </CardHeader>
        <CardContent>
          <FooterForm
            initial={{
              companyName: String(s["footer.companyName"] ?? ""),
              address: String(s["footer.address"] ?? ""),
              unsubscribeText: String(s["footer.unsubscribeText"] ?? ""),
              portfolioUrl: String(s["portfolioUrl"] ?? ""),
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
