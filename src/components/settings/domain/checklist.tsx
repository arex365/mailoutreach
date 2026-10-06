import Link from "next/link";
import { CircleCheck, CircleDashed, CircleMinus, CircleX, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import { applyStepStatus } from "@/core/dns/checklist";
import { senderAddressWords } from "@/core/sending/from-address";
import type { ChecklistGroup, ChecklistRecord, ChecklistRow, CheckStatus } from "@/core/system-state";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyField } from "@/components/copy-text";
import { cn } from "@/lib/utils";
import { DomainAgeForm } from "./domain-age-form";
import type { SenderRouteView, SetupStepView } from "../types";

/**
 * The Domain checklist rows (M3-DESIGN §5.3). The domain check (P4) computes every row and its wording; this only shows
 * them: grouped, with the status in words and colour, the fix when something isn't done, the DNS records with Copy
 * buttons and the technical "Details". The "Replies reach each sender" row also lists each sender's route with its
 * exact values, and "Domain age" has the purchase-date field.
 */

/** The checklist's groups, each a card with its title and one sentence (M6-DESIGN §5.1 R3). */
const GROUPS: ReadonlyArray<{ key: ChecklistGroup; title: string; description: string }> = [
  { key: "mailgun", title: "Mailgun", description: "Whether Mailgun has your sending domain." },
  { key: "dns", title: "DNS records", description: "The records at your domain's DNS host that let inboxes trust your emails." },
  { key: "settings", title: "Mailgun settings", description: "How Mailgun handles your emails, replies, unsubscribes and limits." },
  { key: "connection", title: "Connection", description: "Whether Mailgun and your team can reach the app, and the reply test." },
  { key: "optional", title: "Optional", description: "Good to have. Nothing waits for these." },
];

const STATUS: Record<CheckStatus, { icon: LucideIcon; tone: string; word: string }> = {
  ok: { icon: CircleCheck, tone: "text-success", word: "Done" },
  warn: { icon: TriangleAlert, tone: "text-warning", word: "Needs a look" },
  bad: { icon: CircleX, tone: "text-destructive", word: "Not done" },
  unknown: { icon: CircleDashed, tone: "text-muted-foreground", word: "Couldn't check right now." },
  info: { icon: Info, tone: "text-muted-foreground", word: "For your information" },
  off: { icon: CircleMinus, tone: "text-muted-foreground", word: "Off" },
};

/** A row's status in words and colour (never colour alone). `word` replaces the standard word. */
export function StatusLabel({ status, word }: { status: CheckStatus; word?: string }) {
  const s = STATUS[status];
  const Icon = s.icon;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs font-medium", s.tone)}>
      <Icon className="size-4" aria-hidden />
      {word ?? s.word}
    </span>
  );
}

function RecordBox({ r }: { r: ChecklistRecord }) {
  return (
    <div className="grid gap-2 rounded-md border border-border bg-muted/30 p-3">
      <p className="text-xs text-muted-foreground">
        Type <span className="font-mono text-foreground">{r.type}</span>
        {r.priority ? (
          <>
            {" "}
            · Priority <span className="font-mono text-foreground">{r.priority}</span>
          </>
        ) : null}
      </p>
      <div className="grid gap-1" title={r.fqdn || undefined}>
        <p className="text-xs text-muted-foreground">Name</p>
        <CopyField value={r.name} label={`${r.type} record name`} />
      </div>
      <div className="grid gap-1">
        <p className="text-xs text-muted-foreground">Value</p>
        <CopyField value={r.value} label={`${r.type} record value`} multiline={r.value.length > 90} />
      </div>
    </div>
  );
}

/** The empty "Replies reach each sender" sentence, in the mode's words (SHARED-FROM-DESIGN §3.2, §3.6). */
export function noReplyRoutesText(teamFrom: boolean): string {
  const w = senderAddressWords(teamFrom);
  return `Nobody has a ${w.lower} yet. Everyone adds theirs in Settings › My profile › ${w.label}.`;
}

