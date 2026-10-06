"use client";

import { useRef, useState, useTransition, type ReactElement } from "react";
import {
  BadgeCheck,
  Bot,
  Building2,
  CheckCheck,
  CircleDot,
  CirclePause,
  CirclePlay,
  CircleSlash,
  FilePen,
  Flag,
  History,
  Link as LinkIcon,
  List,
  Mail,
  MailCheck,
  MailMinus,
  MailWarning,
  MailX,
  MessageCircleQuestionMark,
  PenLine,
  Quote,
  RefreshCw,
  Reply,
  RotateCcw,
  Send,
  ShieldAlert,
  SkipForward,
  StickyNote,
  Tags,
  Trash2,
  Undo2,
  Unlink,
  Upload,
  UserMinus,
  UserPen,
  UserPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FlagBadge } from "@/components/badges";
import { cn } from "@/lib/utils";
import { loadTimelineAction } from "./actions";
import { PanelSection } from "./panel-ui";
import {
  TIMELINE_FILTERS,
  TIMELINE_FILTER_LABELS,
  timelineEmptyText,
  type TimelineFilter,
  type TimelineItemView,
  type TimelinePageView,
} from "./timeline-view";

const ICON_CLASS = "size-3.5";

/**
 * One icon per activity type (decorative: the summary says what happened). Milestone 4 adds the reply decisions and
 * the outage hold (M4-DESIGN §3.11, §6 row 12). `followups.*` entries carry no company, so today they appear only on
 * the Activity page; their icons are here for any timeline that lists them.
 */
const ICONS: Record<string, ReactElement> = {
  "email.sent": <Send className={ICON_CLASS} />,
  "email.delivered": <MailCheck className={ICON_CLASS} />,
  "email.bounced": <MailX className={ICON_CLASS} />,
  "email.complained": <ShieldAlert className={ICON_CLASS} />,
  "email.unsubscribed": <MailMinus className={ICON_CLASS} />,
  "email.skipped": <SkipForward className={ICON_CLASS} />,
  "email.failed": <MailWarning className={ICON_CLASS} />,
  "campaign.recipientSkipped": <SkipForward className={ICON_CLASS} />,
  "campaign.emailRetried": <RefreshCw className={ICON_CLASS} />,
  "campaign.emailEdited": <FilePen className={ICON_CLASS} />,
  "campaign.putBack": <Undo2 className={ICON_CLASS} />,
  "reply.received": <Reply className={ICON_CLASS} />,
  "reply.auto": <Bot className={ICON_CLASS} />,
  "reply.possible": <MessageCircleQuestionMark className={ICON_CLASS} />,
  "reply.bounce": <MailX className={ICON_CLASS} />,
  "reply.unlinked": <Unlink className={ICON_CLASS} />,
  "reply.confirmed": <BadgeCheck className={ICON_CLASS} />,
  "reply.linked": <LinkIcon className={ICON_CLASS} />,
  "reply.answered": <CheckCheck className={ICON_CLASS} />,
  "reply.notNeeded": <CircleSlash className={ICON_CLASS} />,
  "reply.reopened": <RotateCcw className={ICON_CLASS} />,
  "followups.held": <CirclePause className={ICON_CLASS} />,
  "followups.released": <CirclePlay className={ICON_CLASS} />,
  "company.created": <Building2 className={ICON_CLASS} />,
  "company.updated": <PenLine className={ICON_CLASS} />,
  "company.status": <CircleDot className={ICON_CLASS} />,
  "company.priority": <Flag className={ICON_CLASS} />,
  "company.notes": <StickyNote className={ICON_CLASS} />,
  "company.personalLine": <Quote className={ICON_CLASS} />,
  "company.deleted": <Trash2 className={ICON_CLASS} />,
  "company.restored": <RotateCcw className={ICON_CLASS} />,
  "company.lists": <List className={ICON_CLASS} />,
  "company.tags": <Tags className={ICON_CLASS} />,
  "person.created": <UserPlus className={ICON_CLASS} />,
  "person.updated": <UserPen className={ICON_CLASS} />,
  "person.deleted": <UserMinus className={ICON_CLASS} />,
  "person.unsubscribed": <MailMinus className={ICON_CLASS} />,
  "import.done": <Upload className={ICON_CLASS} />,
};

const FALLBACK_ICONS: Record<TimelineItemView["category"], ReactElement> = {
  email: <Mail className={ICON_CLASS} />,
  reply: <Reply className={ICON_CLASS} />,
  change: <History className={ICON_CLASS} />,
};

function iconFor(item: TimelineItemView): ReactElement {
  return ICONS[item.type] ?? FALLBACK_ICONS[item.category];
}

