import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/dal";
import { stepKeyFor, wizardHref } from "@/components/campaign-wizard/steps";
import { loadWizardDraft } from "./load";

/** /campaigns/<id>/setup opens the step the draft got to last (Campaign.wizardStep). */
export default async function CampaignSetupPage(props: PageProps<"/campaigns/[id]/setup">) {
  await requireUser();
  const { id } = await props.params;
  const draft = await loadWizardDraft(id);
  redirect(wizardHref(draft.id, stepKeyFor(draft.wizardStep)));
}