function SenderRoutes({ senders, teamFrom = false }: { senders: SenderRouteView[]; teamFrom?: boolean }) {
  if (senders.length === 0) {
    return <p className="text-sm text-muted-foreground">{noReplyRoutesText(teamFrom)}</p>;
  }
  return (
    <ul className="grid gap-2" aria-label="Reply route per sender">
      {senders.map((s) => (
        <li key={s.address} className="grid gap-1.5 rounded-md border border-border p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="min-w-0 text-sm">
              <span className="font-medium">{s.name}</span> · <span className="font-mono text-xs">{s.address}</span>
              {s.forwardTo ? (
                <>
                  {" "}
                  → <span className="font-mono text-xs">{s.forwardTo}</span>
                </>
              ) : null}
            </p>
            <StatusLabel
              status={s.status === "ok" ? "ok" : s.status === "bad" ? "bad" : "unknown"}
              word={s.status === "ok" ? "Working" : s.status === "bad" ? "Not working" : "Being set up"}
            />
          </div>
          {s.status === "bad" ? <p className="text-sm text-destructive">{s.statusText}</p> : null}
          {s.removeHref ? (
            <div>
              <Button asChild variant="outline" size="sm">
                <Link href={s.removeHref}>Remove it</Link>
              </Button>
            </div>
          ) : null}
          {s.values ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">Route values (to set it up by hand)</summary>
              <div className="mt-2 grid gap-2">
                <div className="grid gap-1">
                  <p className="text-xs text-muted-foreground">Expression</p>
                  <CopyField value={s.values.expression} label={`expression for ${s.address}`} />
                </div>
                {s.values.actions.map((a, i) => (
                  <div key={a} className="grid gap-1">
                    <p className="text-xs text-muted-foreground">Action {i + 1}</p>
                    <CopyField value={a} label={`action ${i + 1} for ${s.address}`} />
                  </div>
                ))}
                <div className="grid gap-1">
                  <p className="text-xs text-muted-foreground">Priority</p>
                  <CopyField value={String(s.values.priority)} label={`priority for ${s.address}`} />
                </div>
                <div className="grid gap-1">
                  <p className="text-xs text-muted-foreground">Description</p>
                  <CopyField value={s.values.description} label={`description for ${s.address}`} />
                </div>
              </div>
            </details>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Row({
  row,
  children,
}: {
  row: Pick<ChecklistRow, "key" | "status" | "title" | "text" | "fix" | "records" | "detail">;
  children?: React.ReactNode;
}) {
  const found = row.records.filter((r) => r.found.length > 0);
  return (
    <li className="grid gap-2 border-b border-border py-4 last:border-b-0" data-row={row.key}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 className="min-w-0 text-sm font-medium">{row.title}</h4>
        <StatusLabel status={row.status} />
      </div>
      {row.text ? <p className="text-sm text-muted-foreground">{row.text}</p> : null}
      {row.status !== "ok" && row.fix ? <p className="text-sm">{row.fix}</p> : null}
      {row.status !== "ok" && row.records.length > 0 ? (
        <div className="grid gap-2 md:grid-cols-2">
          {row.records.map((r, i) => (
            <RecordBox key={`${r.type}-${r.name}-${i}`} r={r} />
          ))}
        </div>
      ) : null}
      {children}
      {row.detail || found.length > 0 ? (
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer">Details</summary>
          <div className="mt-1 grid gap-1 break-words font-mono text-xs">
            {row.detail ? <p>{row.detail}</p> : null}
            {found.map((r, i) => (
              <p key={i}>
                {r.fqdn || r.name}: {r.found.join(" · ")}
              </p>
            ))}
          </div>
        </details>
      ) : null}
    </li>
  );
}

/**
 * Every checklist group with its rows, plus the sender routes and the domain-age field. Shared From address
 * (SHARED-FROM-DESIGN §3.2): `ageDomain` is the domain the purchase date is asked for (the From domain; default the
 * sending domain) and `teamFrom` switches the empty reply-routes sentence to "reply address". The from-mx and from-spf
 * rows are ordinary rows of the "dns" group (the domain check words them).
 *
 * Own-mailbox mode (`ownMailbox`, MAIN-DOMAIN-DESIGN §3.3): replies never come through the app, so there is no reply
 * routes list and no "Replies reach each sender" placeholder row; the from-mx guard row is drawn like any other row
 * (never with a record box: the domain check gives it none).
 */
export function Checklist({
  rows,
  senders,
  domain,
  domainRegisteredOn,
  ageDomain,
  teamFrom = false,
  ownMailbox = false,
}: {
  rows: ChecklistRow[];
  senders: SenderRouteView[];
  domain: string;
  domainRegisteredOn: string | null;
  ageDomain?: string;
  teamFrom?: boolean;
  ownMailbox?: boolean;
}) {
  const hasRoutesRow = rows.some((r) => r.key === "reply-routes");
  const hasAgeRow = rows.some((r) => r.key === "domain-age");
  const ageFor = ageDomain ?? domain;
  // MAIN-DOMAIN-DESIGN §0.2 rule 7: no MX record box ever exists in own-mailbox mode (fail closed, whatever is stored).
  const shown = ownMailbox ? rows.map((r) => ({ ...r, records: r.records.filter((rec) => rec.type.trim().toUpperCase() !== "MX") })) : rows;
  return (
    <div className="grid gap-6">
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm">
          The app hasn&apos;t checked {domain} yet. Click Check again, or wait a minute after connecting.
        </p>
      ) : null}
      {GROUPS.map((g) => {
        const inGroup = shown.filter((r) => r.group === g.key && !(ownMailbox && r.key === "reply-routes"));
        const extraRoutes = g.key === "settings" && !hasRoutesRow && !ownMailbox;
        const extraAge = g.key === "optional" && !hasAgeRow;
        if (inGroup.length === 0 && !extraRoutes && !extraAge) return null;
        return (
          <Card key={g.key} className="pb-0">
            <CardHeader>
              <CardTitle>
                <h3 id={`group-${g.key}`}>{g.title}</h3>
              </CardTitle>
              <CardDescription>{g.description}</CardDescription>
            </CardHeader>
            <ul aria-labelledby={`group-${g.key}`} className="px-4">
              {inGroup.map((row) => (
                <Row key={row.key} row={row}>
                  {row.key === "reply-routes" && !ownMailbox ? <SenderRoutes senders={senders} teamFrom={teamFrom} /> : null}
                  {row.key === "domain-age" ? <DomainAgeForm domain={ageFor} value={domainRegisteredOn} /> : null}
                </Row>
              ))}
              {extraRoutes ? (
                <Row row={{ key: "reply-routes", status: "unknown", title: "Replies reach each sender", text: "", fix: null, records: [], detail: null }}>
                  <SenderRoutes senders={senders} teamFrom={teamFrom} />
                </Row>
              ) : null}
              {extraAge ? (
                <Row row={{ key: "domain-age", status: "info", title: "Domain age", text: "", fix: null, records: [], detail: null }}>
                  <DomainAgeForm domain={ageFor} value={domainRegisteredOn} />
                </Row>
              ) : null}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}

/**
 * The last "Apply recommended settings" run, step by step. `bare`: without its own box and heading, for the page's
 * "Recommended settings" card (M6-DESIGN §5.1 R3), which has them.
 */
export function SetupSteps({ line, steps, bare = false }: { line: string | null; steps: SetupStepView[]; bare?: boolean }) {
  if (!line || steps.length === 0) return null;
  const list = (
    <ul className="grid gap-2">
      {steps.map((s) => (
        <li key={s.key} className="flex items-start gap-2 text-sm">
          {/* Review DOMAIN-3, SCREENS-06: a step that isn't needed, optional or not in the plan says so (grey), never "Waiting". */}
          <StatusLabel {...applyStepStatus(s)} />
          <div className="min-w-0">
            <p>{s.text}</p>
            {s.detail && s.ok === false ? (
              <details className="text-muted-foreground">
                <summary className="cursor-pointer text-xs">Details</summary>
                <p className="mt-1 break-words font-mono text-xs">{s.detail}</p>
              </details>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
  if (bare) {
    return (
      <div className="grid gap-2">
        <p className="text-sm text-muted-foreground">{line}</p>
        {list}
      </div>
    );
  }
  return (
    <section aria-labelledby="setup-steps" className="grid gap-2 rounded-lg border border-border bg-card p-4">
      <h3 id="setup-steps" className="text-base font-semibold">
        Recommended settings
      </h3>
      <p className="text-sm text-muted-foreground">{line}</p>
      {list}
    </section>
  );
}
