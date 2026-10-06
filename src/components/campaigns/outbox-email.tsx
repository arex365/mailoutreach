import Link from "next/link";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UNSUBSCRIBE_PLACEHOLDER } from "@/core/templates/html";
import { formatDateTime } from "@/core/time/format";
import { stepTitle } from "@/core/rules/wording";
import type { OutboxEmail } from "@/server/services/campaigns/queries";
import { campaignPageHref } from "./format";

/**
 * The stored HTML version, in a fully sandboxed frame: sandbox="" gives it no scripts, no forms,
 * no pop-ups, no navigation and an origin of its own, even though it's HTML we generated ourselves.
 */
export function EmailHtmlFrame({ html }: { html: string }) {
  if (!html) {
    return <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">No HTML version was stored.</p>;
  }
  return (
    <iframe
      title="HTML version of this email"
      sandbox=""
      srcDoc={html}
      referrerPolicy="no-referrer"
      className="h-96 w-full rounded-lg border border-border bg-white"
    />
  );
}

/**
 * One dry-run email in full (PLAN.md M2: "read the 'sent' emails in the outbox"): From (and its Reply-To in
 * shared-From mode, SHARED-FROM-DESIGN §3.7), To, Subject, the plain text and the HTML version. The HTML is our own generated HTML, but it is
 * still shown in a fully sandboxed frame (sandbox="": no scripts, no forms, no navigation).
 * From Milestone 3 the page passes the "Simulate" row (SimulateButtons) as `simulate`, shown at the bottom.
 */
export function OutboxEmailView({
  email,
  timeZone,
  simulate = null,
}: {
  email: OutboxEmail;
  timeZone: string;
  simulate?: React.ReactNode;
}) {
  const hasPlaceholder = email.text.includes(UNSUBSCRIBE_PLACEHOLDER) || email.html.includes(UNSUBSCRIBE_PLACEHOLDER);
  return (
    <div className="grid min-w-0 gap-5 p-4 md:p-6">
      <header className="grid gap-1 pr-10">
        <p className="text-xs text-muted-foreground">
          Dry run · nothing left this PC
        </p>
        <h2 className="text-lg font-semibold break-words">{email.subject || "No subject"}</h2>
      </header>

      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[7rem_minmax(0,1fr)]">
        <dt className="text-muted-foreground">From</dt>
        <dd className="break-words">{email.fromAddress}</dd>
        {email.replyTo ? (
          <>
            <dt className="text-muted-foreground">Reply-To</dt>
            <dd className="break-words">{email.replyTo}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">To</dt>
        <dd className="break-words">
          {email.toEmail} <span className="text-muted-foreground">({email.companyName})</span>
        </dd>
        <dt className="text-muted-foreground">Subject</dt>
        <dd className="break-words">{email.subject || "No subject"}</dd>
        <dt className="text-muted-foreground">Sent</dt>
        <dd>{formatDateTime(email.sentAt, timeZone)}</dd>
        <dt className="text-muted-foreground">Campaign</dt>
        <dd className="break-words">
          <Link href={campaignPageHref(email.campaignId, { recipient: email.recipientId })} className="underline underline-offset-4 hover:no-underline">
            {email.campaignName}
          </Link>
          <span className="text-muted-foreground">, {stepTitle(email.step).toLowerCase()}</span>
        </dd>
        <dt className="text-muted-foreground">Message-ID</dt>
        <dd className="font-mono text-xs break-all">&lt;{email.messageId}&gt;</dd>
        {email.inReplyTo ? (
          <>
            <dt className="text-muted-foreground">In reply to</dt>
            <dd className="font-mono text-xs break-all">&lt;{email.inReplyTo}&gt;</dd>
          </>
        ) : null}
      </dl>

      <Tabs defaultValue="text" className="min-w-0">
        <TabsList>
          <TabsTrigger value="text">Plain text</TabsTrigger>
          <TabsTrigger value="html">HTML version</TabsTrigger>
        </TabsList>
        <TabsContent value="text" className="mt-2">
          <pre className="rounded-lg border border-border bg-background p-4 font-sans text-sm leading-relaxed break-words whitespace-pre-wrap">
            {email.text || "No text was stored."}
          </pre>
        </TabsContent>
        <TabsContent value="html" className="mt-2">
          <EmailHtmlFrame html={email.html} />
        </TabsContent>
      </Tabs>

      {hasPlaceholder ? (
        <p className="text-xs text-muted-foreground">
          When the email really goes out, Mailgun turns {UNSUBSCRIBE_PLACEHOLDER} into each person&apos;s own unsubscribe link.
        </p>
      ) : null}

      {simulate}
    </div>
  );
}
