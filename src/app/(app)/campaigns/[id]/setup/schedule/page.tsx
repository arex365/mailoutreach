import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/dal";
import { toLocalInputValue } from "@/components/campaign-wizard/format";
import { ScheduleStep } from "@/components/campaign-wizard/schedule-step";
import { WizardFrame } from "@/components/campaign-wizard/wizard-frame";
import { loadLaunchSummary } from "@/server/services/campaigns/draft";
import { campaignLaunchCheckAudience } from "@/server/services/verification/select";
import { loadWizardDraft, requestTime } from "../load";

export const metadata: Metadata = { title: "Campaign · Schedule" };

export default async function ScheduleStepPage(props: PageProps<"/campaigns/[id]/setup/schedule">) {
  const user = await requireUser();
  const { id } = await props.params;
  const draft = await loadWizardDraft(id);
  const now = requestTime();
  // The address-check note (M5-DESIGN §6.1): who launch leaves out unchecked, and who waits for a second check; with the
  // companies and time zones of the unchecked people, so the step counts only what the launch will really send.
  const [summary, checkNote] = await Promise.all([loadLaunchSummary(draft.id, { now }), campaignLaunchCheckAudience(draft.id, now)]);
  // A start that has already passed means "start now".
  const ahead = draft.startAt && draft.startAt.getTime() > now.getTime() ? draft.startAt : null;
  return (
    <WizardFrame campaign={draft} current="schedule" mode={draft.mode} goLive={draft.goLive}>
      <ScheduleStep
        campaignId={draft.id}
        timeZone={user.timeZone}
        initialLocal={ahead ? toLocalInputValue(ahead, user.timeZone) : ""}
        initialStartIso={ahead ? ahead.toISOString() : null}
        initialDaysAsMinutes={draft.daysAsMinutes}
        nowIso={now.toISOString()}
        checkNote={checkNote}
        summary={{
          mode: summary.mode,
          modeBlockers: summary.modeBlockers,
          modeReady: summary.modeReady,
          today: summary.today ? { cap: summary.today.cap, used: summary.today.used, left: summary.today.left } : null,
          windowText: summary.windowText,
          fits: summary.fits,
          ignoreWindowDefault: summary.ignoreWindowDefault,
          practiceCopy: summary.practiceCopy,
          people: summary.people,
          companies: summary.companies,
          excludedCompanies: summary.excludedCompanies,
          followUps: summary.followUps,
          missingEmails: summary.missingEmails,
          missingPeople: summary.missingPeople,
          textProblems: summary.textProblems,
          editedTextProblems: summary.editedTextProblems,
          recipientZones: summary.recipientZones,
          defaultTimeZone: summary.defaultTimeZone,
          senderName: summary.senderName,
          problems: summary.problems,
          goLive: summary.goLive,
          madeBeforeGoLive: summary.madeBeforeGoLive,
        }}
      />
    </WizardFrame>
  );
}
