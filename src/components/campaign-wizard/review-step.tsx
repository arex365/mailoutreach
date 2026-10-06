"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Loader2, PenLine, RotateCcw, Search, Send, TriangleAlert } from "lucide-react";
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { FormError } from "@/components/forms/field";
import { useNavigationGuard } from "@/components/navigation/nav-guard";
import { EmptyState } from "@/components/page-header";
import { EmailPreview } from "@/components/templates/email-preview";
import { StepEditor } from "@/components/templates/step-editor";
import { TemplateWarningList } from "@/components/templates/warnings";
import type { TemplateVariable } from "@/core/templates/variables";
import { plural } from "@/core/text";
import { cn } from "@/lib/utils";
import {
  editRecipientEmailAction,
  resetRecipientEmailAction,
  reviewDetailAction,
  setCompanyLineAction,
  setIncludedAction,
  setPersonLineAction,
} from "@/app/(app)/campaigns/[id]/setup/actions";
import { sendMeATestAction, testSendInfoAction } from "@/app/(app)/campaigns/[id]/setup/test-send-actions";
import type { ReviewDetail, ReviewEmail, ReviewFilter, ReviewItem, ReviewPage } from "@/server/services/campaigns/draft";
import type { TestSendInfo } from "@/server/services/test-send";
import type { RenderedEmail } from "@/core/templates/types";
import { editedTextProblemSentence, isTypingTarget, moveIndex, textProblemSentence } from "./format";
import { StepFooter } from "./step-footer";
import { wizardHref } from "./steps";
import { StepIntro } from "./wizard-frame";

const OFFLINE = "Couldn't reach the app, so nothing changed. Check your connection and try again.";

const FILTERS: readonly ReviewFilter[] = ["all", "missing", "text", "edited", "excluded"];

const FILTER_LABELS: Record<ReviewFilter, string> = {
  all: "All",
  missing: "Missing details",
  text: "Text problems",
  edited: "Edited",
  excluded: "Excluded",
};

/**
 * Step 5, Review (PLAN.md B6.4): every person who'll get the email, and everyone left out, with
 * filters (All, Missing details, Text problems, Edited, Excluded) and search. Problems in the
 * campaign's text (unknown variables, braces that don't match) are listed at the top, counted
 * apart from missing details. Picking someone shows all their emails exactly as they'll be sent,
 * with warnings; each email can be edited for that person only (or reset), the personal line
 * edited on the company, and the person included or left out.
 * j and k move through the list (not while typing).
 */
