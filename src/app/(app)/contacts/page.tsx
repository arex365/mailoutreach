import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth/dal";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { CompanyPanel } from "@/components/company-panel/company-panel";
import { AddCompanyButton, AddCompanyDialog } from "@/components/contacts/add-company-dialog";
import { CompanyPanelSkeleton, CompanySheet } from "@/components/contacts/company-sheet";
import { ContactsProvider } from "@/components/contacts/contacts-provider";
import { ContactsView } from "@/components/contacts/contacts-view";
import { toContactRow } from "@/components/contacts/format";
import { ListSidebar } from "@/components/contacts/list-sidebar";
import { StatusTabs } from "@/components/contacts/status-tabs";
import { emptyKindFor } from "@/components/contacts/url";
import { NoticeToast } from "@/components/shell/notice-toast";
import { countryName } from "@/core/geo/display";
import { parseCompanyFilters } from "@/server/services/companies/filters";
import {
  countCompaniesByStatus,
  getCompanyCustomColumns,
  getCompanyFilterOptions,
  getContactsSidebar,
  listCompanies,
} from "@/server/services/companies/query";

export const metadata: Metadata = { title: "Contacts" };

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function positiveInt(v: string | undefined): number | null {
  if (!v || !/^\d{1,9}$/.test(v)) return null;
  const n = Number(v);
  return n > 0 ? n : null;
}

/**
 * Contacts (PLAN.md A6): the list sidebar, the status tabs and the companies table. "Get started" moved to the
 * dashboard (M6-DESIGN §4.4); with no companies yet the table shows its own empty state (A6 text).
 */
export default async function ContactsPage(props: PageProps<"/contacts">) {
  const user = await requireUser();
  const sp = await props.searchParams;
  const filters = parseCompanyFilters(sp);
  const companyId = positiveInt(first(sp.company));
  const notice = first(sp.notice) ?? null;

  const [result, statusCounts, sidebar, filterOptions, customColumns] = await Promise.all([
    listCompanies(filters, user),
    countCompaniesByStatus(filters),
    getContactsSidebar(),
    getCompanyFilterOptions(),
    getCompanyCustomColumns(),
  ]);

  const rows = result.rows.map((r) => toContactRow(r, user));
  const shownFilters = { ...filters, page: result.page };
  const currentList = filters.listId ? sidebar.lists.find((l) => l.id === filters.listId) : undefined;
  const empty = emptyKindFor(filters, result.total, sidebar.allCount, !filters.listId || Boolean(currentList));
  const heading = currentList ? currentList.name : filters.view === "missing-email" ? "Missing email" : null;

  const options = {
    tags: filterOptions.tags,
    countries: filterOptions.countries
      .map((code) => ({ code, name: countryName(code) || code }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    niches: filterOptions.niches,
    users: filterOptions.users,
    customColumns,
  };

  return (
    <ContactsProvider companyId={companyId}>
      <div className="flex">
        <ListSidebar
          allCount={sidebar.allCount}
          missingEmailCount={sidebar.missingEmailCount}
          lists={sidebar.lists}
          active={{ view: filters.view ?? "all", listId: filters.listId }}
        />
        <div className="min-w-0 flex-1">
          <PageHeader
            title="Contacts"
            description={heading ? <span className="text-foreground/80">{heading}</span> : undefined}
            actions={
              <>
                <Button variant="outline" asChild>
                  <Link href="/import">Import</Link>
                </Button>
                <AddCompanyButton />
              </>
            }
          />
          <StatusTabs filters={filters} counts={statusCounts} />
          <ContactsView
            rows={rows}
            total={result.total}
            page={result.page}
            pageCount={result.pageCount}
            pageSize={result.pageSize}
            filters={shownFilters}
            options={options}
            sidebar={sidebar}
            empty={empty}
          />
        </div>
      </div>
      <CompanySheet>
        {companyId ? (
          <Suspense key={companyId} fallback={<CompanyPanelSkeleton />}>
            <CompanyPanel companyId={companyId} user={user} />
          </Suspense>
        ) : null}
      </CompanySheet>
      <AddCompanyDialog lists={sidebar.lists} niches={options.niches} defaultListId={filters.listId} />
      <NoticeToast notice={notice} />
    </ContactsProvider>
  );
}
