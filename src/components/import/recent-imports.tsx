import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { importSourceLabel, importSummarySentence, type ImportResultSummary, type ImportStatusValue } from "@/core/import/types";
import { formatDateTime } from "@/core/time/format";

export type RecentImportItem = {
  id: number;
  fileName: string;
  kind: string;
  status: ImportStatusValue;
  rowCount: number;
  createdAt: Date;
  createdByName: string;
  summary: ImportResultSummary | null;
};

function statusText(item: RecentImportItem): string {
  switch (item.status) {
    case "UPLOADED":
    case "MAPPED":
      return "Not imported yet";
    case "COMMITTING":
      return "Importing…";
    case "DONE":
      return item.summary
        ? importSummarySentence(importSourceLabel(item.fileName, item.kind), item.summary).replace(/^Imported [^:]*: /, "")
        : "Finished";
    case "FAILED":
      return "Stopped before it finished";
    case "CANCELLED":
      return "Cancelled";
  }
}

/** The last imports, so a result (and its problem rows) can be opened again. */
export function RecentImports({ items, timeZone }: { items: RecentImportItem[]; timeZone: string }) {
  return (
    <section aria-labelledby="recent-imports" className="grid gap-3">
      <h2 id="recent-imports" className="text-base font-medium">
        Recent imports
      </h2>
      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No imports yet. Files you import show here, so you can open their results again.
        </p>
      ) : (
        <div className="rounded-lg border border-border">
          <Table scrollLabel="Recent imports">
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead className="hidden md:table-cell">By</TableHead>
                <TableHead className="hidden sm:table-cell">When</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="w-20">
                  <span className="sr-only">Open</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id} className="align-top">
                  <TableCell className="max-w-56 whitespace-normal">
                    <div className="truncate font-medium" title={item.fileName}>
                      {item.kind === "paste" ? "Pasted rows" : item.fileName}
                    </div>
                    <div className="text-xs text-muted-foreground">{item.rowCount.toLocaleString("en-US")} rows</div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{item.createdByName}</TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">{formatDateTime(item.createdAt, timeZone)}</TableCell>
                  <TableCell className="max-w-96 whitespace-normal text-sm">{statusText(item)}</TableCell>
                  <TableCell>
                    <Button asChild size="sm" variant="ghost">
                      <Link href={`/import/${item.id}`}>{item.status === "UPLOADED" || item.status === "MAPPED" ? "Continue" : "Open"}</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
