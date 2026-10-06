import { requireUser } from "@/lib/auth/dal";
import { PageHeader } from "@/components/page-header";
import { SettingsNav } from "@/components/settings/settings-nav";

/**
 * Settings frame: sub-navigation plus the current settings page (including /settings/backups,
 * which another package owns). Each page still checks requireUser()/requireOwner() itself.
 */
export default async function SettingsLayout({ children }: LayoutProps<"/settings">) {
  const user = await requireUser();
  return (
    <div>
      <PageHeader title="Settings" className="pb-2 md:pb-4" />
      <div className="flex flex-col gap-6 px-4 pb-12 md:flex-row md:gap-8 md:px-6">
        <SettingsNav isOwner={user.role === "OWNER"} />
        <div className="min-w-0 max-w-3xl flex-1">{children}</div>
      </div>
    </div>
  );
}