export function ReviewStep({
  campaignId,
  page,
  variables,
  initialPersonId,
}: {
  campaignId: number;
  page: ReviewPage;
  variables: TemplateVariable[];
  initialPersonId: number | null;
}) {
  const router = useRouter();
  const queryKey = `${page.filter}|${page.q}|${page.page}`;
  const [selection, setSelection] = useState(() => ({
    key: queryKey,
    personId: initialPersonId ?? page.items[0]?.personId ?? null,
  }));
  // Another filter, search or page: start at its first person. (A refresh after an edit keeps the person.)
  if (selection.key !== queryKey) setSelection({ key: queryKey, personId: page.items[0]?.personId ?? null });
  const selectedId = selection.personId;
  const listRefs = useRef(new Map<number, HTMLButtonElement>());
  const detailRef = useRef<HTMLDivElement>(null);

  function select(personId: number, opts: { scroll?: boolean } = {}) {
    setSelection((s) => ({ ...s, personId }));
    if (opts.scroll) listRefs.current.get(personId)?.scrollIntoView({ block: "nearest" });
  }

  // j / k: next / previous person (never while typing or with a dialog open).
  const itemsRef = useRef(page.items);
  const selectedRef = useRef(selectedId);
  useEffect(() => {
    itemsRef.current = page.items;
    selectedRef.current = selectedId;
  });
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== "j" && e.key !== "k") return;
      if (isTypingTarget(e.target)) return;
      if (document.querySelector('[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"]')) return;
      const items = itemsRef.current;
      const current = items.findIndex((i) => i.personId === selectedRef.current);
      const next = moveIndex(current, e.key === "j" ? 1 : -1, items.length);
      const item = items[next];
      if (!item) return;
      e.preventDefault();
      setSelection((s) => ({ ...s, personId: item.personId }));
      listRefs.current.get(item.personId)?.scrollIntoView({ block: "nearest" });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const href = (filter: ReviewFilter, extra: { q?: string; page?: number } = {}) =>
    wizardHref(campaignId, "review", {
      filter: filter === "all" ? null : filter,
      q: extra.q || null,
      page: extra.page && extra.page > 1 ? extra.page : null,
    });

  return (
    <div className="flex flex-1 flex-col">
      <StepIntro title="Review every email">
        {plural(page.counts.all, "person gets", "people get")} this campaign
        {page.steps.length > 1 ? `: the first email and ${plural(page.steps.length - 1, "follow-up", "follow-ups")} each` : ""}.
        {page.missingEmails > 0
          ? ` ${page.missingEmails === 1 ? "1 email has" : `${page.missingEmails.toLocaleString("en-US")} emails have`} missing details.`
          : " No email is missing details."}{" "}
        Press j and k to move through the list.
      </StepIntro>

      {page.renderError ? (
        <div role="alert" className="mb-4 flex max-w-3xl gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>{page.renderError}</p>
        </div>
      ) : null}

      <TextProblems
        campaignId={campaignId}
        page={page}
        showEditedHref={page.filter === "text" ? null : href("text")}
      />

      {/* grid-cols-1 (minmax(0, 1fr)) on a phone, not the implicit auto column, here and in the grids below: a long
          email address or company name ends in "…" instead of making the page wider than the screen. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="grid min-w-0 grid-cols-1 content-start gap-3">
          <nav aria-label="Filters" className="-mb-px flex flex-wrap gap-1 border-b border-border">
            {FILTERS.filter((f) => f !== "text" || page.counts.text > 0 || page.filter === "text").map((f) => (
              <FilterTab key={f} href={href(f, { q: page.q })} selected={page.filter === f}>
                {FILTER_LABELS[f]} ({page.counts[f].toLocaleString("en-US")})
              </FilterTab>
            ))}
          </nav>
          <ReviewSearch initial={page.q} onSearch={(q) => router.replace(href(page.filter, { q }))} />

          {page.items.length === 0 ? (
            <ReviewEmpty campaignId={campaignId} filter={page.filter} q={page.q} clearHref={href(page.filter)} />
          ) : (
            <ul aria-label="People" className="grid max-h-[60dvh] grid-cols-1 gap-1 overflow-y-auto pr-1 lg:max-h-[calc(100dvh-22rem)]">
              {page.items.map((item) => (
                <li key={item.personId} className="min-w-0">
                  <ReviewListItem
                    item={item}
                    selected={item.personId === selectedId}
                    buttonRef={(el) => {
                      if (el) listRefs.current.set(item.personId, el);
                      else listRefs.current.delete(item.personId);
                    }}
                    onSelect={() => {
                      select(item.personId);
                      // On a phone the details sit below the list.
                      if (window.matchMedia("(max-width: 1023px)").matches) detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                  />
                </li>
              ))}
            </ul>
          )}

          {page.pageCount > 1 ? (
            <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-2">
              <p className="tabular text-xs text-muted-foreground">
                Page {page.page} of {page.pageCount} · {plural(page.total, "person", "people")}
              </p>
              <div className="flex gap-2">
                <PageButton href={page.page > 1 ? href(page.filter, { q: page.q, page: page.page - 1 }) : null} label="Previous page">
                  <ChevronLeft aria-hidden />
                </PageButton>
                <PageButton href={page.page < page.pageCount ? href(page.filter, { q: page.q, page: page.page + 1 }) : null} label="Next page">
                  <ChevronRight aria-hidden />
                </PageButton>
              </div>
            </nav>
          ) : null}
        </div>

        <div ref={detailRef} className="min-w-0 scroll-mt-20">
          {selectedId ? (
            <ReviewPerson key={selectedId} campaignId={campaignId} personId={selectedId} variables={variables} version={page} />
          ) : (
            <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
              Pick someone on the left to read their emails.
            </p>
          )}
        </div>
      </div>

      <StepFooter campaignId={campaignId} current="review" />
    </div>
  );
}

/**
 * Unknown variables and braces that don't match (PLAN.md B6.3: shown and counted, never blocking):
 * once per step of the campaign's text, plus the emails edited for single people that have their own.
 */
export function TextProblems({
  campaignId,
  page,
  showEditedHref,
}: {
  campaignId: number;
  page: Pick<ReviewPage, "textProblems" | "editedTextProblems">;
  /** Link to the "Text problems" filter (null when it's already showing). */
  showEditedHref: string | null;
}) {
  const edited = editedTextProblemSentence(page.editedTextProblems);
  if (page.textProblems.length === 0 && !edited) return null;
  return (
    <div role="status" className="mb-4 grid max-w-3xl gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
      <p className="flex items-start gap-2 font-medium text-warning">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        Some text won&apos;t come out as intended
      </p>
      <ul className="grid gap-1 pl-6">
        {page.textProblems.map((p) => (
          <li key={p.step}>
            {textProblemSentence(p)}{" "}
            <Link href={wizardHref(campaignId, "message")} className="underline underline-offset-3">
              Fix it in the Message step
            </Link>
          </li>
        ))}
        {edited ? (
          <li>
            {edited}
            {showEditedHref ? (
              <>
                {" "}
                <Link href={showEditedHref} className="underline underline-offset-3">
                  Show {page.editedTextProblems === 1 ? "it" : "them"}
                </Link>
              </>
            ) : null}
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function FilterTab({ href, selected, children }: { href: string; selected: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "relative inline-flex h-9 items-center rounded-t-md px-2.5 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground",
        selected && "font-medium text-foreground",
      )}
    >
      {children}
      {selected ? <span aria-hidden className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand" /> : null}
    </Link>
  );
}

function PageButton({ href, label, children }: { href: string | null; label: string; children: React.ReactNode }) {
  if (!href) {
    return (
      <Button variant="outline" size="icon-sm" disabled aria-label={label}>
        {children}
      </Button>
    );
  }
  return (
    <Button variant="outline" size="icon-sm" asChild>
      <Link href={href} aria-label={label}>
        {children}
      </Link>
    </Button>
  );
}

function ReviewSearch({ initial, onSearch }: { initial: string; onSearch: (q: string) => void }) {
  const id = useId();
  const [value, setValue] = useState(initial);
  const [lastInitial, setLastInitial] = useState(initial);
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
    <div className="relative">
      <label htmlFor={id} className="sr-only">
        Find a person
      </label>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        id={id}
        type="search"
        value={value}
        placeholder="Find a name, email or company…"
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

function ReviewEmpty({ campaignId, filter, q, clearHref }: { campaignId: number; filter: ReviewFilter; q: string; clearHref: string }) {
  if (q) {
    return (
      <EmptyState
        title={`Nobody here matches “${q}”`}
        actions={
          <Button variant="outline" asChild>
            <Link href={clearHref}>Clear search</Link>
          </Button>
        }
      />
    );
  }
  if (filter === "missing") {
    return (
      <EmptyState
        title="No emails are missing details. You can go on to Schedule."
        actions={
          <Button variant="outline" asChild>
            <Link href={wizardHref(campaignId, "schedule")}>Go to Schedule</Link>
          </Button>
        }
      />
    );
  }
  if (filter === "text") {
    return (
      <EmptyState
        title="No edited emails have text problems"
        description="Every email edited for one person uses variables we know, and its braces match."
        actions={
          <Button variant="outline" asChild>
            <Link href={wizardHref(campaignId, "review")}>Show everyone</Link>
          </Button>
        }
      />
    );
  }
  if (filter === "edited") {
    return <EmptyState title="No emails edited for single people" description="Pick someone and choose Edit this person's email to change just theirs." />;
  }
  if (filter === "excluded") {
    return <EmptyState title="Nobody is left out" description="Everyone at the companies in this campaign gets the email." />;
  }
  return (
    <EmptyState
      title="Nobody will get the email yet"
      description="Tick the people who should get it in the Audience step."
      actions={
        <Button variant="outline" asChild>
          <Link href={wizardHref(campaignId, "audience")}>Go to Audience</Link>
        </Button>
      }
    />
  );
}

function ReviewListItem({
  item,
  selected,
  buttonRef,
  onSelect,
}: {
  item: ReviewItem;
  selected: boolean;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onSelect: () => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        "relative grid w-full min-w-0 grid-cols-1 gap-0.5 rounded-md py-2 pr-2 pl-3 text-left transition-colors hover:bg-muted/50",
        selected && "bg-muted",
      )}
    >
      {/* Orange bar = selected. */}
      {selected ? <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-brand" /> : null}
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium">{item.name}</span>
        {item.missing > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-warning">
            <TriangleAlert className="size-3" aria-hidden />
            {item.missing === 1 ? "Missing details" : `${item.missing} emails missing details`}
          </span>
        ) : null}
        {item.textProblems > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-warning">
            <TriangleAlert className="size-3" aria-hidden />
            Check the text
          </span>
        ) : null}
        {item.edited ? <span className="shrink-0 text-xs text-muted-foreground">Edited</span> : null}
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {item.companyName} · {item.email}
      </span>
      {item.reason ? <span className="truncate text-xs text-warning">{item.reason}</span> : null}
    </button>
  );
}

/** One person: include/leave out, personal line, "Send me a test", and every email as it will be sent. */
function ReviewPerson({
  campaignId,
  personId,
  variables,
  version,
}: {
  campaignId: number;
  personId: number;
  variables: TemplateVariable[];
  /** A fresh server page (after an edit elsewhere) reloads the details too. */
  version: unknown;
}) {
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<ReviewEmail | null>(null);
  const [lineOpen, setLineOpen] = useState(false);
  const [busy, startBusy] = useTransition();

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await reviewDetailAction({ campaignId, personId });
        if (cancelled) return;
        if (res.ok) {
          setDetail(res.data);
          setError(null);
        } else {
          setError(res.error);
        }
      } catch {
        if (!cancelled) setError("Couldn't reach the app to load this person's emails. Check your connection, then pick them again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [campaignId, personId, reload, version]);

  function setIncluded(on: boolean) {
    startBusy(async () => {
      try {
        const res = await setIncludedAction({ campaignId, personId, included: on });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        setDetail(res.data);
        toast.success(res.message ?? (on ? "Included." : "Left out."));
      } catch {
        toast.error(OFFLINE);
      }
    });
  }

  function reset(email: ReviewEmail) {
    if (!detail?.recipientId) return;
    const recipientId = detail.recipientId;
    startBusy(async () => {
      try {
        const res = await resetRecipientEmailAction({ campaignId, recipientId, step: email.step });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(res.message ?? "Back to the campaign's text.");
        setReload((n) => n + 1);
      } catch {
        toast.error(OFFLINE);
      }
    });
  }

  if (!detail) {
    return (
      <div className="grid gap-3 rounded-lg border border-border bg-card p-4" aria-busy={loading || undefined}>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : (
          <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Loading their emails…
          </p>
        )}
      </div>
    );
  }

  return (
    <ReviewPersonView
      campaignId={campaignId}
      detail={detail}
      busy={busy}
      loading={loading}
      onSetIncluded={setIncluded}
      onEditLine={() => setLineOpen(true)}
      onEdit={setEditing}
      onReset={reset}
    >
      {editing && detail.recipientId ? (
        <EditEmailDialog
          key={`${detail.recipientId}-${editing.step}`}
          campaignId={campaignId}
          recipientId={detail.recipientId}
          personName={detail.name}
          email={editing}
          variables={variables}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setReload((n) => n + 1);
          }}
        />
      ) : null}
      <PersonalLineDialog
        open={lineOpen}
        onOpenChange={setLineOpen}
        campaignId={campaignId}
        detail={detail}
        onSaved={() => {
          setLineOpen(false);
          setReload((n) => n + 1);
        }}
      />
    </ReviewPersonView>
  );
}

/**
 * One loaded person (what ReviewPerson shows once their emails are in): the inclusion card with Edit personal line and
 * Send me a test, then every email as it will be sent. `children` are the dialogs.
 */
export function ReviewPersonView({
  campaignId,
  detail,
  busy,
  loading,
  onSetIncluded,
  onEditLine,
  onEdit,
  onReset,
  children,
}: {
  campaignId: number;
  detail: ReviewDetail;
  busy: boolean;
  loading: boolean;
  onSetIncluded: (on: boolean) => void;
  onEditLine: () => void;
  onEdit: (email: ReviewEmail) => void;
  onReset: (email: ReviewEmail) => void;
  children?: React.ReactNode;
}) {
  return (
    // grid-cols-1 and min-w-0: the name and "email · company" line truncate inside the card on a phone (an auto column
    // took their full width and pushed every card past the screen's edge).
    <section aria-label={`Emails for ${detail.name}`} className="grid grid-cols-1 gap-4" aria-busy={loading || busy || undefined}>
      <div className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border border-border bg-card p-4">
        <PersonInclusion campaignId={campaignId} detail={detail} busy={busy} onSetIncluded={onSetIncluded} />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onEditLine} disabled={busy}>
            <PenLine aria-hidden /> Edit personal line
          </Button>
          <SendMeATestButton campaignId={campaignId} recipientId={detail.recipientId} emails={detail.emails} disabled={busy} />
        </div>
      </div>

      {detail.renderError ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {detail.renderError}
        </p>
      ) : null}

      {detail.recipientId === null ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          {detail.canInclude ? "Include this person to see their emails." : "This person can't get this campaign, so there are no emails to show."}
        </p>
      ) : (
        detail.emails.map((e) => (
          <article key={e.step} aria-label={e.title} className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border border-border bg-card p-4">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h4 className="text-sm font-medium">
                  {e.title}
                  {e.edited ? <span className="ml-2 text-xs font-normal text-muted-foreground">Edited for this person{e.editedBy ? ` by ${e.editedBy}` : ""}</span> : null}
                </h4>
                {e.step > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {plural(e.delayDays, "day", "days")} after the previous email, if there&apos;s no reply
                  </p>
                ) : null}
              </div>
              {detail.willGet ? (
                <div className="flex flex-wrap gap-1">
                  {e.edited ? (
                    <Button variant="ghost" size="sm" onClick={() => onReset(e)} disabled={busy}>
                      <RotateCcw aria-hidden /> Reset to campaign text
                    </Button>
                  ) : null}
                  <Button variant="outline" size="sm" onClick={() => onEdit(e)} disabled={busy}>
                    <PenLine aria-hidden /> Edit this person&apos;s email
                  </Button>
                </div>
              ) : null}
            </div>
            <EmailPreview email={e.email} />
            <TemplateWarningList
              warnings={e.email.warnings.filter((w) => w.kind !== "missing")}
              title="Check the text"
            />
          </article>
        ))
      )}

      {children}
    </section>
  );
}

