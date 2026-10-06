import type { Metadata } from "next";
import Link from "next/link";
import { Mail } from "lucide-react";
import { requireUser } from "@/lib/auth/dal";
import { Button } from "@/components/ui/button";
import { StartCampaignButton } from "@/components/campaign-wizard/new-campaign";
import { getList } from "@/server/services/lists";

export const metadata: Metadata = { title: "New campaign" };

function listIdFrom(v: string | string[] | undefined): number | null {
  const s = Array.isArray(v) ? v[0] : v;
  if (!s || !/^\d{1,9}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

/**
 * /campaigns/new (optionally ?list=<id>), kept for old links and bookmarks. Opening it never
 * changes anything (PLAN.md B10: nothing changes on GET), so a link on another site or in an email
 * can't start drafts: it only asks "Start a new campaign?", and the button starts one through a
 * Server Action (a POST the app checks comes from itself). "New campaign" on Campaigns and in the
 * Ctrl+K menu, and "Email this list" on Contacts, call that action directly.
 */
export default async function NewCampaignPage(props: PageProps<"/campaigns/new">) {
  await requireUser();
  const sp = await props.searchParams;
  const listId = listIdFrom(sp.list);
  const list = listId ? await getList(listId) : null;
  const description = list
    ? `It starts with every company in the list ${list.name}, and is named after it. You choose who gets it on the next page.`
    : listId
      ? "That list doesn't exist any more, so the campaign starts empty. You add companies on the next page."
      : "It starts empty, with the emails from your master template. You add companies on the next page.";

  return (
    <div className="px-4 pt-10 pb-12 md:px-6">
      <section aria-labelledby="new-campaign-title" className="mx-auto grid max-w-md justify-items-center gap-3 rounded-lg border border-border bg-card px-6 py-10 text-center">
        <Mail className="size-6 text-muted-foreground" aria-hidden />
        <h1 id="new-campaign-title" className="text-lg font-semibold">
          Start a new campaign?
        </h1>
        <p className="text-sm text-muted-foreground">{description}</p>
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          <StartCampaignButton listId={list?.id ?? null} />
          <Button variant="outline" asChild>
            <Link href="/campaigns">Not now</Link>
          </Button>
        </div>
      </section>
    </div>
  );
}
