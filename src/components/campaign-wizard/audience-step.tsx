"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Info, Search, TriangleAlert, Undo2, X } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { StatusBadge, VerificationBadge } from "@/components/badges";
import { EmptyState } from "@/components/page-header";
import { plural } from "@/core/text";
import { cn } from "@/lib/utils";
import { clearAudienceAction, putBackCompanyAction, removeAudienceCompanyAction, tickPersonAction } from "@/app/(app)/campaigns/[id]/setup/actions";
import type { AudienceCompanyView, AudiencePage, AudienceSection } from "@/server/services/campaigns/audience";
import { AddCompanies, type AudienceFilterOptions } from "./add-companies";
import { moveTotals, nobodyTickedText, withTick } from "./audience-state";
import { audienceSummary } from "./format";
import { StepFooter } from "./step-footer";
import { wizardHref } from "./steps";

const OFFLINE = "Couldn't reach the app, so nothing changed. Check your connection and try again.";

export type AudienceNotice = "list-gone" | "capped" | null;

/**
 * Step 1, Audience (PLAN.md B6.4): who gets the email. Companies are added by list, status, tag,
 * country or niche (or come from the Contacts selection). Each company shows its people with a
 * tick box; the engine's default person is ticked. Companies nobody can be emailed at sit under
 * "Excluded" with the reason in words (a Replied company can be put back by hand). 50 companies
 * per page; the totals always cover the whole campaign.
 */