/**
 * Who they are, and whether they get the campaign. The switch only shows what really happens:
 * someone ticked who can't be emailed any more gets the reason and an Untick button instead of
 * a switch that looks on. When the company's reply is the only thing in the way, it says where to
 * put the company back in.
 */
export function PersonInclusion({
  campaignId,
  detail,
  busy,
  onSetIncluded,
}: {
  campaignId: number;
  detail: Pick<
    ReviewDetail,
    "personId" | "name" | "email" | "companyId" | "companyName" | "willGet" | "ticked" | "canInclude" | "reason" | "companyCanPutBack"
  >;
  busy: boolean;
  onSetIncluded: (on: boolean) => void;
}) {
  const includeId = `review-include-${detail.personId}`;
  const reasonId = detail.reason ? `${includeId}-reason` : undefined;
  const tickedButBlocked = detail.ticked && !detail.willGet;
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-full">
          <h3 className="truncate text-base font-semibold">{detail.name}</h3>
          <p className="truncate text-sm text-muted-foreground" title={[detail.email, detail.companyName].filter(Boolean).join(" · ")}>
            {detail.email} ·{" "}
            <Link href={`/contacts?company=${detail.companyId}`} className="underline-offset-3 hover:text-foreground hover:underline">
              {detail.companyName}
            </Link>
          </p>
        </div>
        {tickedButBlocked ? (
          <div className="flex items-center gap-2">
            <span className="text-sm">Ticked, but left out</span>
            <Button variant="outline" size="sm" onClick={() => onSetIncluded(false)} disabled={busy} aria-describedby={reasonId}>
              Untick
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Switch
              id={includeId}
              checked={detail.willGet}
              disabled={busy || !(detail.willGet || detail.canInclude)}
              onCheckedChange={(on) => onSetIncluded(on)}
              aria-describedby={reasonId}
              className="data-checked:bg-foreground"
            />
            <Label htmlFor={includeId} className="font-normal">
              {detail.willGet ? "Gets this campaign" : "Left out"}
            </Label>
          </div>
        )}
      </div>
      {detail.reason ? (
        <p id={reasonId} className="flex items-start gap-2 text-sm text-warning">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            {detail.reason.replace(/[.!?]\s*$/, "")}
            {detail.canInclude && !detail.ticked ? ". Switch it on to include them." : "."}
            {detail.companyCanPutBack ? (
              <>
                {" "}
                <Link
                  href={wizardHref(campaignId, "audience", { section: "excluded", q: detail.companyName })}
                  className="underline underline-offset-3"
                >
                  Put the company back in on the Audience step
                </Link>{" "}
                to include them.
              </>
            ) : null}
          </span>
        </p>
      ) : null}
    </>
  );
}

