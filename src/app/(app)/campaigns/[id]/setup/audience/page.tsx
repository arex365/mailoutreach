import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/dal";
import { AudienceStep, type AudienceNotice } from "@/components/campaign-wizard/audience-step";
import { WizardFrame } from "@/components/campaign-wizard/wizard-frame";
import { countryName } from "@/core/geo/display";
import { loadAudiencePage } from "@/server/services/campaigns/audience";
import { getCompanyFilterOptions, getContactsSidebar } from "@/server/services/companies/query";
import { loadWizardDraft, param, positiveInt } from "../load";

export const metadata: Metadata = { title: "Campaign · Audience" };

export default async function AudienceStepPage(props: PageProps<"/campaigns/[id]/setup/audience">) {
  await requireUser();
  const { id } = await props.params;
  const sp = await props.searchParams;
  const draft = await loadWizardDraft(id);
  const [page, sidebar, filterOptions] = await Promise.all([
    loadAudiencePage(draft.id, {
      section: param(sp.section) === "excluded" ? "excluded" : "included",
      q: param(sp.q) ?? "",
      page: positiveInt(sp.page) ?? 1,
    }),
    getContactsSidebar(),
    getCompanyFilterOptions(),
  ]);
  const options = {
    lists: sidebar.lists,
    tags: filterOptions.tags,
    countries: filterOptions.countries
      .map((code) => ({ code, name: countryName(code) || code }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    niches: filterOptions.niches,
  };
  const noticeParam = param(sp.notice);
  const notice: AudienceNotice = noticeParam === "list-gone" || noticeParam === "capped" ? noticeParam : null;

  return (
    <WizardFrame campaign={draft} current="audience" mode={draft.mode} goLive={draft.goLive}>
      <AudienceStep campaignId={draft.id} page={page} options={options} notice={notice} />
    </WizardFrame>
  );
}
