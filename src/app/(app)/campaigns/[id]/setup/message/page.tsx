import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/dal";
import { MessageStep } from "@/components/campaign-wizard/message-step";
import { WizardFrame } from "@/components/campaign-wizard/wizard-frame";
import { defaultDraftRecipient, getDraftSteps } from "@/server/services/campaigns/draft";
import { listTemplates, templateVariables } from "@/server/services/templates";
import { loadWizardDraft } from "../load";

export const metadata: Metadata = { title: "Campaign · Message" };

export default async function MessageStepPage(props: PageProps<"/campaigns/[id]/setup/message">) {
  await requireUser();
  const { id } = await props.params;
  const draft = await loadWizardDraft(id);
  const [steps, templates, variables, recipient] = await Promise.all([
    getDraftSteps(draft.id),
    listTemplates(),
    templateVariables(),
    defaultDraftRecipient(draft.id),
  ]);
  return (
    <WizardFrame campaign={draft} current="message" mode={draft.mode} goLive={draft.goLive}>
      <MessageStep
        campaignId={draft.id}
        initialSteps={steps}
        templates={templates.map((t) => ({ id: t.id, name: t.name, isMaster: t.isMaster }))}
        sourceTemplateId={draft.sourceTemplateId}
        variables={variables}
        senderName={draft.senderName}
        defaultRecipient={recipient}
      />
    </WizardFrame>
  );
}