function EditEmailDialog({
  campaignId,
  recipientId,
  personName,
  email,
  variables,
  onClose,
  onSaved,
}: {
  campaignId: number;
  recipientId: number;
  personName: string;
  email: ReviewEmail;
  variables: TemplateVariable[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState({ subject: email.source.subject ?? "", body: email.source.body });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [question, setQuestion] = useState<DiscardQuestion | null>(null);
  const questionRef = useRef<DiscardQuestion | null>(null);
  const dirty = editChanged(email, value);

  function ask(next: DiscardQuestion | null) {
    questionRef.current?.keep(); // a newer question replaces an unanswered one
    questionRef.current = next;
    setQuestion(next);
  }

  function answer(discardChanges: boolean) {
    const current = questionRef.current;
    questionRef.current = null;
    setQuestion(null);
    if (discardChanges) current?.discard();
    else current?.keep();
  }

  // Leaving the page with typed text (a link, the search menu, the bell, Back) asks first too,
  // the same as the campaign page's "Edit this email".
  useNavigationGuard({
    active: dirty,
    protectBack: true,
    onLeave: (request) => ask({ leaving: true, discard: request.proceed, keep: request.cancel }),
  });

  // Esc, a click outside, the close button and Cancel all come here: typed text is never thrown away without asking.
  function requestClose() {
    if (pending) return;
    if (dirty) {
      ask({ leaving: false, discard: onClose, keep: () => undefined });
      return;
    }
    onClose();
  }

  function save() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await editRecipientEmailAction({
          campaignId,
          recipientId,
          step: email.step,
          subject: email.step === 0 ? value.subject : null,
          body: value.body,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        toast.success(res.message ?? "Saved for this person.");
        onSaved();
      } catch {
        setError(OFFLINE);
      }
    });
  }

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) requestClose();
        }}
      >
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Edit {email.title.toLowerCase()} for {personName}
            </DialogTitle>
            <DialogDescription>
              Only {personName} gets this version. Variables still work, and the preview in Review shows the result.
            </DialogDescription>
          </DialogHeader>
          <FormError message={error} />
          <StepEditor
            id={`review-edit-${recipientId}-${email.step}`}
            value={email.step === 0 ? value : { body: value.body }}
            onChange={(v) => setValue({ subject: v.subject ?? value.subject, body: v.body })}
            variables={variables}
            showSubject={email.step === 0}
            bodyLabel={email.title}
            showCheatSheet={false}
            disabled={pending}
          />
          <DialogFooter>
            <Button variant="outline" onClick={requestClose} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save for this person"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={question !== null}
        onOpenChange={(open) => {
          if (!open) answer(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your changes?</AlertDialogTitle>
            <AlertDialogDescription>
              You changed {personName}&apos;s {email.title.toLowerCase()} but didn&apos;t save it. If you{" "}
              {question?.leaving ? "leave this page" : "close"} now, those changes are lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => answer(true)}>
              {question?.leaving ? "Discard and leave" : "Discard changes"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * "Send me a test" (M3-DESIGN §4.5.5, §5.8): sends this person's email to your own reply inbox, or in dry run shows it
 * as it would arrive. The dialog loads its facts itself when it opens (where the test goes, tests left today, anything
 * in the way), so Review needs nothing new from the page.
 */
function SendMeATestButton({
  campaignId,
  recipientId,
  emails,
  disabled,
}: {
  campaignId: number;
  recipientId: number | null;
  emails: ReviewEmail[];
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<TestSendInfo | null>(null);
  const [step, setStep] = useState<number>(emails[0]?.step ?? 0);
  const [preview, setPreview] = useState<RenderedEmail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const [sending, startSending] = useTransition();
  const stepId = useId();

  function openDialog() {
    setOpen(true);
    setInfo(null);
    setPreview(null);
    setError(null);
    setStep(emails[0]?.step ?? 0);
    startLoading(async () => {
      try {
        const res = await testSendInfoAction({ campaignId });
        if (!res.ok) setError(res.error);
        else setInfo(res.data);
      } catch {
        setError(OFFLINE);
      }
    });
  }

  function send() {
    if (!recipientId) return;
    setError(null);
    startSending(async () => {
      try {
        const res = await sendMeATestAction({ campaignId, recipientId, step });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        if (res.data.status === "preview") {
          setPreview(res.data.preview);
          return;
        }
        toast.success(res.message ?? "Test sent.");
        setOpen(false);
        // The counter in the dialog is stale now; it reloads on the next open.
        setInfo(null);
      } catch {
        setError(OFFLINE);
      }
    });
  }

  const dryRun = info?.mode === "DRY_RUN";
  const blocked = Boolean(info?.blocker) && !dryRun;
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={openDialog}
        disabled={disabled || recipientId === null || emails.length === 0}
        title={recipientId === null ? "Include this person first." : undefined}
      >
        <Send className="size-3.5" aria-hidden /> Send me a test
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Send me a test</DialogTitle>
            <DialogDescription>
              {!info
                ? "Checking where the test would go…"
                : dryRun
                  ? "In dry run nothing leaves this PC, so here is the email as it would arrive. To get it in your inbox, set sending to Test mode or Live in Settings › Sending & Mailgun."
                  : `Sends this person's email to ${info.ownMailbox ? "your inbox for test emails" : "your reply inbox"} (${info.inbox ?? "not set"}). Tests count toward today's limit. ${info.testsLeft} of ${info.perDay} tests left today.`}
            </DialogDescription>
          </DialogHeader>
          {loading ? (
            <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
            </p>
          ) : null}
          {blocked ? (
            <p role="status" className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              {info?.blocker}
            </p>
          ) : null}
          {info && emails.length > 1 ? (
            <fieldset className="grid gap-1.5">
              <legend className="mb-1 text-sm font-medium">Which email?</legend>
              <div className="flex flex-wrap gap-4">
                {emails.map((e) => (
                  <label key={e.step} htmlFor={`${stepId}-${e.step}`} className="flex items-center gap-1.5 text-sm">
                    <input
                      id={`${stepId}-${e.step}`}
                      type="radio"
                      name={`${stepId}-step`}
                      value={e.step}
                      checked={step === e.step}
                      onChange={() => {
                        setStep(e.step);
                        setPreview(null);
                      }}
                      className="size-4 accent-foreground"
                    />
                    {e.title}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <FormError message={error} />
          {preview ? <EmailPreview email={preview} /> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={sending}>
              {preview ? "Close" : "Cancel"}
            </Button>
            <Button onClick={send} disabled={!info || sending || blocked || recipientId === null}>
              {sending ? (dryRun ? "Loading…" : "Sending…") : dryRun ? "Show the email" : "Send test"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** "Discard your changes?": closing the editor, or leaving the page, while the text isn't saved. */
type DiscardQuestion = { leaving: boolean; discard: () => void; keep: () => void };

/** True when the text in "Edit this person's email" differs from what the dialog opened with. */
export function editChanged(email: Pick<ReviewEmail, "step" | "source">, value: { subject: string; body: string }): boolean {
  if (value.body !== email.source.body) return true;
  return email.step === 0 && value.subject !== (email.source.subject ?? "");
}

const LINE_MAX = 300;

function PersonalLineDialog({
  open,
  onOpenChange,
  campaignId,
  detail,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaignId: number;
  detail: ReviewDetail;
  onSaved: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">{open ? <PersonalLineForm campaignId={campaignId} detail={detail} onSaved={onSaved} onCancel={() => onOpenChange(false)} /> : null}</DialogContent>
    </Dialog>
  );
}

function PersonalLineForm({
  campaignId,
  detail,
  onSaved,
  onCancel,
}: {
  campaignId: number;
  detail: ReviewDetail;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [companyLine, setCompanyLine] = useState(detail.personalLine ?? "");
  const [ownLine, setOwnLine] = useState(detail.personalLineOverride ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const hasOwn = detail.personalLineOverride !== null;

  function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const messages: string[] = [];
        if (companyLine.trim() !== (detail.personalLine ?? "").trim()) {
          const res = await setCompanyLineAction({ campaignId, companyId: detail.companyId, value: companyLine });
          if (!res.ok) {
            setError(res.error);
            return;
          }
          if (res.message) messages.push(res.message);
        }
        if (hasOwn && ownLine.trim() !== (detail.personalLineOverride ?? "").trim()) {
          const res = await setPersonLineAction({ campaignId, personId: detail.personId, value: ownLine });
          if (!res.ok) {
            setError(res.error);
            return;
          }
          if (res.message) messages.push(res.message);
        }
        toast.success(messages.join(" ") || "Nothing changed.");
        onSaved();
      } catch {
        setError(OFFLINE);
      }
    });
  }

  return (
    <form onSubmit={save} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Personal line for {detail.companyName}</DialogTitle>
        <DialogDescription>
          Saved on the company, so {"{{personal_line}}"} uses it in this campaign and every later one. Keep it to one genuine sentence.
        </DialogDescription>
      </DialogHeader>
      <FormError message={error} />
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-company`}>Company&apos;s personal line</Label>
        <Textarea
          id={`${id}-company`}
          value={companyLine}
          rows={3}
          maxLength={LINE_MAX + 200}
          onChange={(e) => setCompanyLine(e.target.value)}
          disabled={pending}
          placeholder="For example: Your dragon bust range shows a real eye for sculpted detail."
        />
        <p className={cn("text-xs", companyLine.trim().length > LINE_MAX ? "text-destructive" : "text-muted-foreground")}>
          {companyLine.trim().length} of {LINE_MAX} characters. Leave it empty to remove it.
        </p>
      </div>
      {hasOwn ? (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-own`}>{detail.name}&apos;s own line (used instead of the company&apos;s)</Label>
          <Textarea id={`${id}-own`} value={ownLine} rows={3} maxLength={LINE_MAX + 200} onChange={(e) => setOwnLine(e.target.value)} disabled={pending} />
          <p className="text-xs text-muted-foreground">Leave it empty so {detail.name} gets the company&apos;s line.</p>
        </div>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}
