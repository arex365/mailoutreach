import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireOwner } from "@/lib/auth/dal";
import { EmptyState } from "@/components/page-header";
import { SettingsTitle } from "@/components/settings/settings-title";
import { ApplyButton, CheckAgainButton } from "@/components/settings/domain/apply-button";
import { applyIsPrimary } from "@/components/settings/domain/apply-rule";
import { Checklist, SetupSteps } from "@/components/settings/domain/checklist";
import { ReplyTestSection } from "@/components/settings/domain/reply-test-section";
import { loadDomainPage } from "./load";

export const metadata: Metadata = { title: "Domain checklist" };

/**
 * Settings › Domain checklist (Owner, M3-DESIGN §5.3, M6-DESIGN §5.1): the "Recommended settings" card first, with
 * "Apply recommended settings" and "Check again" in its header (R3) and the last Apply run; then the rows the domain
 * check computes (P4), each sender's reply route and the reply test. Apply is the page's orange button only while a
 * row it fixes isn't done (R1, applyIsPrimary); otherwise the page has none. In shared-From mode (SHARED-FROM-DESIGN
 * §3.2) the header has a second line with the From address, and Domain age asks about the From domain. In own-mailbox
 * mode (MAIN-DOMAIN-DESIGN §3.3) the second line says the emails go out through the domain itself, the card describes
 * Apply without receiving mail, and there are no reply routes.
 */
export default async function DomainChecklistPage() {
  const user = await requireOwner();
  const data = await loadDomainPage(user);

  if (data.state === "practice") {
    return (
      <div>
        <SettingsTitle title="Domain checklist" />
        <EmptyState title="The practice copy never talks to Mailgun" description="The domain checklist is only used in the real app." />
      </div>
    );
  }
  if (data.state === "not-connected") {
    return (
      <div>
        <SettingsTitle title="Domain checklist" />
        <EmptyState
          title={data.text}
          actions={
            <Button asChild variant="outline">
              <Link href="/settings/sending">Open Sending & Mailgun</Link>
            </Button>
          }
        />
      </div>
    );
  }

  // Shared-From mode (SHARED-FROM-DESIGN §3.2): a second header line names the From address and the sending domain.
  const description = data.headerFromLine ? (
    <>
      <span className="block">{data.headerLine}</span>
      <span className="block [overflow-wrap:anywhere]">{data.headerFromLine}</span>
    </>
  ) : (
    data.headerLine
  );

  return (
    <div>
      <SettingsTitle title="Domain checklist" description={description} />
      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Recommended settings</CardTitle>
            <CardDescription>{data.applyHint}</CardDescription>
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <ApplyButton runningJobId={data.applyJobId} primary={applyIsPrimary(data.rows)} />
              <CheckAgainButton checkedRecently={data.checkedRecently} />
            </div>
          </CardHeader>
          {data.setupLine && data.steps.length > 0 ? (
            <CardContent>
              <SetupSteps line={data.setupLine} steps={data.steps} bare />
            </CardContent>
          ) : null}
        </Card>
        <Checklist
          rows={data.rows}
          senders={data.senders}
          domain={data.domain}
          domainRegisteredOn={data.domainRegisteredOn}
          ageDomain={data.ageDomain}
          teamFrom={data.teamFrom}
          ownMailbox={data.ownMailbox === true}
        />
        <ReplyTestSection view={data.replyTest} />
      </div>
    </div>
  );
}
