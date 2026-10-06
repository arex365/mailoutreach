import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/dal";
import { VerifyStep } from "@/components/campaign-wizard/verify-step";
import { WizardFrame } from "@/components/campaign-wizard/wizard-frame";
import type { VerifyLastRun } from "@/components/checks/verify-model";
import { getSetting } from "@/server/settings";
import { checkRunView } from "@/server/services/verification/runs";
import { campaignCheckView } from "@/server/services/verification/select";
import { loadWizardDraft, requestTime } from "../load";

export const metadata: Metadata = { title: "Campaign · Verify" };

const FINISHED = new Set(["DONE", "FAILED", "CANCELLED"]);

/**
 * Step 4, Verify (M5-DESIGN §6.1): the check services count the ticked people's addresses that need a check (the
 * campaign's own mode, the launch phase), price them and say whether checks can run now; the campaign's current or
 * latest check run comes with its results when it has finished. A dry run needs no checks (it can check them anyway
 * for later), and Test mode (always) and live campaigns before go-live only reach the test list, whose addresses count
 * as checked (M6-DESIGN §2.7).
 */
export default async function VerifyStepPage(props: PageProps<"/campaigns/[id]/setup/verify">) {
  const user = await requireUser();
  const { id } = await props.params;
  const draft = await loadWizardDraft(id);
  const now = requestTime();
  const [view, maxAge] = await Promise.all([campaignCheckView(draft.id, now), getSetting("verification.maxAgeDays")]);

  let lastRun: VerifyLastRun | null = null;
  if (view.run && FINISHED.has(view.run.status)) {
    const finished = await checkRunView(view.run.jobId, now);
    lastRun = { status: finished.status as VerifyLastRun["status"], counts: finished.counts, error: finished.error };
  }

  return (
    <WizardFrame campaign={draft} current="verify" mode={draft.mode} goLive={draft.goLive}>
      <VerifyStep
        campaignId={draft.id}
        view={view}
        lastRun={lastRun}
        isOwner={user.role === "OWNER"}
        maxAgeDays={Number.isInteger(maxAge) && maxAge > 0 ? maxAge : 90}
        timeZone={user.timeZone}
        nowIso={now.toISOString()}
      />
    </WizardFrame>
  );
}
