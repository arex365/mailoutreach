import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/dal";
import { publicUrl } from "@/server/env";
import { getNotifyPrefs } from "@/server/services/users";
import { SettingsTitle } from "@/components/settings/settings-title";
import { PopupGroupsForm, PopupsOnThisComputer } from "@/components/settings/popups-settings";

/** R2 (M6-DESIGN §5.1): the metadata title is the nav label and the page heading. */
export const metadata: Metadata = { title: "Notifications" };

/**
 * Settings › Notifications (M4-DESIGN §5.4, §9.6), for everyone: desktop pop-ups in this browser, and which kinds of
 * notification pop up (saved for the account). The bell and the Notifications page always show everything. No orange
 * button (M6-DESIGN §5.1 R1).
 */
export default async function NotificationSettingsPage() {
  const user = await requireUser();
  const prefs = await getNotifyPrefs(user.id);
  return (
    <div>
      <SettingsTitle
        title="Notifications"
        description="The bell at the top shows new replies, finished campaigns and anything that needs your attention."
      />
      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Pop-ups on this computer</CardTitle>
            <CardDescription>Whether this browser shows a pop-up when something new arrives. Each computer chooses for itself.</CardDescription>
          </CardHeader>
          <CardContent>
            <PopupsOnThisComputer userId={user.id} legacyDesktopReplies={prefs.desktopReplies} publicUrl={publicUrl()} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>What pops up</CardTitle>
            <CardDescription>Which kinds of notification also pop up on your screen.</CardDescription>
          </CardHeader>
          <CardContent>
            <PopupGroupsForm role={user.role} initialGroups={prefs.popupGroups} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
