import Link from "next/link";
import { Search, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/page-header";
import { Pager } from "@/components/activity/pager";
import { formatDate } from "@/core/time/format";
import { cn } from "@/lib/utils";
import { AddSuppressionDialog } from "./add-suppression-dialog";
import { RemoveSuppressionButton } from "./remove-suppression-button";

export type SuppressionFilterValue = "all" | "BOUNCED" | "UNSUBSCRIBED" | "COMPLAINED" | "MANUAL" | "INVALID";

export type SuppressionListRow = {
  id: number;
  address: string;
  why: string;
  detail: string | null;
  companyId: number | null;
  companyName: string | null;
  campaignId: number | null;
  campaignName: string | null;
  from: string;
  createdAt: Date;
  inMailgun: "yes" | "waiting" | "practice";
  removable: { kind: "test-list" } | { kind: "reply-inbox"; userName: string } | null;
};

const CHIPS: ReadonlyArray<[SuppressionFilterValue, string]> = [
  ["all", "All"],
  ["BOUNCED", "Bounced"],
  ["UNSUBSCRIBED", "Unsubscribed"],
  ["COMPLAINED", "Complained"],
  ["MANUAL", "Do not email"],
  ["INVALID", "Invalid"],
];

const PAGE = "/settings/deliverability";

/** The page's link for a search, filter and page (the anchor keeps the list in view). */
export function suppressionHref(opts: { q?: string | null; filter?: SuppressionFilterValue; page?: number }): string {
  const p = new URLSearchParams();
  if (opts.q) p.set("q", opts.q);
  if (opts.filter && opts.filter !== "all") p.set("filter", opts.filter);
  if (opts.page && opts.page > 1) p.set("page", String(opts.page));
  const qs = p.toString();
  return `${PAGE}${qs ? `?${qs}` : ""}#list`;
}

const IN_MAILGUN: Record<SuppressionListRow["inMailgun"], string> = {
  yes: "Yes",
  waiting: "Waiting",
  practice: "Not in the practice copy",
};

/** R8 (M6-DESIGN §5.1): the list's empty state. */
export const SUPPRESSION_EMPTY_TEXT = "Nobody is on the do-not-email list.";

/**
 * The do-not-email list (§5.5): search, reason chips, 50 per page, who it came from and whether Mailgun has it too.
 * "Remove" only for test-list addresses and active users' reply inboxes. A card with its title and description
 * (M6-DESIGN §5.1 R3); "Add an address" sits in its header, or in the empty state. Server component.
 */
export function SuppressionList({
  rows,
  total,
  page,
  pageCount,
  q,
  filter,
  timeZone,
}: {
  rows: SuppressionListRow[];
  total: number;
  page: number;
  pageCount: number;
  q: string;
  filter: SuppressionFilterValue;
  timeZone: string;
}) {
  const searching = Boolean(q) || filter !== "all";
  const emptyList = rows.length === 0 && !searching;
  return (
    <Card id="list" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>Do-not-email list</CardTitle>
        <CardDescription>Addresses no campaign emails: bounces, unsubscribes, spam complaints and the ones you add.</CardDescription>
        {emptyList ? null : (
          <div className="pt-2">
            <AddSuppressionDialog />
          </div>
        )}
      </CardHeader>
      <CardContent className="grid gap-3">
        <form method="get" action={PAGE} role="search" className="flex flex-wrap items-center gap-2">
          {filter !== "all" ? <input type="hidden" name="filter" value={filter} /> : null}
          <label htmlFor="suppression-search" className="sr-only">
            Search addresses
          </label>
          <Input
            id="suppression-search"
            name="q"
            type="search"
            defaultValue={q}
            placeholder="Search addresses"
            autoComplete="off"
            spellCheck={false}
            className="max-w-72"
          />
          <Button type="submit" variant="outline" size="sm">
            <Search aria-hidden />
            Search
          </Button>
        </form>
        <nav aria-label="Filter by reason" className="flex flex-wrap gap-2">
          {CHIPS.map(([value, label]) => (
            <Link
              key={value}
              href={suppressionHref({ q, filter: value })}
              aria-current={filter === value ? "true" : undefined}
              className={cn(
                "rounded-full border px-3 py-1 text-sm transition-colors hover:text-foreground",
                filter === value ? "border-primary text-foreground" : "border-border text-muted-foreground",
              )}
            >
              {label}
            </Link>
          ))}
        </nav>

        {rows.length === 0 ? (
          searching ? (
            <EmptyState
              title="No addresses match."
              description="Try another search, or show every reason."
              actions={
                <Button asChild variant="outline">
                  <Link href={suppressionHref({})}>Show the whole list</Link>
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<ShieldCheck className="size-6" aria-hidden />}
              title={SUPPRESSION_EMPTY_TEXT}
              description="Bounces, unsubscribes and spam complaints appear here automatically."
              actions={<AddSuppressionDialog />}
            />
          )
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table scrollLabel="Do-not-email list">
                <TableHeader>
                  <TableRow>
                    <TableHead>Address</TableHead>
                    <TableHead>Why</TableHead>
                    <TableHead className="hidden md:table-cell">Company</TableHead>
                    <TableHead className="hidden lg:table-cell">Campaign</TableHead>
                    <TableHead className="hidden sm:table-cell">Where from</TableHead>
                    <TableHead className="hidden sm:table-cell">Added</TableHead>
                    <TableHead className="hidden md:table-cell">In Mailgun</TableHead>
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="break-all">{r.address}</TableCell>
                      <TableCell>
                        {r.why}
                        {r.detail ? <span className="block max-w-56 truncate text-xs text-muted-foreground" title={r.detail}>{r.detail}</span> : null}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        {r.companyId ? (
                          <Link href={`/contacts?company=${r.companyId}`} className="underline underline-offset-4 hover:no-underline">
                            {r.companyName}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">Not in Contacts</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        {r.campaignId ? (
                          <Link href={`/campaigns/${r.campaignId}`} className="underline underline-offset-4 hover:no-underline">
                            {r.campaignName}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">None</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">{r.from}</TableCell>
                      <TableCell className="hidden whitespace-nowrap sm:table-cell">{formatDate(r.createdAt, timeZone)}</TableCell>
                      <TableCell className="hidden md:table-cell">{IN_MAILGUN[r.inMailgun]}</TableCell>
                      <TableCell className="text-right">
                        {r.removable ? (
                          <RemoveSuppressionButton
                            email={r.address}
                            kind={r.removable.kind}
                            userName={r.removable.kind === "reply-inbox" ? r.removable.userName : null}
                          />
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Pager
              page={page}
              pageCount={pageCount}
              total={total}
              noun={["address", "addresses"]}
              hrefFor={(p) => suppressionHref({ q, filter, page: p })}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
