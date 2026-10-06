import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/dal";
import { SenderStep } from "@/components/campaign-wizard/sender-step";
import { WizardFrame } from "@/components/campaign-wizard/wizard-frame";
import { listSenderChoices } from "@/server/services/campaigns/draft";
import { loadTeamFrom } from "@/server/services/mailgun/team-from";
import { loadWizardDraft } from "../load";

export const metadata: Metadata = { title: "Campaign · Sender" };

export default async function SenderStepPage(props: PageProps<"/campaigns/[id]/setup/sender">) {
  const user = await requireUser();
  const { id } = await props.params;
  const draft = await loadWizardDraft(id);
  // The shared From address (SHARED-FROM-DESIGN §3.7) and the way of sending (MAIN-DOMAIN-DESIGN §3.7): read once, for
  // the From lines and the step's words. In own-mailbox mode the step gets the own From (null while none fits) and, then,
  // why test and live campaigns can't start.
  const team = await loadTeamFrom();
  const teamFrom = team.address;
  const senders = await listSenderChoices({ team });
  const ownMailbox = team.replies === "own-mailbox" ? { from: team.ownFrom, problem: team.problem } : null;
  return (
    <WizardFrame campaign={draft} current="sender" mode={draft.mode} goLive={draft.goLive}>
      <SenderStep
        campaignId={draft.id}
        senders={senders}
        selectedId={draft.senderId}
        viewerId={user.id}
        teamFrom={teamFrom}
        ownMailbox={ownMailbox}
      />
    </WizardFrame>
  );
}
