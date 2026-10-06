import type { Metadata } from "next";
import { DatabaseBackup, TriangleAlert } from "lucide-react";
import { requireUser } from "@/lib/auth/dal";
import { EmptyState } from "@/components/page-header";
import { SettingsTitle } from "@/components/settings/settings-title";
import { CopyField } from "@/components/copy-text";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { plural } from "@/core/text";
import { BackupNowButton } from "./backup-now-button";
import { loadBackupsView } from "./load";
import { SecondFolderForm } from "./second-folder-form";

export const metadata: Metadata = { title: "Backups" };

/** A warning line in the page's warning tone (role="alert"): the old-backup banner and the disk-space line. */
function WarningBanner({ title, text }: { title: string; text?: string | null }) {
  return (
    <div role="alert" className="flex gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <div className="grid gap-1">
        <p className="font-medium text-warning">{title}</p>
        {text ? <p className="text-muted-foreground">{text}</p> : null}
      </div>
    </div>
  );
}

/**
 * Settings › Backups (everyone; M6-DESIGN §3.4–§3.7): the warning, the last backup with Back up now (the page's one
 * orange button), the last restore, every saved backup with its kind, the second folder (Owner only) and how to
 * restore.
 */
export default async function BackupsPage() {
  const user = await requireUser();
  const view = await loadBackupsView(user);

  return (
    <div>
      <SettingsTitle title="Backups" description={view.description} />
      <div className="grid gap-6">
        {view.banner ? <WarningBanner title={view.banner.title} text={view.banner.text} /> : null}
        {view.diskLow ? <WarningBanner title={view.diskLow} /> : null}

        <Card>
          <CardHeader>
            <CardTitle>Last backup</CardTitle>
            <CardDescription>{view.lastBackup ?? "None yet."}</CardDescription>
          </CardHeader>
          <CardContent>
            {/* The button follows a backup queued elsewhere too (Save folder's first copy), so the page shows whether
                the copy worked (review SCREENS-03). */}
            <BackupNowButton
              initialJobId={view.pendingJob?.id ?? null}
              initialStatus={view.pendingJob?.status ?? null}
              workerRunning={view.workerRunning}
            />
          </CardContent>
        </Card>

        {view.lastRestore ? (
          <Card>
            <CardHeader>
              <CardTitle>Last restore</CardTitle>
              <CardDescription>{view.lastRestore.restoredLine}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {view.lastRestore.report.text ? (
                <p className={view.lastRestore.report.risk ? "text-warning" : undefined}>{view.lastRestore.report.text}</p>
              ) : null}
              {view.lastRestore.report.details.length > 0 ? (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Details</summary>
                  <ul className="mt-1 grid gap-1 text-muted-foreground">
                    {view.lastRestore.report.details.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
              <p className="text-muted-foreground">{view.lastRestore.resumeLine}</p>
            </CardContent>
          </Card>
        ) : null}

        <section aria-labelledby="saved-backups" className="grid gap-3">
          <h2 id="saved-backups" className="text-base font-medium">
            Saved backups
          </h2>
          {view.rows.length === 0 ? (
            <EmptyState
              icon={<DatabaseBackup className="size-6" aria-hidden />}
              title="No backups yet."
              description="The first daily backup runs within a day. To make one now, click Back up now above."
            />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table scrollLabel="Backups">
                <TableHeader>
                  <TableRow>
                    <TableHead>Made on</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead>Kind</TableHead>
                    {view.showCopyColumn ? <TableHead className="hidden sm:table-cell">Second copy</TableHead> : null}
                    <TableHead className="hidden md:table-cell">File</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.rows.map((b) => (
                    <TableRow key={b.fileName}>
                      <TableCell>
                        <span className="block">{b.madeOn}</span>
                        <span className="block text-xs text-muted-foreground">{b.ago}</span>
                      </TableCell>
                      <TableCell className="tabular text-right">{b.size}</TableCell>
                      <TableCell>{b.kind}</TableCell>
                      {view.showCopyColumn ? (
                        <TableCell className="hidden text-muted-foreground sm:table-cell">{b.secondCopy}</TableCell>
                      ) : null}
                      <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">{b.fileName}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            {view.rows.length > 0
              ? `${plural(view.rows.length, "backup", "backups")} saved in this folder on the office PC:`
              : "Backups are saved in this folder on the office PC:"}
          </p>
          <CopyField label="Backup folder" value={view.folder} />
        </section>

        <Card>
          <CardHeader>
            <CardTitle>Second copy</CardTitle>
            <CardDescription>
              Also copy every daily and Back up now backup to another drive, a USB stick or a OneDrive folder, so a copy
              survives if this PC&apos;s disk fails. The newest 14 daily and 5 Back up now backups are kept there too.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {view.practiceCopy ? (
              <p className="text-sm text-muted-foreground">The practice copy doesn&apos;t copy its backups to a second folder.</p>
            ) : (
              <SecondFolderForm value={view.secondFolder} canEdit={view.isOwner} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>How to restore a backup</CardTitle>
            <CardDescription>
              Restoring replaces all the app&apos;s data with the copy in the backup. Anything changed after that backup
              is lost.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <ol className="grid list-decimal gap-1.5 pl-5">
              <li>
                On the office PC, double-click <strong>restore.bat</strong>. If Windows asks for permission, click Yes.
              </li>
              <li>
                Type the number of the backup you want (the newest is at the top, with its date and kind), then type{" "}
                <strong>yes</strong>.
              </li>
              <li>
                Wait while it stops the app, saves your current data as &ldquo;Before a restore&rdquo;, puts the backup in
                place and starts the app again.
              </li>
              <li>
                Open the app: sending stays paused while it checks Mailgun for emails sent after the backup (about 35
                minutes). Read the report in Settings › Sending &amp; Mailgun, then click Resume sending.
              </li>
            </ol>
            <p className="text-muted-foreground">
              Changed your mind? Run restore.bat again and pick the backup marked &ldquo;Before a restore&rdquo;.
            </p>
            <p className="text-muted-foreground">
              A backup in the second folder: type restore.bat followed by the file&apos;s full path.
            </p>
            <p className="text-muted-foreground">
              Keep a copy of the <strong className="text-foreground">.env</strong> file from the app folder somewhere
              safe, for example on a USB stick. It holds the key that unlocks your saved Mailgun and AI keys; without it,
              a restored app works but you have to enter those keys again.
            </p>
            <p className="text-muted-foreground">Moving to a new PC: see &ldquo;Backups and restore&rdquo; in the README.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