/** The activity types that have their own icon (the rest fall back to their category's): for tests and reviews. */
export const TIMELINE_ICON_TYPES: readonly string[] = Object.keys(ICONS);

const OFFLINE = "Couldn't load the timeline. Check your connection and try again.";

function TimelineItem({ item }: { item: TimelineItemView }) {
  return (
    <li className="flex gap-3 py-2">
      <span
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground"
        aria-hidden
      >
        {iconFor(item)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm break-words">
          {item.summary}
          {item.modeLabel ? (
            <>
              {" "}
              <FlagBadge>{item.modeLabel}</FlagBadge>
            </>
          ) : null}
        </p>
        {item.detail ? (
          <p className="mt-0.5 line-clamp-3 text-sm break-words whitespace-pre-wrap text-muted-foreground">{item.detail}</p>
        ) : null}
        <p className="mt-0.5 text-xs text-muted-foreground">
          {item.actor} ·{" "}
          <time dateTime={item.iso} title={item.exact}>
            {item.ago}
          </time>
          <span className="sr-only"> ({item.exact})</span>
        </p>
      </div>
    </li>
  );
}

/**
 * Everything that happened to this company and its people, newest first, 30 at a time.
 * `initial` is the server's first page for "All"; it's replaced whenever the panel refreshes.
 */
export function TimelineSection({ companyId, initial }: { companyId: number; initial: TimelinePageView }) {
  // Filter and rows live together, so a late answer for another filter can never land here.
  const [view, setView] = useState<{ filter: TimelineFilter; page: TimelinePageView }>({ filter: "all", page: initial });
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [seenInitial, setSeenInitial] = useState(initial);
  const request = useRef(0);
  const { filter, page } = view;

  // A change in the panel re-renders the server part: go back to "All" and show the fresh
  // first page, so the change that was just made is visible at the top.
  if (initial !== seenInitial) {
    setSeenInitial(initial);
    setView({ filter: "all", page: initial });
    setReplacing(false);
    setError(null);
  }

  function load(nextFilter: TimelineFilter, cursor: string | null) {
    const my = ++request.current;
    const replace = cursor === null;
    setError(null);
    if (replace) setReplacing(true);
    startTransition(async () => {
      let res: Awaited<ReturnType<typeof loadTimelineAction>> | null = null;
      try {
        res = await loadTimelineAction({ companyId, filter: nextFilter, cursor });
      } catch {
        res = null;
      }
      if (my !== request.current) return;
      setReplacing(false);
      if (!res || !res.ok) {
        setError(res && !res.ok ? res.error : OFFLINE);
        return;
      }
      const data = res.data;
      setView((v) => {
        if (v.filter !== nextFilter) return v;
        return {
          filter: v.filter,
          page: replace ? data : { items: [...v.page.items, ...data.items], nextCursor: data.nextCursor },
        };
      });
    });
  }

  function choose(next: TimelineFilter) {
    if (next === filter) return;
    request.current++;
    setError(null);
    if (next === "all") {
      setReplacing(false);
      setView({ filter: "all", page: initial });
      return;
    }
    setView({ filter: next, page: { items: [], nextCursor: null } });
    load(next, null);
  }

  const showSkeleton = replacing;

  return (
    <PanelSection title="Timeline" id="company-panel-timeline">
      <div role="group" aria-label="Show in the timeline" className="flex flex-wrap gap-1 border-b border-border">
        {TIMELINE_FILTERS.map((f) => {
          const active = f === filter;
          return (
            <button
              key={f}
              type="button"
              aria-pressed={active}
              onClick={() => choose(f)}
              className={cn(
                "-mb-px border-b-2 px-2.5 py-1.5 text-sm transition-colors",
                active ? "border-brand font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {TIMELINE_FILTER_LABELS[f]}
            </button>
          );
        })}
      </div>

      {error ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          {error}
          <Button type="button" size="xs" variant="outline" onClick={() => load(filter, null)}>
            Try again
          </Button>
        </div>
      ) : null}

      {showSkeleton ? (
        <div className="grid gap-3 py-2" aria-busy="true" aria-label="Loading the timeline">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="size-7 rounded-full" />
              <div className="grid flex-1 gap-1.5">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      ) : page.items.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{timelineEmptyText(filter)}</p>
      ) : (
        <>
          <ol className="grid divide-y divide-border/60">
            {page.items.map((item) => (
              <TimelineItem key={item.id} item={item} />
            ))}
          </ol>
          {page.nextCursor ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="justify-self-start"
              disabled={pending}
              onClick={() => load(filter, page.nextCursor)}
            >
              {pending ? "Loading…" : "Show more"}
            </Button>
          ) : null}
        </>
      )}
    </PanelSection>
  );
}