export function AudienceStep({
  campaignId,
  page,
  options,
  notice,
}: {
  campaignId: number;
  page: AudiencePage;
  options: AudienceFilterOptions;
  notice: AudienceNotice;
}) {
  const router = useRouter();
  // Local copy for instant ticks; a fresh server page (navigation, refresh) replaces it.
  const [state, setState] = useState(() => ({ source: page, companies: page.companies, totals: page.totals }));
  if (state.source !== page) setState({ source: page, companies: page.companies, totals: page.totals });
  const [busy, setBusy] = useState<ReadonlySet<number>>(() => new Set());
  const [putBackFor, setPutBackFor] = useState<AudienceCompanyView | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const { companies, totals } = state;
  const counts = { included: totals.includedCompanies, excluded: totals.excludedCompanies };

  function replaceCompany(next: AudienceCompanyView) {
    setState((s) => {
      const before = s.companies.find((c) => c.companyId === next.companyId);
      // Not on this page any more (a fresh page arrived meanwhile): it already has the right totals.
      if (!before) return s;
      return {
        ...s,
        companies: s.companies.map((c) => (c.companyId === next.companyId ? next : c)),
        totals: moveTotals(s.totals, before, next),
      };
    });
  }

  function setBusyFor(companyId: number, on: boolean) {
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(companyId);
      else next.delete(companyId);
      return next;
    });
  }

  async function tick(company: AudienceCompanyView, personId: number, ticked: boolean) {
    const before = company;
    replaceCompany(withTick(company, personId, ticked));
    setBusyFor(company.companyId, true);
    try {
      const res = await tickPersonAction({ campaignId, personId, ticked });
      if (!res.ok) {
        replaceCompany(before);
        toast.error(res.error);
        return;
      }
      replaceCompany(res.data.company);
    } catch {
      replaceCompany(before);
      toast.error(OFFLINE);
    } finally {
      setBusyFor(company.companyId, false);
    }
  }

  function putBack(company: AudienceCompanyView, on: boolean) {
    startTransition(async () => {
      try {
        const res = await putBackCompanyAction({ campaignId, companyId: company.companyId, on });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(res.message ?? "Done.");
        setPutBackFor(null);
      } catch {
        toast.error(OFFLINE);
      }
    });
  }

  function remove(company: AudienceCompanyView) {
    setBusyFor(company.companyId, true);
    startTransition(async () => {
      try {
        const res = await removeAudienceCompanyAction({ campaignId, companyId: company.companyId });
        if (!res.ok) toast.error(res.error);
        else toast.success(`Removed ${company.name} from this campaign.`);
      } catch {
        toast.error(OFFLINE);
      } finally {
        setBusyFor(company.companyId, false);
      }
    });
  }

  function clearAll() {
    startTransition(async () => {
      try {
        const res = await clearAudienceAction({ campaignId });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(res.message ?? "The audience is empty.");
        setClearOpen(false);
      } catch {
        toast.error(OFFLINE);
      }
    });
  }

  const sectionHref = (section: AudienceSection, extra: { q?: string; page?: number } = {}) =>
    wizardHref(campaignId, "audience", {
      section: section === "excluded" ? "excluded" : null,
      q: extra.q ?? null,
      page: extra.page && extra.page > 1 ? extra.page : null,
    });
  const nobody = nobodyTickedText(totals.nobodyTicked);

  return (
    <div className="flex flex-1 flex-col">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">Who gets the email</h2>
          <p className="mt-1 text-sm" aria-live="polite">
            <span className="font-medium">{audienceSummary(totals)}</span>
            {nobody ? <span className="text-muted-foreground"> · {nobody}</span> : null}
          </p>
          {page.sources.length > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">Added from: {page.sources.map((s) => s.label).join(" · ")}</p>
          ) : null}
        </div>
        {totals.all > 0 ? (
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setClearOpen(true)} disabled={pending}>
            Remove all companies
          </Button>
        ) : null}
      </div>

      {notice ? <NoticeBox notice={notice} /> : null}

      <AddCompanies campaignId={campaignId} options={options} />

      {totals.all === 0 ? (
        <EmptyState
          className="mt-6"
          title="No companies in this campaign yet"
          description="Add companies above by list, status, tag, country or niche. Or go to Contacts, tick the companies you want to email and click Email these companies."
          actions={
            <Button variant="outline" asChild>
              <Link href="/contacts">Go to Contacts</Link>
            </Button>
          }
        />
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-3">
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border">
            <nav aria-label="Sections" className="-mb-px flex gap-1">
              <SectionTab href={sectionHref("included", { q: page.q })} selected={page.section === "included"}>
                Will get the email ({counts.included.toLocaleString("en-US")})
              </SectionTab>
              <SectionTab href={sectionHref("excluded", { q: page.q })} selected={page.section === "excluded"}>
                Excluded ({counts.excluded.toLocaleString("en-US")})
              </SectionTab>
            </nav>
            <AudienceSearch initial={page.q} onSearch={(q) => router.replace(sectionHref(page.section, { q }))} />
          </div>

          {page.section === "excluded" && companies.length > 0 ? (
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              Nobody at these companies can be emailed, for the reason shown. Companies that replied can be put back in by hand.
            </p>
          ) : null}

          {companies.length === 0 ? (
            page.q ? (
              <EmptyState
                title={`No companies here match “${page.q}”`}
                actions={
                  <Button variant="outline" asChild>
                    <Link href={sectionHref(page.section)}>Clear search</Link>
                  </Button>
                }
              />
            ) : page.section === "excluded" ? (
              <EmptyState title="No companies are excluded" description="Everyone in this campaign can be emailed." />
            ) : (
              <EmptyState
                title="Nobody here can be emailed yet"
                description="Every company in this campaign is under Excluded. Open it to see why, or add other companies above."
                actions={
                  <Button variant="outline" asChild>
                    <Link href={sectionHref("excluded")}>See excluded companies</Link>
                  </Button>
                }
              />
            )
          ) : (
            <ul className="grid grid-cols-1 gap-3" aria-label={page.section === "excluded" ? "Excluded companies" : "Companies that will get the email"}>
              {companies.map((c) => (
                <CompanyCard
                  key={c.companyId}
                  company={c}
                  busy={busy.has(c.companyId)}
                  onTick={(personId, ticked) => void tick(c, personId, ticked)}
                  onPutBack={() => setPutBackFor(c)}
                  onTakeOut={() => putBack(c, false)}
                  onRemove={() => remove(c)}
                />
              ))}
            </ul>
          )}

          {page.pageCount > 1 ? (
            <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <p className="tabular text-sm text-muted-foreground">
                Page {page.page} of {page.pageCount} · {plural(page.total, "company", "companies")}
              </p>
              <div className="flex gap-2">
                <PageLink href={page.page > 1 ? sectionHref(page.section, { q: page.q, page: page.page - 1 }) : null} rel="prev">
                  <ChevronLeft aria-hidden /> Previous
                </PageLink>
                <PageLink href={page.page < page.pageCount ? sectionHref(page.section, { q: page.q, page: page.page + 1 }) : null} rel="next">
                  Next <ChevronRight aria-hidden />
                </PageLink>
              </div>
            </nav>
          ) : null}
        </div>
      )}

      {/* The totals stay in view while scrolling through the companies. */}
      <StepFooter campaignId={campaignId} current="audience" note={<span className="tabular">{audienceSummary(totals)}</span>} />

      <AlertDialog
        open={putBackFor !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setPutBackFor(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Put {putBackFor?.name} back in?</AlertDialogTitle>
            <AlertDialogDescription>
              {putBackFor?.name} replied to an earlier email, so it&apos;s left out by default. Put it back only if you&apos;re sure they
              should get this campaign too. The usual person there is ticked, and this is noted in the activity log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Leave it out</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                if (putBackFor) putBack(putBackFor, true);
              }}
            >
              {pending ? "Putting it back…" : "Put back in"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={clearOpen}
        onOpenChange={(open) => {
          if (!pending) setClearOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove all {plural(totals.all, "company", "companies")}?</AlertDialogTitle>
            <AlertDialogDescription>
              The audience starts empty again, and emails you edited for single people in Review are removed too. Your contacts stay as
              they are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep them</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                clearAll();
              }}
            >
              {pending ? "Removing…" : "Remove all"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function NoticeBox({ notice }: { notice: Exclude<AudienceNotice, null> }) {
  const text =
    notice === "list-gone"
      ? "That list doesn't exist any more, so this campaign starts empty. Add companies below."
      : "The list has more than 10,000 companies, so only the first 10,000 (A to Z) were added. A campaign can have up to 10,000.";
  return (
    <div role="status" className="mb-4 flex max-w-3xl gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <p>{text}</p>
    </div>
  );
}

function SectionTab({ href, selected, children }: { href: string; selected: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "relative inline-flex h-10 items-center rounded-t-md px-3 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground",
        selected && "font-medium text-foreground",
      )}
    >
      {children}
      {/* Orange underline = selected. */}
      {selected ? <span aria-hidden className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand" /> : null}
    </Link>
  );
}

function PageLink({ href, rel, children }: { href: string | null; rel: string; children: React.ReactNode }) {
  if (!href) {
    return (
      <Button variant="outline" size="sm" disabled>
        {children}
      </Button>
    );
  }
  return (
    <Button variant="outline" size="sm" asChild>
      <Link href={href} rel={rel}>
        {children}
      </Link>
    </Button>
  );
}

/** Search within the campaign (company, person or address); waits for a pause in typing. */
function AudienceSearch({ initial, onSearch }: { initial: string; onSearch: (q: string) => void }) {
  const id = useId();
  const [value, setValue] = useState(initial);
  const [lastInitial, setLastInitial] = useState(initial);
  // "Clear search" (or Back) changed the search from outside: show it, without fighting the typing.
  if (initial !== lastInitial) {
    setLastInitial(initial);
    if (value.trim() !== initial) setValue(initial);
  }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <div className="relative mb-1.5 w-full sm:w-64">
      <label htmlFor={id} className="sr-only">
        Find a company in this campaign
      </label>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        id={id}
        type="search"
        value={value}
        placeholder="Find a company or person…"
        className="h-8 pl-8"
        maxLength={200}
        onChange={(e) => {
          const next = e.target.value;
          setValue(next);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => onSearch(next.trim()), 400);
        }}
      />
    </div>
  );
}

