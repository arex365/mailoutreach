import type { Metadata } from "next";
import Link from "next/link";
import { Inbox, Mail } from "lucide-react";
import { requireUser } from "@/lib/auth/dal";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/page-header";
import { NewCampaignButton } from "@/components/campaign-wizard/new-campaign";
import { CampaignList } from "@/components/campaigns/campaign-list";
import { CampaignTabs } from "@/components/campaigns/campaign-tabs";
import { ListPager } from "@/components/campaigns/pager";
import {
  CAMPAIGN_TABS,
  campaignsHref,
  defaultCampaignTab,
  parseCampaignTab,
  tabEmptyText,
  toCampaignListView,
} from "@/components/campaigns/format";
import { countCampaignsByTab, listCampaigns } from "@/server/services/campaigns/queries";

export const metadata: Metadata = { title: "Campaigns" };

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function positiveInt(v: string | undefined): number | null {
  if (!v || !/^\d{1,9}$/.test(v)) return null;
  const n = Number(v);
  return n > 0 ? n : null;
}

/** Campaigns (PLAN.md A6): tabs Drafts / Scheduled / Running / Paused / Finished, each campaign with its progress. */
export default async function CampaignsPage({ searchParams }: PageProps<"/campaigns">) {
  const user = await requireUser();
  const sp = await searchParams;
  const counts = await countCampaignsByTab();
  const total = CAMPAIGN_TABS.reduce((sum, t) => sum + counts[t], 0);
  const tab = parseCampaignTab(first(sp.tab)) ?? defaultCampaignTab(counts) ?? "drafts";
  const list = total > 0 ? await listCampaigns(tab, { page: positiveInt(first(sp.page)) }) : null;
  const now = new Date();
  const items = list ? list.items.map((c) => toCampaignListView(c, user.timeZone, now)) : [];

  return (
    <div>
      <PageHeader
        title="Campaigns"
        description="Each campaign emails the people you picked, from one sender, with a first email and its follow-ups."
        actions={
          <>
            <Button asChild variant="outline">
              <Link href="/campaigns/outbox">
                <Inbox aria-hidden />
                Dry-run outbox
              </Link>
            </Button>
            {/* Starts a draft with a click (a Server Action), never through a link. */}
            <NewCampaignButton />
          </>
        }
      />
      {total === 0 ? (
        <div className="px-4 pb-12 md:px-6">
          <EmptyState
            icon={<Mail className="size-6" aria-hidden />}
            title="No campaigns yet. Go to Contacts, tick the companies you want to email and click Email these companies."
            actions={
              <Button asChild variant="outline">
                <Link href="/contacts">Go to Contacts</Link>
              </Button>
            }
          />
        </div>
      ) : (
        <>
          <CampaignTabs active={tab} counts={counts} />
          {/* grid-cols-1 (minmax(0, 1fr)): a long campaign name must not widen the page on a phone. */}
          <div className="grid grid-cols-1 gap-4 px-4 pt-4 pb-12 md:px-6">
            {items.length === 0 ? (
              <EmptyState
                title={tabEmptyText(tab)}
                actions={
                  <Button asChild variant="outline">
                    <Link href="/contacts">Go to Contacts</Link>
                  </Button>
                }
              />
            ) : (
              <CampaignList items={items} />
            )}
            {list ? (
              <ListPager
                page={list.page}
                pageCount={list.pageCount}
                total={list.total}
                noun={["campaign", "campaigns"]}
                hrefFor={(p) => campaignsHref(tab, p)}
              />
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
