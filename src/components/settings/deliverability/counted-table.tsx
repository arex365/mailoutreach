import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/core/time/format";

/** One email counted toward the health limit right now (from loadCountedRows). */
export type CountedRowView = {
  emailId: number;
  address: string;
  companyId: number | null;
  companyName: string;
  campaignId: number;
  campaignName: string;
  lists: string[];
  at: Date;
  reason: string | null;
  code: number | null;
  message: string | null;
};

/**
 * "Bounces counted now" / "Complaints counted now" (§5.5, SPEC §8 "show why"): each email that counts toward the
 * automatic pause, with its company, campaign and lists, so the Owner can find the list they came from. A card with
 * its title and one-sentence description (M6-DESIGN §5.1 R3); the table scrolls inside it on a phone.
 * Server component; phones hide the Lists column.
 */
export function CountedTable({
  id,
  title,
  description,
  rows,
  emptyText,
  timeZone,
}: {
  id: string;
  title: string;
  description: string;
  rows: CountedRowView[];
  emptyText: string;
  timeZone: string;
}) {
  return (
    <Card id={id} className="scroll-mt-20">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table scrollLabel={title}>
              <TableHeader>
                <TableRow>
                  <TableHead>Address</TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead className="hidden md:table-cell">Lists</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="sr-only sm:not-sr-only">Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.emailId}>
                    <TableCell className="break-all">{r.address}</TableCell>
                    <TableCell>
                      {r.companyId ? (
                        <Link href={`/contacts?company=${r.companyId}`} className="underline underline-offset-4 hover:no-underline">
                          {r.companyName}
                        </Link>
                      ) : (
                        r.companyName
                      )}
                    </TableCell>
                    <TableCell>
                      <Link href={`/campaigns/${r.campaignId}`} className="underline underline-offset-4 hover:no-underline">
                        {r.campaignName}
                      </Link>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">{r.lists.length ? r.lists.join(", ") : "None"}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDateTime(r.at, timeZone)}</TableCell>
                    <TableCell>
                      {r.reason || r.code !== null || r.message ? (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Details</summary>
                          <p className="mt-1 max-w-xs break-words text-muted-foreground">
                            {[r.reason ? `Reason: ${r.reason}` : null, r.code !== null ? `Code: ${r.code}` : null, r.message]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        </details>
                      ) : (
                        <span className="text-xs text-muted-foreground">No details</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
