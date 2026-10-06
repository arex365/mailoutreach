import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/dal";
import { ReviewStep } from "@/components/campaign-wizard/review-step";
import { WizardFrame } from "@/components/campaign-wizard/wizard-frame";
import { REVIEW_FILTERS, loadReviewPage, type ReviewFilter } from "@/server/services/campaigns/draft";
import { templateVariables } from "@/server/services/templates";
import { loadWizardDraft, param, positiveInt } from "../load";

export const metadata: Metadata = { title: "Campaign · Review" };

export default async function ReviewStepPage(props: PageProps<"/campaigns/[id]/setup/review">) {
  await requireUser();
  const { id } = await props.params;
  const sp = await props.searchParams;
  const draft = await loadWizardDraft(id);
  const wanted = param(sp.filter);
  const filter: ReviewFilter = REVIEW_FILTERS.includes(wanted as ReviewFilter) ? (wanted as ReviewFilter) : "all";
  const [page, variables] = await Promise.all([
    loadReviewPage(draft.id, { filter, q: param(sp.q) ?? "", page: positiveInt(sp.page) ?? 1 }),
    templateVariables(),
  ]);
  return (
    <WizardFrame campaign={draft} current="review" mode={draft.mode} goLive={draft.goLive}>
      <ReviewStep campaignId={draft.id} page={page} variables={variables} initialPersonId={positiveInt(sp.person) ?? null} />
    </WizardFrame>
  );
}