/** One company with its people and tick boxes (exported for tests). */
export function CompanyCard({
  company: c,
  busy,
  onTick,
  onPutBack,
  onTakeOut,
  onRemove,
}: {
  company: AudienceCompanyView;
  busy: boolean;
  onTick: (personId: number, ticked: boolean) => void;
  onPutBack: () => void;
  onTakeOut: () => void;
  onRemove: () => void;
}) {
  const id = useId();
  const excluded = c.section === "excluded";
  return (
    <li className={cn("min-w-0 rounded-lg border border-border bg-card p-3", excluded && "bg-card/60")} aria-busy={busy || undefined}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link href={`/contacts?company=${c.companyId}`} className="min-w-0 max-w-full truncate font-medium hover:underline">
              {c.name}
            </Link>
            <StatusBadge status={c.status} />
            <span className="text-xs text-muted-foreground">
              {c.code}
              {c.countryName ? ` · ${c.countryName}` : ""}
            </span>
          </div>
          {c.blockedReason ? <p className="mt-1 text-sm text-muted-foreground">{c.blockedReason}</p> : null}
          {c.putBack ? <p className="mt-1 text-sm text-muted-foreground">Put back in by hand, although the company replied.</p> : null}
          {c.emptyReason ? <p className="mt-1 text-sm text-muted-foreground">{c.emptyReason}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {c.canPutBack ? (
            <Button variant="outline" size="sm" onClick={onPutBack} disabled={busy}>
              Put back in
            </Button>
          ) : null}
          {c.putBack ? (
            <Button variant="ghost" size="sm" onClick={onTakeOut} disabled={busy}>
              <Undo2 aria-hidden /> Leave out again
            </Button>
          ) : null}
          <Button variant="ghost" size="icon-sm" aria-label={`Remove ${c.name} from this campaign`} onClick={onRemove} disabled={busy}>
            <X aria-hidden />
          </Button>
        </div>
      </div>

      {c.people.length > 0 ? (
        <ul className="mt-2 grid grid-cols-1 gap-0.5" aria-label={`People at ${c.name}`}>
          {c.people.map((p) => {
            const cid = `${id}-${p.personId}`;
            const disabled = busy || (!p.ticked && !p.canTick);
            return (
              <li key={p.personId} className="flex items-start gap-3 rounded-md px-2 py-1.5 hover:bg-muted/40">
                <Checkbox
                  id={cid}
                  className="mt-0.5"
                  checked={p.ticked}
                  disabled={disabled}
                  aria-describedby={p.reason ? `${cid}-reason` : undefined}
                  onCheckedChange={(v) => onTick(p.personId, v === true)}
                />
                <label htmlFor={cid} className={cn("grid min-w-0 flex-1 grid-cols-1 gap-0.5", disabled ? "cursor-default" : "cursor-pointer")}>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <span className={cn(!p.eligible && "text-muted-foreground")}>{p.name}</span>
                    {p.verificationStatus ? <VerificationBadge status={p.verificationStatus} /> : null}
                    {p.notes.map((n) => (
                      <span key={n} className="text-xs text-muted-foreground">
                        {n}
                      </span>
                    ))}
                    {p.edited ? <span className="text-xs text-muted-foreground">Email edited</span> : null}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">{p.email ?? "No email address"}</span>
                  {p.reason ? (
                    <span id={`${cid}-reason`} className="text-xs text-warning">
                      {p.reason}
                    </span>
                  ) : null}
                </label>
              </li>
            );
          })}
        </ul>
      ) : null}

      {c.warning ? (
        <p className="mt-2 flex items-start gap-2 text-sm text-warning">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {c.warning}
        </p>
      ) : null}
      {!excluded && c.willGet === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">Nobody here gets the email. Tick someone, or remove the company.</p>
      ) : null}
    </li>
  );
}
